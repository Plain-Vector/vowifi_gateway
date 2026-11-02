"""Single-admin login, opaque server-side sessions and per-engine callback tokens."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.requests import HTTPConnection

from . import config as cfg

COOKIE = 'vowifi_session'
SESSION_SECONDS = 8 * 3600
_lock = threading.RLock()


def conn():
    directory = Path(cfg.DATA_DIR) / 'auth'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / 'admin.sqlite'
    c = sqlite3.connect(path, timeout=2)
    c.row_factory = sqlite3.Row
    os.chmod(path, 0o600)
    return c


def init():
    with _lock, conn() as c:
        c.executescript('''CREATE TABLE IF NOT EXISTS admin(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT,password TEXT);
          CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires INTEGER);
          CREATE TABLE IF NOT EXISTS attempts(peer TEXT PRIMARY KEY,count INTEGER,until INTEGER);
          CREATE TABLE IF NOT EXISTS engines(instance TEXT PRIMARY KEY,token TEXT);''')
        if not c.execute('SELECT 1 FROM admin').fetchone():
            path = Path(cfg.DATA_DIR) / 'auth' / 'setup-code'
            try:
                fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(fd, 'w') as f:
                    f.write(secrets.token_urlsafe(24))
            except FileExistsError:
                pass


def configured():
    with conn() as c:
        return bool(c.execute('SELECT 1 FROM admin').fetchone())


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def password_hash(password):
    salt = secrets.token_bytes(32)
    value = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 600000)
    return salt.hex() + ':' + value.hex()


def password_matches(password, encoded):
    salt, expected = encoded.split(':')
    value = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), 600000)
    return hmac.compare_digest(value.hex(), expected)


def authenticated(connection):
    token = connection.cookies.get(COOKIE, '')
    if not token or len(token) > 100:
        return False
    with conn() as c:
        row = c.execute('SELECT expires FROM sessions WHERE token=?', (digest(token),)).fetchone()
    return bool(row and row['expires'] > time.time())


def new_session(response, request):
    token = secrets.token_urlsafe(32)
    with conn() as c:
        c.execute('DELETE FROM sessions WHERE expires<?', (int(time.time()),))
        c.execute('INSERT INTO sessions VALUES(?,?)', (digest(token), int(time.time()) + SESSION_SECONDS))
    response.set_cookie(COOKIE, token, max_age=SESSION_SECONDS, httponly=True,
                        secure=request.url.scheme == 'https', samesite='strict', path='/')


def check_origin(connection):
    origin = connection.headers.get('origin')
    if origin and (urlsplit(origin).netloc != connection.headers.get('host')
                   or urlsplit(origin).scheme != {'ws': 'http', 'wss': 'https'}.get(connection.url.scheme, connection.url.scheme)):
        raise HTTPException(403, 'Cross-origin request rejected')
    if connection.headers.get('sec-fetch-site') == 'cross-site':
        raise HTTPException(403, 'Cross-site request rejected')


def rate_limit(request):
    # Ignore X-Forwarded-For; only trusted server proxy configuration may resolve client IP.
    peer = request.client.host if request.client else 'unknown'
    now = int(time.time())
    with _lock, conn() as c:
        c.execute('DELETE FROM attempts WHERE until<?', (now,))
        row = c.execute('SELECT count FROM attempts WHERE peer=?', (peer,)).fetchone()
        total = c.execute('SELECT COALESCE(SUM(count),0) FROM attempts').fetchone()[0]
        if (row and row['count'] >= 10) or total >= 100:
            raise HTTPException(429, 'Too many login attempts; retry in 15 minutes')
        c.execute('INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(peer) DO UPDATE SET count=count+1',
                  (peer, now + 900))


def engine_token(iid):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', str(iid)):
        raise ValueError('Invalid instance id')
    path = Path(cfg.DATA_DIR) / 'instances' / str(iid) / 'run' / 'manager-token'
    path.parent.mkdir(parents=True, exist_ok=True)
    with _lock:
        try:
            token = path.read_text().strip()
        except FileNotFoundError:
            token = secrets.token_urlsafe(32)
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'w') as f:
                f.write(token)
        os.chmod(path, 0o600)
        with conn() as c:
            c.execute('INSERT OR REPLACE INTO engines VALUES(?,?)', (str(iid), digest(token)))
    return token


def engine_authenticated(connection):
    iid = connection.headers.get('x-engine-instance', '')
    token = connection.headers.get('x-engine-token', '')
    if not iid or not token or len(token) > 100:
        return False
    with conn() as c:
        row = c.execute('SELECT token FROM engines WHERE instance=?', (iid,)).fetchone()
    return bool(row and hmac.compare_digest(row['token'], digest(token)))


class AccessMiddleware:
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope['type'] not in ('http', 'websocket'):
            return await self.app(scope, receive, send)
        connection = HTTPConnection(scope)
        path = scope['path']
        protected = path.startswith('/api/') or path in ('/ws', '/docs', '/openapi.json', '/redoc')
        public = path in ('/api/auth/status', '/api/auth/login', '/api/auth/setup')
        try:
            if scope['type'] == 'websocket' or (scope.get('method') not in ('GET', 'HEAD', 'OPTIONS')):
                check_origin(connection)
            service = path == '/api/engine/event' and engine_authenticated(connection)
            if protected and not public and not service and not authenticated(connection):
                raise HTTPException(401, 'Administrator login required')
        except HTTPException as exc:
            if scope['type'] == 'websocket':
                return await send({'type': 'websocket.close', 'code': 4401 if exc.status_code == 401 else 4403})
            return await JSONResponse({'detail': exc.detail}, status_code=exc.status_code)(scope, receive, send)
        async def secure_send(message):
            if message['type'] == 'http.response.start':
                headers = list(message.get('headers', []))
                headers.extend([(b'x-content-type-options', b'nosniff'), (b'x-frame-options', b'DENY'),
                                (b'referrer-policy', b'same-origin')])
                if path.startswith('/api/'):
                    headers.append((b'cache-control', b'no-store'))
                message['headers'] = headers
            await send(message)
        await self.app(scope, receive, secure_send)


router = APIRouter(prefix='/api/auth')


class Login(BaseModel):
    model_config = ConfigDict(extra='forbid')
    username: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_.-]+$')
    password: str = Field(min_length=1, max_length=256)


class Setup(Login):
    setup_code: str = Field(min_length=1, max_length=128)


@router.get('/status')
def status(request: Request):
    return {'configured': configured(), 'authenticated': authenticated(request),
            'preview': os.environ.get('VOWIFI_PREVIEW') == '1'}


@router.post('/setup')
def setup(body: Setup, request: Request, response: Response):
    rate_limit(request)
    if len(body.password) < 12:
        raise HTTPException(422, 'Use a password of at least 12 characters')
    with _lock, conn() as c:
        if c.execute('SELECT 1 FROM admin').fetchone():
            raise HTTPException(409, 'Administrator already configured')
        path = Path(cfg.DATA_DIR) / 'auth' / 'setup-code'
        if not hmac.compare_digest(body.setup_code, path.read_text().strip()):
            raise HTTPException(401, 'Invalid setup code')
        c.execute('INSERT INTO admin VALUES(1,?,?)', (body.username, password_hash(body.password)))
    path.unlink(missing_ok=True)
    new_session(response, request)
    return {'ok': True}


@router.post('/login')
def login(body: Login, request: Request, response: Response):
    rate_limit(request)
    with conn() as c:
        row = c.execute('SELECT username,password FROM admin').fetchone()
    # Do equivalent hashing even when the account does not exist.
    encoded = row['password'] if row else '00' * 32 + ':' + '00' * 32
    matches = password_matches(body.password, encoded)
    if not row or not matches or not hmac.compare_digest(row['username'], body.username):
        raise HTTPException(401, 'Invalid username or password')
    new_session(response, request)
    return {'ok': True}


@router.post('/logout')
def logout(request: Request, response: Response):
    with conn() as c:
        c.execute('DELETE FROM sessions WHERE token=?', (digest(request.cookies.get(COOKIE, '')),))
    response.delete_cookie(COOKIE, path='/')
    return {'ok': True}


class ChangePassword(BaseModel):
    model_config = ConfigDict(extra='forbid')
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=12, max_length=256)


@router.post('/password')
def change_password(body: ChangePassword, request: Request, response: Response):
    rate_limit(request)
    with _lock, conn() as c:
        row = c.execute('SELECT password FROM admin').fetchone()
        if not row or not password_matches(body.current_password, row['password']):
            raise HTTPException(401, 'Current password incorrect')
        c.execute('UPDATE admin SET password=?', (password_hash(body.new_password),))
        c.execute('DELETE FROM sessions')
    new_session(response, request)
    return {'ok': True}
