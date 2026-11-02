"""Settings contract and disk persistence across a fresh Control process."""
import json
import os
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

from app import auth, blocking, store
from app.main import app
from conftest import ROOT


@pytest.fixture
def client(db):
    client = TestClient(app, base_url='https://testserver')
    response = client.post('/api/auth/setup', json={
        'username': 'admin', 'password': 'synthetic-test-password-123',
        'setup_code': (db / 'auth/setup-code').read_text(),
    })
    assert response.status_code == 200
    return client


def settings(client, scope='*'):
    response = client.get('/api/blocking/settings', params={'scope': scope})
    assert response.status_code == 200
    return response.json()


def test_global_line_replace_inheritance_and_restart(client, db):
    global_value = {'mode': 'monitor', 'sms_mode': 'disabled', 'arcep': True, 'saracroche': True,
                    'block_withheld': True, 'block_unavailable': False}
    assert client.put('/api/blocking/settings', json=global_value).status_code == 200
    override = {'saracroche': False, 'mode': 'enforce'}
    assert client.put('/api/blocking/settings?scope=1', json=override).status_code == 200
    assert settings(client)['global'] == global_value
    assert settings(client, '1')['override'] == override
    assert settings(client, '1')['effective'] == {**global_value, **override}
    assert settings(client, '2')['override'] == {}
    assert settings(client, '2')['effective'] == global_value
    # A new interpreter reads the same SQLite file, without inherited module state.
    env = {**os.environ, 'VOWIFI_DATA': str(db), 'PYTHONPATH': str(ROOT / 'control')}
    script = "from app import store,blocking; import json; store.init(); blocking.init(); print(json.dumps(blocking.settings('1')))"
    restarted = json.loads(subprocess.check_output([sys.executable, '-c', script], env=env, text=True))
    assert restarted == settings(client, '1')
    # Existing administrator and session survive initialization/reload.
    auth.init(); store.init(); blocking.init()
    assert client.get('/api/settings').status_code == 200
    assert client.put('/api/blocking/settings?scope=1', json={'mode': None}).status_code == 200
    assert settings(client, '1')['override'] == {}
    assert settings(client, '1')['effective'] == global_value
    assert settings(client, '2')['effective'] == global_value


def test_provider_partial_writes_validation_and_restart(client, db):
    path = '/api/blocking/providers/saracroche'
    config = {'source': 'local', 'auto_update': False, 'interval_hours': 72,
              'country_codes': 'FR,BE', 'selected_list_ids': [2, 4]}
    assert client.put(path, json=config).status_code == 200
    # Legacy section-specific clients must not silently reset the other section.
    assert client.put(path, json={'country_codes': 'FR'}).status_code == 200
    p = client.get('/api/blocking/providers').json()['providers'][0]
    assert p['connection'] == {'source': 'local', 'country_codes': 'FR', 'selected_list_ids': [2, 4]}
    assert p['auto_update'] == 0 and p['interval_hours'] == 72
    for invalid in ({'interval_hours': 0}, {'country_codes': 'bad'}, {'selected_list_ids': []}):
        response = client.put(path, json=invalid)
        assert response.status_code == 422
        assert client.get('/api/blocking/providers').json()['providers'][0]['connection'] == p['connection']
    script = "from app import store,blocking,blocking_providers; import json; store.init(); blocking.init(); print(json.dumps(blocking_providers.status()[0]))"
    restarted = json.loads(subprocess.check_output([sys.executable, '-c', script], env={
        **os.environ, 'VOWIFI_DATA': str(db), 'PYTHONPATH': str(ROOT / 'control')}, text=True))
    assert restarted['connection'] == p['connection']
    assert restarted['auto_update'] == 0 and restarted['interval_hours'] == 72


@pytest.mark.parametrize('mode,action', [('disabled', 'allow'), ('monitor', 'allow'), ('enforce', 'reject')])
def test_modes_and_explicit_line_override(client, mode, action):
    assert client.put('/api/blocking/settings', json={'mode': mode, 'block_withheld': True}).status_code == 200
    assert settings(client)['effective']['mode'] == mode
    assert blocking.lookup('1', '', 'prohib')['action'] == action
    if mode == 'disabled':
        client.put('/api/blocking/settings?scope=1', json={'mode': 'enforce'})
        assert settings(client, '1')['override']['mode'] == 'enforce'
        assert settings(client, '1')['effective']['mode'] == 'enforce'
        assert blocking.lookup('1', '', 'prohib')['action'] == 'reject'


def test_unauthenticated_and_invalid_write_do_not_change_saved_values(client):
    original = settings(client)
    assert TestClient(app).put('/api/blocking/settings', json={'mode': 'enforce'}).status_code == 401
    assert client.put('/api/blocking/settings', json={'mode': 'invalid'}).status_code == 422
    assert client.put('/api/blocking/settings?scope=missing', json={}).status_code == 404
    assert settings(client) == original


def seed_decisions():
    for index, (iid, action, would_block, source) in enumerate([
        ('1', 'allow', False, 'none'), ('1', 'allow', True, 'saracroche'),
        ('1', 'reject', True, 'blacklist'), ('2', 'reject', True, 'arcep'),
        ('2', 'allow', False, 'whitelist'), ('1', 'allow', True, 'saracroche'),
    ]):
        blocking.record(iid, '+33612345678', f'ui-test-{index}', {
            'action': action, 'would_block': would_block, 'source': source,
            'mode': 'monitor' if action == 'allow' and would_block else 'enforce',
            'reason': 'Synthetic decision', 'rule': 'test', 'normalized': '+33612345678',
        }, ts=1000 + index)


def test_history_filters_are_applied_before_pagination(client):
    seed_decisions()
    path = '/api/blocking/events'
    first = client.get(path, params={'decision': 'would_block', 'source': 'saracroche', 'instance': '1', 'limit': 1}).json()
    assert first['has_more'] and len(first['events']) == 1
    assert first['events'][0]['ts'] == 1005
    second = client.get(path, params={'decision': 'would_block', 'source': 'saracroche', 'instance': '1', 'limit': 1, 'offset': 1}).json()
    assert not second['has_more'] and second['events'][0]['ts'] == 1001
    assert len(client.get(path).json()['events']) == 6  # old endpoint contract remains valid


def test_history_distinguishes_rejected_allowed_and_monitor(client):
    seed_decisions()
    for category in ('allowed', 'rejected', 'would_block'):
        rows = client.get('/api/blocking/events', params={'decision': category}).json()['events']
        assert len(rows) == 2
        if category == 'rejected':
            assert all(r['decision']['action'] == 'reject' for r in rows)
        else:
            assert all(r['decision']['action'] == 'allow' for r in rows)
            assert all(bool(r['decision']['would_block']) == (category == 'would_block') for r in rows)


def test_history_time_window_and_parameter_validation(client):
    seed_decisions()
    rows = client.get('/api/blocking/events', params={'since': 1001, 'until': 1003}).json()['events']
    assert [row['ts'] for row in rows] == [1003, 1002, 1001]
    for params in ({'since': 2, 'until': 1}, {'source': 'injected'}, {'decision': 'invalid'}, {'since': -1}, {'instance': 'missing'}):
        assert client.get('/api/blocking/events', params=params).status_code in (422, 404)
