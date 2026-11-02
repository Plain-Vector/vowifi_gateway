import hashlib
import json
import time

import pytest

from app import blocking as b, blocking_providers as p, saracroche as s


def data(pattern):
    return json.dumps({'name': 'synthetic test', 'pattern': pattern}).encode()


@pytest.fixture
def remote(db, monkeypatch):
    monkeypatch.delenv('VOWIFI_SARACROCHE_API_KEY', raising=False)
    monkeypatch.delenv('VOWIFI_SARACROCHE_DEVICE_ID', raising=False)
    b.save_settings('*', {'mode': 'enforce', 'saracroche': True})
    files = {'https://app.saracroche.org/block': data('33162######'),
             'https://app.saracroche.org/allow': data('33162123456')}
    catalog = [dict(id=i, name=action, channel='phone', type=action, priority=priority,
                    license=s.LICENSE, version='test-1', item_count=1, download_url=url,
                    hash=hashlib.md5(content, usedforsecurity=False).hexdigest(), is_enabled_by_default=True)
               for i, (action, priority, (url, content)) in enumerate(zip(('block', 'allow'), (100, 50), files.items()), 1)]
    requests = []
    def read(session, url, headers, limit, deadline):
        requests.append((url, headers))
        return json.dumps(catalog).encode() if url == s.CATALOG_URL else files[url]
    monkeypatch.setattr(s, 'read_response', read)
    return catalog, files, requests


def test_remote_update_priorities_metadata_and_cache(remote):
    catalog, files, requests = remote
    assert p.update()['ok']
    assert b.lookup('1', '0162123456')['reason'] == 'Saracroche allowlist'
    assert b.lookup('1', '0162123457')['action'] == 'reject'
    status = p.status()[0]
    assert len(status['catalog']) == 2 and status['license'] == s.LICENSE
    assert status['next_update'] > time.time()
    assert all('X-Country-Code' in h for _, h in requests)
    requests.clear()
    assert p.update()['ok']
    assert [url for url, _ in requests] == [s.CATALOG_URL]  # verified unchanged content reused
    catalog[1]['priority'] = 500
    assert p.update()['ok']
    assert b.lookup('1', '0162123456')['reason'] == 'Saracroche blocklist'


def test_remote_selected_lists_and_disable(remote):
    _, _, requests = remote
    p.configure(True, 24, selected_list_ids=[2])
    assert p.update()['ok']
    assert not b.lookup('1', '0162123457')['would_block']
    requests.clear()
    b.save_settings('*', {'saracroche': False})
    assert not p.update()['ok']
    assert not requests and p.status()[0]['next_update'] is None


@pytest.mark.parametrize('problem', ['checksum', 'count', 'license', 'missing', 'json'])
def test_remote_failure_preserves_valid_database(remote, problem):
    catalog, files, _ = remote
    assert p.update()['ok']
    previous = p.status()[0]
    if problem == 'checksum': catalog[0]['hash'] = '0' * 32
    elif problem == 'count': catalog[0]['item_count'] = 5
    elif problem == 'license': catalog[0]['license'] = None
    elif problem == 'missing': p.configure(True, 24, selected_list_ids=[999])
    else:
        files['https://app.saracroche.org/block'] = b'bad'
        catalog[0]['hash'] = hashlib.md5(b'bad').hexdigest()
    assert not p.update()['ok']
    assert p.status()[0]['version'] == previous['version']
    assert p.status()[0]['last_success'] == previous['last_success']
    assert b.lookup('1', '0162123457')['action'] == 'reject'


@pytest.mark.parametrize('url', ['http://app.saracroche.org/file', 'https://other.example/file',
    'https://app.saracroche.org@evil.example/file', 'https://127.0.0.1/file'])
def test_remote_url_boundary(url):
    class NoNetwork:
        def get(self, *a, **kw): raise AssertionError('Unexpected request')
    with pytest.raises(s.ProviderError):
        s.read_response(NoNetwork(), url, {}, 100, time.monotonic() + 1)


@pytest.mark.parametrize('code', [301, 401, 403, 429, 500])
def test_remote_http_error_sanitized(code):
    class Response:
        status_code = code
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def iter_content(self, _): yield b'SECRET'
    class Session:
        def get(self, *a, **kw):
            assert kw['allow_redirects'] is False
            return Response()
    with pytest.raises(s.ProviderError) as error:
        s.read_response(Session(), s.CATALOG_URL, {}, 100, time.monotonic() + 1)
    assert 'SECRET' not in str(error.value)


def test_remote_issued_credentials_only(remote, monkeypatch):
    _, _, requests = remote
    monkeypatch.setenv('VOWIFI_SARACROCHE_API_KEY', 'test-secret')
    assert not p.update()['ok'] and not requests
    monkeypatch.setenv('VOWIFI_SARACROCHE_DEVICE_ID', 'issued-test-device')
    assert p.update()['ok']
    assert all(h.get('X-API-Key') == 'test-secret' and 'X-Country-Code' not in h for _, h in requests)
    assert 'test-secret' not in json.dumps(p.status())


def test_android_short_codes_and_personal_override(db):
    p.import_android(data('1234'))
    b.save_settings('*', {'mode': 'enforce', 'saracroche': True})
    assert b.lookup('1', '1234')['action'] == 'reject'
    assert not b.lookup('1', '12345')['would_block']
