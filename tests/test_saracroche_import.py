import json
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import blocking as b, blocking_providers as p, store
from app.blocking_api import router
from call_filter import lookup as agi_lookup


def ndjson(*patterns):
    return '\n'.join(json.dumps({'name': 'Test', 'pattern': pattern}) for pattern in patterns).encode()


def test_import_opt_in_masks_and_local_snapshot(db):
    data = ndjson('33612345678', '33162######', '+4420########')
    b.save_settings('*', {'mode': 'enforce'})
    with patch('socket.create_connection', side_effect=AssertionError('No network')):
        result = p.import_android(data, 'example-1', 'User-supplied license')
    assert result['ok'] and result['entries'] == 3
    assert not b.lookup('1', '0612345678')['would_block']
    b.save_settings('1', {'saracroche': True})
    for number in ('0612345678', '0162123456', '+442012345678'):
        decision = b.lookup('1', number)
        assert decision['source'] == 'saracroche' and decision['action'] == 'reject'
        assert agi_lookup(b.snapshot_path('1'), number, 'allowed') == decision
    assert not b.lookup('2', '0612345678')['would_block']
    # Exact wildcard length: +44 has no French fixed-length validation to mask mistakes.
    assert not b.lookup('1', '+44201234567')['would_block']
    assert not b.lookup('1', '+4420123456789')['would_block']
    assert b.lookup('1', '0162123456')['rule'] == '+33162######'
    b.save_settings('1', {'saracroche': False})
    assert not b.lookup('1', '0162123456')['would_block']
    status = p.status()[0]
    assert status['status'] == 'local_ready' and not status['can_auto_update']
    assert status['next_update'] is None and status['checksum'] == result['checksum']
    assert status['license'] == 'User-supplied license'
    assert not p.update()['ok']  # no implicit switch to an unsupported remote feed
    assert p.status()[0]['version'] == 'example-1'


@pytest.mark.parametrize('bad', [b'', b'not json', b'\xff', b'[]', b'{}',
    ndjson('336.*'), ndjson('3316##12##'), ndjson('33162################'), ndjson('0033612345678'),
    b'{"name":"a","pattern":null}', ndjson('33612345678') + b'\nmalformed'])
def test_import_rejects_entire_invalid_dataset_and_preserves_previous(db, bad):
    p.import_android(ndjson('33612345678'), 'good')
    previous = p.status()[0]
    snapshot = b.snapshot_path('1').read_bytes()
    with pytest.raises(ValueError):
        p.import_android(bad, 'bad')
    current = p.status()[0]
    assert current['version'] == 'good'
    assert current['checksum'] == previous['checksum']
    assert current['last_success'] == previous['last_success']
    assert b.snapshot_path('1').read_bytes() == snapshot


def test_import_duplicate_records_api_auth_and_limits(db, monkeypatch):
    app = FastAPI(); app.include_router(router)
    client = TestClient(app)
    monkeypatch.setenv('VOWIFI_BLOCKING_TOKEN', 'example-only')
    path = '/api/blocking/providers/saracroche/import?version=api-v1'
    data = ndjson('33612345678', '+33612345678')
    assert client.post(path, content=data).status_code == 401
    client.headers['X-Blocking-Token'] = 'example-only'
    assert client.post(path, content=data, headers={'Origin': 'https://evil.example'}).status_code == 403
    result = client.post(path, content=data)
    assert result.status_code == 200 and result.json()['entries'] == 1
    assert client.post(path, content=b'bad').status_code == 422
    monkeypatch.setattr(p, 'MAX_IMPORT_BYTES', 10)
    assert client.post(path, content=data).status_code == 413


def test_import_replaces_only_provider_rules_and_whitelist_wins(db):
    b.save_settings('*', {'mode': 'enforce', 'saracroche': True})
    b.save_rule({'scope': '*', 'kind': 'allow', 'number': '+33612345678', 'match_type': 'exact',
                 'description': '', 'enabled': True})
    p.import_android(ndjson('33612345678', '33162######'))
    assert b.lookup('1', '0612345678')['source'] == 'whitelist'
    assert b.lookup('1', '0162123456')['source'] == 'saracroche'
    p.import_android(ndjson('33687654321'))
    assert b.lookup('1', '0162123456')['source'] == 'none'
    assert b.lookup('1', '0612345678')['source'] == 'whitelist'
    assert len(b.rules()) == 1


def test_v2_migration_is_idempotent(db):
    p.import_android(ndjson('33612345678'), 'survives')
    b.init(); b.init()
    assert p.status()[0]['version'] == 'survives'
    with store._conn() as c:
        assert [row[0] for row in c.execute('SELECT version FROM blocking_migrations ORDER BY version')] == [1, 2, 3]
