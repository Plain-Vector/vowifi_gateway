import base64
from contextlib import closing
import gc
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from jinja2 import Environment, FileSystemLoader
import pytest

from app import auth, blocking as b, store
from app.main import app, hub
from conftest import ROOT
from call_filter import lookup as engine_lookup


def rule(number='666', communication='sms', kind='block', scope='*', match_type='exact'):
    return dict(number=number, communication=communication, kind=kind, scope=scope,
                match_type=match_type, description='', enabled=True)


@pytest.fixture
def client(db):
    with TestClient(app, base_url='https://testserver') as client:
        assert client.post('/api/auth/setup', json={'username':'admin', 'password':'synthetic-sms-tests-only',
            'setup_code':(db/'auth/setup-code').read_text()}).status_code == 200
        yield client


@pytest.mark.parametrize('communication', ['calls','sms','both'])
@pytest.mark.parametrize('scope', ['*','1'])
@pytest.mark.parametrize('number', ['666','1023','+33612345678'])
def test_rule_channels_scope_and_whitelist(db, communication, scope, number):
    b.save_settings('*', {'mode':'enforce','sms_mode':'enforce','arcep':True,'saracroche':True})
    b.save_rule(rule(number, communication, scope=scope))
    for channel in ('calls','sms'):
        expected = communication in (channel,'both')
        assert (engine_lookup(b.snapshot_path('1'), number, 'allowed', channel)['action'] == 'reject') == expected
        assert (b.lookup('2', number, communication=channel)['action'] == 'reject') == (expected and scope == '*')
    b.save_rule(rule(number, 'sms', 'allow'))
    assert b.lookup('1',number,communication='sms')['action'] == 'allow'
    assert (b.lookup('1',number)['action'] == 'reject') == (communication in ('calls','both'))


def test_personal_prefix_only_and_no_provider_sms_matching(db):
    b.save_settings('*', {'mode':'enforce','sms_mode':'enforce','arcep':True,'saracroche':True})
    with store._conn() as c:
        c.execute("INSERT INTO blocking_imports(provider,number,match_type) VALUES('saracroche','+33162323065','exact')")
    assert b.lookup('1','+33162323065')['action'] == 'reject'
    assert b.lookup('1','+33162323065',communication='sms')['source'] == 'none'
    b.save_rule(rule('+33162','sms',match_type='prefix'))
    assert b.lookup('1','+33162323065',communication='sms')['action'] == 'reject'
    b.save_rule(rule('+33162323065','calls','allow'))
    assert b.lookup('1','+33162323065',communication='sms')['action'] == 'reject'
    # Same number/kind/exact key is updated, never duplicated for channels.
    allow_id = b.rules('*','allow')[0]['id']
    b.save_rule(rule('+33162323065','both','allow'), allow_id)
    assert b.lookup('1','+33162323065',communication='sms')['action'] == 'allow'


def test_modes_inherit_and_stop_independently(db):
    b.save_rule(rule())
    b.save_settings('*', {'mode':'disabled','sms_mode':'monitor'})
    assert b.lookup('1','666',communication='sms')['would_block']
    assert b.lookup('1','666',communication='sms')['action'] == 'allow'
    b.save_settings('1', {'sms_mode':'enforce'})
    assert b.lookup('1','666',communication='sms')['action'] == 'reject'
    assert b.lookup('2','666',communication='sms')['action'] == 'allow'
    b.save_settings('*', {'mode':'enforce','sms_mode':'disabled'})
    assert b.lookup('1','666',communication='sms')['mode'] == 'disabled'
    assert b.settings('1')['effective']['mode'] == 'enforce'


def test_unique_rule_and_quick_unblock_preserve_other_channels(client):
    body = rule()
    rid = client.post('/api/blocking/rules', json=body).json()['id']
    assert client.post('/api/blocking/rules',json={**body,'communication':'calls'}).status_code == 409
    assert client.post('/api/blocking/quick-rule',json={'number':'666','communication':'calls'}).status_code == 200
    assert b.rules()[0]['communication'] == 'both'
    # Legacy PUT without communication must preserve the existing channel selection.
    legacy = {k:v for k,v in body.items() if k != 'communication'}
    assert client.put(f'/api/blocking/rules/{rid}',json=legacy).status_code == 200
    assert b.rules()[0]['communication'] == 'both'
    b.save_rule(rule('666','both',scope='1'))
    b.save_rule(rule('+33','both',scope='1',match_type='prefix'))
    b.save_rule(rule('666','sms',kind='allow',scope='1'))
    assert client.post('/api/blocking/quick-rule',json={'scope':'1','number':'666','communication':'sms','action':'unblock'}).status_code == 200
    assert next(r for r in b.rules('1','block') if r['number']=='666')['communication'] == 'calls'
    assert b.rules()[0]['communication'] == 'both'  # global not touched
    assert client.post('/api/blocking/quick-rule',json={'scope':'1','number':'666','communication':'calls','action':'unblock'}).status_code == 200
    assert len(b.rules('1','block')) == 1 and b.rules('1','allow')


def report(mode='enforce', action='reject', event_id='synthetic-callback'):
    return {'peer':'666','event_id':event_id,'ts':int(time.time()), 'decision':{
        'normalized':'666','mode':mode,'action':action,'would_block':True,'source':'blacklist',
        'rule':'666','reason':'Personal blacklist'}}


def encoded(value):
    return base64.b64encode(json.dumps(value).encode()).decode()


def engine_client():
    return TestClient(app, headers={'X-Engine-Instance':'1','X-Engine-Token':auth.engine_token('1')})


def test_suppressed_history_no_inbox_ws_push_and_callback_replay(client, monkeypatch):
    broadcast = AsyncMock(); monkeypatch.setattr(hub,'broadcast',broadcast)
    push = []; monkeypatch.setattr('app.main._dispatch_push',lambda *a:push.append(a))
    with engine_client() as engine:
        payload = {'instance':'1','event':'sms_filter','args':[encoded(report())]}
        assert engine.post('/api/engine/event',json=payload).status_code == 200
        assert engine.post('/api/engine/event',json=payload).status_code == 200
    assert len(b.sms_events()) == 1
    assert store.list_threads('1') == []
    broadcast.assert_not_awaited(); assert push == []
    assert len(client.get('/api/blocking/sms-events?instance=1&decision=suppressed').json()['events']) == 1
    assert client.get('/api/blocking/sms-events?decision=allowed').json()['events'] == []
    assert 'body' not in json.dumps(b.sms_events())


@pytest.mark.parametrize('mode', ['disabled','monitor'])
def test_delivered_sms_saved_and_notified_once_per_callback(client, monkeypatch, mode):
    broadcast = AsyncMock(); monkeypatch.setattr(hub,'broadcast',broadcast)
    push=[]; monkeypatch.setattr('app.main._dispatch_push',lambda *a:push.append(a))
    body=base64.b64encode(b'synthetic private message').decode()
    with engine_client() as engine:
        payload={'instance':'1','event':'sms_in','args':['666',body,encoded(report(mode,'allow'))]}
        assert engine.post('/api/engine/event',json=payload).status_code==200
        assert engine.post('/api/engine/event',json=payload).json()['duplicate_callback']
        # A distinct engine delivery with the same text is not arbitrary body deduplication.
        payload['args'][2]=encoded(report(mode,'allow','other-callback'))
        assert engine.post('/api/engine/event',json=payload).status_code==200
    assert len(store.list_messages('1','666')) == 2
    assert broadcast.await_count == 2 and len(push)==2
    assert len(b.sms_events()) == (0 if mode=='disabled' else 2)
    assert 'synthetic private' not in json.dumps(b.sms_events())


def test_failed_handoff_and_malformed_report_fail_open(client, monkeypatch):
    monkeypatch.setattr(hub,'broadcast',AsyncMock())
    monkeypatch.setattr('app.main._dispatch_push',lambda *a:None)
    with engine_client() as engine:
        for data in ('invalid',encoded(report())):
            assert engine.post('/api/engine/event',json={'instance':'1','event':'sms_in',
                'args':['666',base64.b64encode(b'kept').decode(),data]}).status_code==200
    assert len(store.list_messages('1','666'))==2
    assert b.sms_events()[0]['decision']['action']=='allow'


def test_migrate_v4_database_preserves_data_and_is_idempotent(client, db):
    rid=b.save_rule(rule(communication='calls'))
    store.add_message('1','in','666','preserve'); store.add_call('1','out','1023','answered')
    with store._conn() as c:
        c.execute('ALTER TABLE blocking_rules DROP COLUMN communication')
        c.execute('DELETE FROM blocking_migrations WHERE version=5')
        c.execute('DROP TABLE blocking_sms_events'); c.execute('DROP TABLE sms_delivery_receipts')
    with store._conn() as c:
        c.execute("UPDATE blocking_providers SET version='preserved-provider',entries=123,options=?", ('{"source":"local"}',))
        c.execute("INSERT INTO blocking_imports(provider,number,match_type) VALUES('saracroche','+33600000000','exact')")
    b.init(); b.init()
    with store._conn() as c:
        assert c.execute('SELECT version FROM blocking_providers').fetchone()[0]=='preserved-provider'
        assert c.execute('SELECT count(*) FROM blocking_imports').fetchone()[0]==1
    assert b.rules()[0]['id']==rid and b.rules()[0]['communication']=='calls'
    assert b.settings()['global']['sms_mode']=='disabled'
    assert store.list_messages('1','666')[0]['body']=='preserve'
    assert store.list_calls('1')[0]['peer']=='1023'
    assert client.get('/api/auth/status').json()['authenticated']
    with store._conn() as c:
        assert c.execute('PRAGMA quick_check').fetchone()[0]=='ok'


def test_failed_v5_migration_rolls_back_column_and_version(db, monkeypatch):
    with store._conn() as c:
        c.execute('ALTER TABLE blocking_rules DROP COLUMN communication')
        c.execute('DELETE FROM blocking_migrations WHERE version=5')
    real_connect=sqlite3.connect
    class Failing(sqlite3.Connection):
        def execute(self,sql,*args,**kwargs):
            if sql=='INSERT OR IGNORE INTO blocking_migrations VALUES(5)':
                raise sqlite3.OperationalError('synthetic migration failure')
            return super().execute(sql,*args,**kwargs)
    monkeypatch.setattr(sqlite3,'connect',lambda *a,**kw:real_connect(*a,**kw,factory=Failing))
    with pytest.raises(sqlite3.OperationalError): b.init()
    with store._conn() as c:
        assert 'communication' not in [r[1] for r in c.execute('PRAGMA table_info(blocking_rules)')]
        assert not c.execute('SELECT 1 FROM blocking_migrations WHERE version=5').fetchone()


@pytest.mark.parametrize('broken', [False,True])
def test_sms_agi_protocol_and_fail_open(db, broken):
    b.save_settings('*',{'mode':'enforce','sms_mode':'enforce'})
    b.save_rule(rule())
    path=db/'missing.sqlite' if broken else b.snapshot_path('1')
    # Script reads MESSAGE(from), sets a body-free report, then optional suppression.
    responses='agi_uniqueid: synthetic\n\n200 result=1 (sip:666@example.invalid)\n200 result=1\n200 result=1\n'
    process=subprocess.run([sys.executable,str(ROOT/'engine/sms_filter.py')],input=responses,text=True,
        env={**os.environ,'VOWIFI_BLOCKING_SNAPSHOT':str(path)},capture_output=True,timeout=3,check=True)
    lines=process.stdout.splitlines()
    payload=json.loads(base64.b64decode(next(s.split()[-1] for s in lines if s.startswith('SET VARIABLE SMS_FILTER_REPORT '))))
    assert payload['decision']['action']==('allow' if broken else 'reject')
    assert ('SET VARIABLE SMS_SUPPRESS 1' in lines) == (not broken)
    assert 'body' not in payload


def test_bounded_engine_sms_lookup_does_not_leak_descriptors(db):
    b.save_settings('*',{'sms_mode':'monitor'})
    path=b.snapshot_path('1')
    if not Path('/proc/self/fd').exists(): pytest.skip('Linux regression')
    gc.collect(); before=len(list(Path('/proc/self/fd').iterdir())); gc.disable()
    try:
        for _ in range(300): engine_lookup(path,'666','allowed','sms')
        assert len(list(Path('/proc/self/fd').iterdir()))==before
    finally: gc.enable()


def test_sms_dialplan_filters_before_body_logging_notification_and_sip():
    rendered=Environment(loader=FileSystemLoader(ROOT/'engine/templates')).get_template('extensions.conf.j2').render(
        external_accounts=[{'username':'desk'}],webrtc_enable=True,webrtc_user='browser',ring_timeout=35,msisdn='666',realm='ims.invalid')
    sms=rendered.split('[volte_ims_msg]')[1].split('; ===== Outgoing call')[0]
    assert sms.index('AGI(/usr/local/bin/sms_filter.py)')<sms.index('GotoIf')<sms.index('FILE(/logs/messages.txt')<sms.index('notify.py sms_in')<sms.index('MessageSend')
    assert 'sms_suppressed),TrySystem(/usr/local/bin/notify.py sms_filter' in sms
    assert sms.count('notify.py sms_in')==1
    outgoing=rendered.split('[msg-from-local]')[1]
    assert 'sms_filter' not in outgoing and 'MessageSend(pjsip:volte_ims/' in outgoing


def test_quick_block_does_not_reenable_unrelated_disabled_channels(client):
    value={**rule(communication='both'), 'enabled':False}
    b.save_rule(value)
    response=client.post('/api/blocking/quick-rule',json={'number':'666','communication':'sms'})
    assert response.status_code==409
    assert b.rules()[0]['communication']=='both' and not b.rules()[0]['enabled']


@pytest.mark.parametrize('number', ['666','1023','+33612345678'])
def test_outgoing_sms_unaffected_by_enforce(client, monkeypatch, number):
    b.save_settings('*',{'mode':'enforce','sms_mode':'enforce'})
    b.save_rule(rule(number,'both'))
    ami=type('SyntheticAMI',(),{'send_sms':AsyncMock(return_value={'ok':True})})()
    monkeypatch.setattr(hub,'ami_for',AsyncMock(return_value=ami))
    monkeypatch.setattr(hub,'broadcast',AsyncMock())
    watch=AsyncMock(); monkeypatch.setattr('app.main._watch_sms_delivery',watch)
    monkeypatch.setattr(b,'lookup',lambda *a,**kw:pytest.fail('Outgoing SMS consulted incoming policy'))
    response=client.post('/api/instances/1/sms/send',json={'to':number,'body':'synthetic outgoing'})
    assert response.status_code==200 and response.json()['pending_delivery']
    ami.send_sms.assert_awaited_once_with(number,'synthetic outgoing')
    assert store.list_messages('1',number)[0]['direction']=='out'
    assert b.sms_events()==[]


def test_normal_sms_write_failure_rolls_back_receipt(db, monkeypatch):
    real_connect=sqlite3.connect
    class Failing(sqlite3.Connection):
        def execute(self,sql,*args,**kwargs):
            if sql.startswith('INSERT INTO messages'):
                raise sqlite3.OperationalError('synthetic write failure')
            return super().execute(sql,*args,**kwargs)
    monkeypatch.setattr(sqlite3,'connect',lambda *a,**kw:real_connect(*a,**kw,factory=Failing))
    with pytest.raises(sqlite3.OperationalError): b.deliver_sms('1','666','kept',report('monitor','allow'))
    with store._conn() as c:
        assert c.execute('SELECT count(*) FROM sms_delivery_receipts').fetchone()[0]==0


def test_new_snapshots_isolate_sms_from_legacy_call_matchers(db):
    b.save_settings('*',{'mode':'enforce','sms_mode':'enforce'})
    b.save_rule(rule('666','sms'))
    with closing(sqlite3.connect(b.snapshot_path('1'))) as c:
        assert c.execute('SELECT count(*) FROM rules').fetchone()[0]==0
        assert c.execute('SELECT number FROM sms_rules').fetchone()[0]=='666'
    with closing(sqlite3.connect(':memory:')) as c:
        c.executescript("CREATE TABLE settings(key TEXT,value TEXT); INSERT INTO settings VALUES('mode','enforce'),('sms_mode','enforce'); CREATE TABLE rules(kind TEXT,number TEXT,match_type TEXT,priority INTEGER); INSERT INTO rules VALUES('block','666','exact',0)")
        from app.blocking_match import decision
        assert decision(c,'666')['action']=='reject'
        assert decision(c,'666',communication='sms')['action']=='allow'


def test_sms_history_filters_and_paginates(client):
    for iid,event_id,action in [('1','one','allow'),('1','two','reject'),('2','three','reject')]:
        b.record_sms(iid,report('enforce',action,event_id))
    first=client.get('/api/blocking/sms-events?decision=suppressed&limit=1').json()
    assert first['has_more'] and len(first['events'])==1
    assert len(client.get('/api/blocking/sms-events?instance=1&decision=suppressed').json()['events'])==1
    assert len(client.get('/api/blocking/sms-events?decision=suppressed&limit=1&offset=1').json()['events'])==1
