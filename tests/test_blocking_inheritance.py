"""Per-field inheritance must match the API and every already-running Engine's snapshot."""
from contextlib import closing
import json
import sqlite3

from fastapi.testclient import TestClient
import pytest

from app import blocking as b, auth, store, saracroche
from app.main import app
from call_filter import lookup as engine_lookup


@pytest.fixture
def client(db):
    client = TestClient(app, base_url='https://testserver')
    assert client.post('/api/auth/setup', json={'username':'admin','password':'synthetic-inheritance-only',
        'setup_code':(db/'auth/setup-code').read_text()}).status_code == 200
    yield client
    client.close()


def saved():
    with store._conn() as c:
        return list(c.execute('SELECT scope,value FROM blocking_config ORDER BY scope'))


@pytest.mark.parametrize('channel', ['mode','sms_mode'])
@pytest.mark.parametrize('global_mode,override,expected', [
    ('disabled','enforce','enforce'), ('disabled','monitor','monitor'),
    ('disabled',None,'disabled'), ('monitor','enforce','enforce'),
    ('enforce','disabled','disabled'), ('enforce',None,'enforce')])
def test_inheritance_matrix_api_snapshot_and_matcher(client, channel, global_mode, override, expected):
    assert client.put('/api/blocking/settings',json={channel:global_mode}).status_code == 200
    body={} if override is None else {channel:override}
    assert client.put('/api/blocking/settings?scope=1',json=body).status_code == 200
    assert client.post('/api/blocking/rules',json={'scope':'1','kind':'block','number':'666',
        'match_type':'exact','communication':'both'}).status_code == 201
    for iid,mode in [('1',expected),('2',global_mode)]:
        effective=client.get('/api/blocking/settings',params={'scope':iid}).json()['effective']
        with closing(sqlite3.connect(b.snapshot_path(iid))) as c:
            snapshot=dict(c.execute('SELECT key,value FROM settings'))
        assert effective[channel] == snapshot[channel] == mode
        verdict=engine_lookup(b.snapshot_path(iid),'666','allowed','sms' if channel=='sms_mode' else 'calls')
        assert verdict['mode'] == mode
        assert verdict['action'] == ('reject' if iid=='1' and mode=='enforce' else 'allow')


def test_production_config_missing_global_sms_mode_and_upgrade_preservation(client):
    global_value={'mode':'monitor','arcep':False,'saracroche':False,'block_withheld':False,'block_unavailable':False}
    override={'mode':'enforce','sms_mode':'enforce','saracroche':True}
    client.put('/api/blocking/settings',json=global_value)
    client.put('/api/blocking/settings?scope=1',json=override)
    client.post('/api/blocking/rules',json={'scope':'1','kind':'block','number':'+33162323065','communication':'both'})
    original=[tuple(row) for row in saved()]
    original_rules=b.rules('1')
    for channel in ('calls','sms'):
        assert engine_lookup(b.snapshot_path('1'),'+33162323065','allowed',channel)['action']=='reject'
        assert engine_lookup(b.snapshot_path('2'),'+33162323065','allowed',channel)['action']=='allow'
    assert b.settings('2')['effective']['sms_mode']=='disabled'
    # Global rules still apply to every SIM; per-SIM whitelist still wins locally.
    client.post('/api/blocking/rules',json={'scope':'*','kind':'block','number':'1023','communication':'both'})
    for iid in ('1','2'):
        assert b.lookup(iid,'1023')['would_block']
        with closing(sqlite3.connect(b.snapshot_path(iid))) as c:
            assert c.execute("SELECT count(*) FROM sms_rules WHERE number='1023'").fetchone()[0]==1
    client.post('/api/blocking/rules',json={'scope':'1','kind':'allow','number':'+33162323065','communication':'both'})
    for channel in ('calls','sms'):
        assert b.lookup('1','+33162323065',communication=channel)['source']=='whitelist'
    store.add_message('1','in','666','preserved synthetic message')
    rules_before=b.rules('1'); auth.init(); store.init(); b.init()
    assert [tuple(row) for row in saved()]==original
    assert b.rules('1')==rules_before
    assert next(r for r in rules_before if r['kind']=='block')['id']==original_rules[0]['id']
    assert store.list_messages('1','666')[0]['body']=='preserved synthetic message'
    assert client.get('/api/auth/status').json()['authenticated']


def test_sim_updates_and_call_sms_modes_remain_independent(client):
    client.put('/api/blocking/settings',json={'mode':'disabled','sms_mode':'enforce'})
    sim2=client.get('/api/blocking/settings?scope=2').json()
    client.put('/api/blocking/settings?scope=1',json={'mode':'enforce','sms_mode':'disabled'})
    assert b.settings('1')['effective']['mode']=='enforce'
    assert b.settings('1')['effective']['sms_mode']=='disabled'
    assert client.get('/api/blocking/settings?scope=2').json()==sim2
    client.put('/api/blocking/settings?scope=1',json={'sms_mode':'monitor'})
    assert b.settings('1')['effective']['mode']=='disabled'
    assert b.settings('1')['effective']['sms_mode']=='monitor'
    assert client.get('/api/blocking/settings?scope=2').json()==sim2


def test_provider_opt_in_respects_active_sim_despite_global_disabled(db):
    b.save_settings('*',{'mode':'disabled','saracroche':False})
    b.save_settings('1',{'mode':'enforce','saracroche':True})
    assert saracroche.enabled()  # pure gating check; no network request
    b.save_settings('1',{'mode':'disabled','saracroche':True})
    assert not saracroche.enabled()
