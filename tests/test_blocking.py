import json
import sqlite3
import time
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jinja2 import Environment, FileSystemLoader, StrictUndefined

from app import blocking as b, blocking_providers as p, store
from app.blocking_api import router
from app.blocking_match import ARCEP_PREFIXES, normalize
from call_filter import lookup as agi_lookup
from conftest import ROOT


def rule(number='+33612345678', kind='block', scope='*', match_type='exact', enabled=True):
    return b.save_rule(dict(scope=scope, number=number, kind=kind, match_type=match_type,
                            description='Test', enabled=enabled))


@pytest.mark.parametrize('value,expected', [
    ('0612345678', '+33612345678'), ('+33 6 12 34 56 78', '+33612345678'),
    ('0033612345678', '+33612345678'), ('sip:+33612345678@ims.example;user=phone', '+33612345678'),
    ('<tel:+33612345678>', '+33612345678'), ('+442071234567', '+442071234567'),
    ('00442071234567', '+442071234567'), ('+590598712345', '+590598712345'),
    ('anonymous', None), ('', None), ('12345', None), ('+330612345678', None),
    ('+33612345678.*', None), ('+336[0-9]+', None), ('+3361234567890123', None),
])
def test_normalize(value, expected):
    assert normalize(value) == expected


def test_prefix_normalization():
    assert normalize('0162', prefix=True) == '+33162'
    assert normalize('0033162', prefix=True) == '+33162'
    assert normalize('0162') is None
    assert normalize('0162*', prefix=True) is None


def test_precedence_modes_and_prefix(db):
    b.save_settings('*', {'mode': 'enforce', 'arcep': True})
    rule('+33162', match_type='prefix')
    assert b.lookup('1', '0162123456')['source'] == 'blacklist'
    rule('+33162123456', 'allow', scope='1')
    assert b.lookup('1', '0162123456')['source'] == 'whitelist'
    assert b.lookup('1', '0162123456')['action'] == 'allow'
    assert b.lookup('2', '0162123456')['action'] == 'reject'
    assert b.lookup('1', '0163123456')['source'] == 'arcep'
    b.save_settings('2', {'mode': 'monitor'})
    result = b.lookup('2', '0162123456')
    assert result['would_block'] and result['action'] == 'allow'
    b.save_settings('2', {'mode': 'disabled'})
    assert not b.lookup('2', '0162123456')['would_block']
    b.save_settings('2', {})
    assert b.lookup('2', '0162123456')['action'] == 'reject'


def test_default_monitor_exact_enabled_and_scope(db):
    rule(scope='1')
    assert b.lookup('1', '0612345678')['would_block']
    assert b.lookup('1', '0612345678')['action'] == 'allow'
    assert not b.lookup('2', '0612345678')['would_block']
    assert not b.lookup('1', '+33612345679')['would_block']
    rid = rule('+442071234567', enabled=False)
    assert not b.lookup('1', '+442071234567')['would_block']
    b.delete_rule(rid)
    assert len(b.rules('*')) == 0


@pytest.mark.parametrize('caller,pres,source', [('', 'allowed', 'unavailable'),
    ('anonymous', 'allowed', 'withheld'), ('+33612345678', 'prohib', 'withheld'),
    ('+33612345678', '32', 'withheld'), ('', '67', 'unavailable')])
def test_missing_and_restricted(db, caller, pres, source):
    b.save_settings('*', {'mode': 'enforce', 'block_withheld': True, 'block_unavailable': True})
    rule('+33612345678', 'allow')
    result = b.lookup('1', caller, pres)
    assert result['source'] == source and result['action'] == 'reject'


def test_overseas_arcep(db):
    b.save_settings('*', {'mode': 'enforce', 'arcep': True})
    assert len(ARCEP_PREFIXES) == 22
    for prefix in ARCEP_PREFIXES:
        assert b.lookup('1', prefix + '123456')['source'] == 'arcep'
    assert b.lookup('1', '+590598712345')['source'] == 'arcep'
    assert b.lookup('1', '+33151012345')['source'] == 'none'  # distinct public-interest range


def test_atomic_snapshots_and_local_equivalence(db):
    b.save_settings('*', {'mode': 'enforce'})
    path = b.snapshot_path('1')
    old = sqlite3.connect(path)
    assert dict(old.execute('SELECT key,value FROM settings'))['mode'] == 'enforce'
    rule()
    assert old.execute('SELECT count(*) FROM rules').fetchone()[0] == 0
    old.close()
    assert agi_lookup(path, '0612345678', 'allowed') == b.lookup('1', '0612345678')
    before = path.read_bytes()
    with patch.object(b, 'build_snapshot', side_effect=RuntimeError):
        with pytest.raises(RuntimeError):
            b.publish('1')
    assert path.read_bytes() == before
    assert not list(path.parent.glob('.blocking-*'))
    with pytest.raises(sqlite3.OperationalError):
        agi_lookup(db / 'missing', '0612345678', 'allowed')


class Fake:
    supported = True
    def fetch(self):
        return p.Dataset('test-v1', [('+33612345678', 'exact'), ('+33162', 'prefix')])


def test_provider_update_atomic_validation_and_failure(db, monkeypatch):
    monkeypatch.setitem(p.PROVIDERS, 'saracroche', Fake())
    b.save_settings('*', {'mode': 'enforce', 'saracroche': True})
    assert p.update()['ok']
    assert b.lookup('1', '0612345678')['source'] == 'saracroche'
    initial = p.status()[0]
    assert initial['entries'] == 2 and initial['last_success']
    class Invalid(Fake):
        def fetch(self):
            return p.Dataset('bad', [('+336.*', 'prefix')])
    monkeypatch.setitem(p.PROVIDERS, 'saracroche', Invalid())
    assert not p.update()['ok']
    assert p.status()[0]['version'] == 'test-v1'
    assert p.status()[0]['last_success'] == initial['last_success']
    assert p.status()[0]['failures'] == 1
    assert p.status()[0]['next_update'] >= time.time() + 295
    assert b.lookup('1', '0612345678')['action'] == 'reject'
    rule('+33612345678', 'allow')
    assert b.lookup('1', '0612345678')['source'] == 'whitelist'
    class Fails(Fake):
        def fetch(self):
            raise RuntimeError('SECRET API TOKEN')
    monkeypatch.setitem(p.PROVIDERS, 'saracroche', Fails())
    assert 'SECRET' not in json.dumps(p.update())
    assert p.status()[0]['failures'] == 2
    assert p.status()[0]['next_update'] >= time.time() + 595


def test_provider_unavailable_no_network_and_schedule(db, monkeypatch):
    monkeypatch.setattr(p.Saracroche, 'supported', False)
    assert not p.status()[0]['supported']
    with patch('socket.create_connection', side_effect=AssertionError('Network forbidden')):
        assert not p.update()['ok']
    assert p.status()[0]['entries'] == 0
    p.configure(False, 48)
    assert p.status()[0]['next_update'] is None
    p.configure(True, 24)
    assert p.status()[0]['next_update'] is None
    assert p.status()[0]['failures'] == 0


def test_api_crud_validation_auth_and_search(db, monkeypatch):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    monkeypatch.setenv('VOWIFI_BLOCKING_TOKEN', 'test-only')
    assert client.get('/api/blocking/settings').status_code == 401
    client.headers['X-Blocking-Token'] = 'test-only'
    assert client.put('/api/blocking/settings', json={'mode': 'enforce'}, headers={'Origin': 'https://evil.example'}).status_code == 403
    assert client.put('/api/blocking/settings', json={'mode': 'enforce'}, headers={'Origin': 'http://testserver'}).status_code == 200
    for body in [{'mode': 'bad'}, {'unknown': True}]:
        assert client.put('/api/blocking/settings', json=body).status_code == 422
    assert client.get('/api/blocking/settings?scope=unknown').status_code == 404
    body = {'number': '0612345678', 'kind': 'block', 'description': 'hello'}
    r = client.post('/api/blocking/rules', json=body)
    assert r.status_code == 201
    rid = r.json()['id']
    assert client.post('/api/blocking/rules', json=body).status_code == 409
    assert client.post('/api/blocking/rules', json={**body, 'number': '.*'}).status_code == 422
    assert len(client.get('/api/blocking/rules?search=hello').json()['rules']) == 1
    assert client.get('/api/blocking/rules?search=absent').json()['rules'] == []
    assert client.post('/api/blocking/lookup', json={'instance': '1', 'number': '0612345678'}).json()['action'] == 'reject'
    assert client.put(f'/api/blocking/rules/{rid}', json={**body, 'enabled': False}).status_code == 200
    assert client.get('/api/blocking/rules?enabled=true').json()['rules'] == []
    assert client.delete(f'/api/blocking/rules/{rid}').status_code == 200
    assert client.delete(f'/api/blocking/rules/{rid}').status_code == 404
    assert client.get('/api/blocking/events?limit=9999').status_code == 422
    assert client.put('/api/blocking/providers/saracroche', json={'interval_hours': 0}).status_code == 422


def test_event_idempotency_and_existing_calls(db):
    result = b.lookup('1', '0612345678')
    assert b.record('1', '0612345678', 'call.1', result)
    assert not b.record('1', '0612345678', 'call.1', result)
    assert b.record('2', '0612345678', 'call.1', result)
    assert len(b.events('1')) == 1
    rec = store.add_call('1', 'out', '+442071234567', 'dialing')
    store.update_call(rec['id'], 'answered', ended=True)
    assert store.list_calls('1')[0]['status'] == 'answered'
    store.add_call_deduped('1', 'in', '+33612345678')
    store.update_last_call('1', 'in', '+33612345678', 'missed')
    assert next(c for c in store.list_calls('1') if c['direction'] == 'in')['status'] == 'missed'


@pytest.mark.parametrize('external,webrtc', [([], False), ([{'username': 'linphone'}], False),
    ([], True), ([{'username': 'desk'}], True)])
def test_rendered_dialplan_routing(external, webrtc):
    env = Environment(loader=FileSystemLoader(ROOT / 'engine/templates'), undefined=StrictUndefined)
    rendered = env.get_template('extensions.conf.j2').render(external_accounts=external,
        webrtc_enable=webrtc, webrtc_user='browser', ring_timeout=35, msisdn='+33612345678', realm='ims.example')
    incoming, rest = rendered.split('; ===== Incoming SMS', 1)
    assert incoming.index('AGI(/usr/local/bin/call_filter.py)') < incoming.index('Progress()')
    assert incoming.index('GotoIf') < incoming.index('Ringing()')
    assert 'WaitForPrecondition(10,2000)' in incoming
    assert 'PJSIPHangup(Decline)' in incoming
    for account in external:
        assert 'PJSIP/' + account['username'] in incoming
    if webrtc:
        assert 'PJSIP/browser' in incoming
    if not external and not webrtc:
        assert 'Answer()' in incoming
    assert 'AGI(' not in rest
    assert 'Dial(PJSIP/${EXTEN}@volte_ims,35)' in rest
    assert 'MessageSend(pjsip:volte_ims/' in rest


@pytest.mark.parametrize('missing,mode,reject', [(False, 'enforce', True), (False, 'monitor', False),
                                                (False, 'disabled', False), (True, 'enforce', False)])
def test_agi_protocol_and_fail_open(db, missing, mode, reject):
    import subprocess
    import sys
    import os
    b.save_settings('*', {'mode': mode})
    rule()
    path = db / 'missing.sqlite' if missing else b.snapshot_path('1')
    env = {**os.environ, 'VOWIFI_BLOCKING_SNAPSHOT': str(path)}
    started = time.monotonic()
    proc = subprocess.run([sys.executable, str(ROOT / 'engine/call_filter.py')],
        input='agi_callerid: 0612345678\nagi_callingpres: 0\nagi_uniqueid: test.1\n\n200 result=1\n',
        text=True, capture_output=True, env=env, timeout=2)
    assert proc.returncode == 0 and not proc.stderr
    assert ('SET VARIABLE CB_REJECT 1' in proc.stdout) == reject
    assert time.monotonic() - started < 1.5


def test_global_disabled_is_master_stop(db):
    rule()
    b.save_settings('1', {'mode': 'enforce'})
    assert b.lookup('1', '0612345678')['action'] == 'reject'
    b.save_settings('*', {'mode': 'disabled'})
    assert b.lookup('1', '0612345678')['mode'] == 'disabled'
    assert not b.lookup('1', '0612345678')['would_block']
    b.save_settings('*', {'mode': 'monitor'})
    assert b.lookup('1', '0612345678')['action'] == 'reject'
