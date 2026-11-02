"""SQLite contexts own both transaction completion and deterministic connection close."""
import gc
import sqlite3

import pytest

from app import auth, store


@pytest.mark.parametrize('factory', [auth.conn, store._conn])
def test_connection_is_closed_on_success_and_rollback(db, factory):
    with factory() as connection:
        connection.execute('CREATE TABLE lifetime_test(value TEXT)')
        connection.execute("INSERT INTO lifetime_test VALUES('committed')")
    # Retain the Python reference so GC cannot disguise a missing close().
    with pytest.raises(sqlite3.ProgrammingError, match='closed'):
        connection.execute('SELECT 1')
    with pytest.raises(RuntimeError, match='synthetic failure'):
        with factory() as failed:
            failed.execute("INSERT INTO lifetime_test VALUES('rolled back')")
            raise RuntimeError('synthetic failure')
    with pytest.raises(sqlite3.ProgrammingError, match='closed'):
        failed.execute('SELECT 1')
    with factory() as verification:
        assert [row[0] for row in verification.execute('SELECT * FROM lifetime_test')] == ['committed']


def test_connection_is_closed_after_failed_commit(db):
    with pytest.raises(sqlite3.IntegrityError):
        with store._conn() as connection:
            connection.execute('PRAGMA foreign_keys=ON')
            connection.executescript('''CREATE TABLE parent(id INTEGER PRIMARY KEY);
                CREATE TABLE child(parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);''')
            connection.execute('INSERT INTO child VALUES(123)')
    with pytest.raises(sqlite3.ProgrammingError, match='closed'):
        connection.execute('SELECT 1')
    with store._conn() as verification:
        assert verification.execute('SELECT count(*) FROM child').fetchone()[0] == 0


def test_auth_connection_closes_if_permission_setup_fails(db, monkeypatch):
    opened = []
    connect = sqlite3.connect
    def tracked(*args, **kwargs):
        connection = connect(*args, **kwargs)
        opened.append(connection)
        return connection
    def denied(*args, **kwargs):
        raise PermissionError('synthetic permission failure')
    monkeypatch.setattr(auth.sqlite3, 'connect', tracked)
    monkeypatch.setattr(auth.os, 'chmod', denied)
    with pytest.raises(PermissionError):
        with auth.conn():
            pytest.fail('Connection setup should have failed before yielding')
    with pytest.raises(sqlite3.ProgrammingError, match='closed'):
        opened[0].execute('SELECT 1')


def test_authenticated_polling_and_scheduler_do_not_accumulate_fds(db):
    import json
    import os
    from pathlib import Path
    import subprocess
    import sys
    from conftest import ROOT
    if not Path('/proc/self/fd').is_dir():
        pytest.skip('Linux /proc FD regression')
    script = r'''
import asyncio, gc, json, os, resource, sqlite3
from pathlib import Path
from fastapi.testclient import TestClient
from app import auth, blocking, blocking_providers as providers, config, store
from app.main import app
config.list_instances = lambda: [{'id':'1'}, {'id':'2'}]
config.get_instance = lambda iid: {'id':iid} if iid in ('1','2') else None
store.init(); blocking.init(); auth.init()
client = TestClient(app, base_url='https://testserver')
code = (Path(config.DATA_DIR)/'auth/setup-code').read_text()
assert client.post('/api/auth/setup', json={'username':'admin','password':'synthetic-fd-regression-only','setup_code':code}).status_code == 200
store.add_message('1','in','666','synthetic preserved message')
store.add_call('1','out','1023','answered')
paths = [str(Path(config.DATA_DIR)/'auth/admin.sqlite'), store.DB_PATH]
def descriptors():
    found = []
    for entry in Path('/proc/self/fd').iterdir():
        try: found.append(os.readlink(entry))
        except FileNotFoundError: pass
    return sum(any(target == p or target.startswith(p+'-') for p in paths) for target in found)
soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
resource.setrlimit(resource.RLIMIT_NOFILE, (min(1024, soft), hard))
gc.collect(); gc.disable()
observed = [descriptors()]
try:
    for cycle in range(200):
        for endpoint in ('/api/auth/status','/api/blocking/settings?scope=1','/api/blocking/providers','/api/blocking/events','/api/instances/1/calls','/api/instances/1/messages/threads'):
            response = client.get(endpoint)
            assert response.status_code == 200, (endpoint, response.status_code)
        store.add_message('2','in','666','synthetic polling write')
        blocking.lookup('1','666')
        if cycle % 20 == 0:
            blocking.publish_all()
            observed.append(descriptors())
            assert observed[-1] == 0, observed
    blocking.save_settings('*', {'mode':'monitor','saracroche':True})
    iterations = 0
    def fake_update(name):
        with store._conn() as connection:
            connection.execute("UPDATE blocking_providers SET error=NULL WHERE name=?", (name,))
        return {'ok':True}
    async def tick(seconds):
        global iterations
        iterations += 1
        observed.append(descriptors())
        assert observed[-1] == 0, observed
        if iterations == 200: raise asyncio.CancelledError
    providers.update = fake_update
    providers.asyncio.sleep = tick
    async def run():
        try: await providers.scheduler()
        except asyncio.CancelledError: pass
    asyncio.run(run())
    assert iterations == 200
    # Reinitialization does not replace data, users or live sessions.
    auth.init(); store.init(); blocking.init()
    assert client.get('/api/auth/status').json()['authenticated'] is True
    assert store.list_messages('1','666')[0]['body'] == 'synthetic preserved message'
    assert store.list_calls('1')[0]['peer'] == '1023'
    for factory in (auth.conn, store._conn):
        with factory() as connection:
            assert connection.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
    observed.append(descriptors()); assert max(observed) == 0, observed
    print(json.dumps({'requests':1200,'scheduler_iterations':iterations,'max_database_fds':max(observed),'final_database_fds':observed[-1]}))
finally:
    client.close(); gc.enable(); gc.collect()
'''
    result = subprocess.run([sys.executable, '-c', script], env={
        **os.environ, 'VOWIFI_DATA': str(db), 'PYTHONPATH': str(ROOT / 'control'), 'PYTHONWARNINGS': 'ignore',
    }, capture_output=True, text=True, check=True, timeout=60)
    measured = json.loads(result.stdout)
    assert measured == {'requests': 1200, 'scheduler_iterations': 200, 'max_database_fds': 0, 'final_database_fds': 0}
