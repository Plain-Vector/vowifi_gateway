from pathlib import Path
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import auth
from app.main import app

PASSWORD = 'test-password-only-1234'


def setup(client, db):
    code = (db / 'auth/setup-code').read_text()
    return client.post('/api/auth/setup', json={'username': 'admin', 'password': PASSWORD, 'setup_code': code})


def test_setup_login_logout_and_no_secrets_before_auth(db):
    client = TestClient(app, base_url='https://testserver')
    assert client.get('/api/settings').status_code == 401
    assert client.get('/api/instances').status_code == 401
    assert client.get('/docs').status_code == 401
    assert client.get('/api/auth/status').json()['configured'] is False
    assert client.post('/api/auth/setup', json={'username':'admin','password':PASSWORD,'setup_code':'wrong'}).status_code == 401
    response = setup(client, db)
    assert response.status_code == 200
    cookie = response.headers['set-cookie']
    assert all(word in cookie.lower() for word in ('httponly', 'secure', 'samesite=strict'))
    assert not (db / 'auth/setup-code').exists()
    assert client.get('/api/settings').status_code == 200
    with auth.conn() as c:
        encoded = c.execute('SELECT password FROM admin').fetchone()[0]
        assert PASSWORD not in encoded
        assert c.execute('SELECT token FROM sessions').fetchone()[0] != client.cookies[auth.COOKIE]
    assert client.post('/api/auth/logout').status_code == 200
    assert client.get('/api/settings').status_code == 401
    assert client.post('/api/auth/login', json={'username':'admin','password':'wrong'}).status_code == 401
    assert client.post('/api/auth/login', json={'username':'admin','password':PASSWORD}).status_code == 200
    assert client.post('/api/auth/setup', json={'username':'another','password':PASSWORD,'setup_code':'wrong'}).status_code == 409


def test_password_change_revokes_other_sessions_and_csrf(db):
    first = TestClient(app, base_url='https://testserver'); second = TestClient(app, base_url='https://testserver')
    setup(first, db)
    second.post('/api/auth/login', json={'username':'admin','password':PASSWORD})
    assert first.put('/api/settings', json={}, headers={'Origin':'https://evil.example'}).status_code == 403
    assert first.post('/api/auth/password', json={'current_password':'wrong','new_password':PASSWORD+'new'}).status_code == 401
    assert first.post('/api/auth/password', json={'current_password':PASSWORD,'new_password':PASSWORD+'new'}).status_code == 200
    assert first.get('/api/settings').status_code == 200
    assert second.get('/api/settings').status_code == 401


def test_session_expiration_rate_limit_and_engine_scope(db):
    client = TestClient(app)
    setup(client, db)
    with auth.conn() as c:
        c.execute('UPDATE sessions SET expires=0')
    assert client.get('/api/settings').status_code == 401
    for _ in range(9):
        client.post('/api/auth/login', json={'username':'admin','password':'wrong'})
    assert client.post('/api/auth/login', json={'username':'admin','password':PASSWORD}).status_code == 429
    engine = TestClient(app, headers={'X-Engine-Instance':'1','X-Engine-Token':auth.engine_token('1')})
    assert engine.get('/api/settings').status_code == 401
    assert engine.post('/api/engine/event', json={'instance':'2','event':'tunnel_up'}).status_code == 403
    assert engine.post('/api/engine/event', json={'instance':'1','event':'call_filter','args':['bad']}).status_code == 422
    assert TestClient(app).post('/api/engine/event', json={}).status_code == 401


def test_websocket_requires_session_and_same_origin(db):
    client = TestClient(app, base_url='https://testserver')
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect('/ws'): pass
    setup(client, db)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect('/ws', headers={'Origin':'https://evil.example'}): pass
    with client.websocket_connect('wss://testserver/ws', headers={'Origin':'https://testserver'}) as ws:
        ws.send_text('ping')


def test_public_spa_rejects_encoded_path_escape(db):
    # The built frontend is optional in backend-only CI; the SPA route exists only when built.
    from app.main import WEBUI_DIR
    if not Path(WEBUI_DIR).is_dir():
        return
    client = TestClient(app)
    response = client.get('/%2e%2e/%2e%2e/control/requirements.txt')
    assert response.status_code == 404
