"""Call-filter persistence, migrations and atomic per-engine rule snapshots."""
from contextlib import closing
import json
import os
import sqlite3
import tempfile
import threading
import time
from pathlib import Path

from . import config as cfg, store
from .blocking_match import DEFAULT_CONFIG, decision

_lock = threading.RLock()


def init():
    with _lock, store._conn() as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS blocking_migrations(version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS blocking_rules(
          id INTEGER PRIMARY KEY, scope TEXT NOT NULL DEFAULT '*',
          kind TEXT NOT NULL CHECK(kind IN ('allow','block')),
          number TEXT NOT NULL, match_type TEXT NOT NULL CHECK(match_type IN ('exact','prefix')),
          description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
          UNIQUE(scope,kind,number,match_type));
        CREATE TABLE IF NOT EXISTS blocking_config(scope TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS blocking_providers(
          name TEXT PRIMARY KEY, auto_update INTEGER NOT NULL DEFAULT 1,
          interval_hours INTEGER NOT NULL DEFAULT 24, last_success INTEGER,
          next_update INTEGER, version TEXT, entries INTEGER NOT NULL DEFAULT 0,
          error TEXT, failures INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS blocking_imports(
          provider TEXT NOT NULL, number TEXT NOT NULL, match_type TEXT NOT NULL,
          PRIMARY KEY(provider,number,match_type));
        CREATE TABLE IF NOT EXISTS blocking_events(
          id INTEGER PRIMARY KEY, instance TEXT NOT NULL, peer TEXT NOT NULL,
          ts INTEGER NOT NULL, call_id TEXT NOT NULL, decision TEXT NOT NULL,
          UNIQUE(instance,call_id));
        CREATE INDEX IF NOT EXISTS blocking_events_ts ON blocking_events(ts DESC);
        INSERT OR IGNORE INTO blocking_migrations VALUES(1);
        INSERT OR IGNORE INTO blocking_providers(name) VALUES('saracroche');
        ''')
        if not c.execute('SELECT 1 FROM blocking_migrations WHERE version=2').fetchone():
            c.execute("ALTER TABLE blocking_providers ADD COLUMN source_mode TEXT NOT NULL DEFAULT 'none'")
            c.execute("ALTER TABLE blocking_providers ADD COLUMN license TEXT")
            c.execute("ALTER TABLE blocking_providers ADD COLUMN checksum TEXT")
            c.execute('UPDATE blocking_providers SET next_update=NULL WHERE name=?', ('saracroche',))
            c.execute('INSERT INTO blocking_migrations VALUES(2)')
        if not c.execute('SELECT 1 FROM blocking_migrations WHERE version=3').fetchone():
            c.execute("ALTER TABLE blocking_imports ADD COLUMN action TEXT NOT NULL DEFAULT 'block'")
            c.execute('ALTER TABLE blocking_imports ADD COLUMN priority INTEGER NOT NULL DEFAULT 100')
            c.execute("ALTER TABLE blocking_providers ADD COLUMN options TEXT NOT NULL DEFAULT '{}'")
            c.execute("ALTER TABLE blocking_providers ADD COLUMN catalog TEXT NOT NULL DEFAULT '[]'")
            c.execute('INSERT INTO blocking_migrations VALUES(3)')
        if not c.execute('SELECT 1 FROM blocking_migrations WHERE version=4').fetchone():
            c.execute("ALTER TABLE blocking_providers ADD COLUMN coverage TEXT NOT NULL DEFAULT '{}'")
            from .blocking_coverage import calculate
            for provider in c.execute('SELECT name FROM blocking_providers').fetchall():
                records = c.execute('SELECT number,match_type,action,priority FROM blocking_imports WHERE provider=?', (provider[0],)).fetchall()
                c.execute('UPDATE blocking_providers SET coverage=? WHERE name=?', (json.dumps(calculate(records)), provider[0]))
            c.execute('INSERT INTO blocking_migrations VALUES(4)')
    publish_all()


def settings(scope='*'):
    with store._conn() as c:
        rows = dict(c.execute('SELECT scope,value FROM blocking_config'))
    global_config = {**DEFAULT_CONFIG, **json.loads(rows.get('*', '{}'))}
    override = json.loads(rows.get(scope, '{}')) if scope != '*' else {}
    effective = {**global_config, **override}
    # Global Disabled is the emergency stop, including lines with Enforce overrides.
    if global_config['mode'] == 'disabled':
        effective['mode'] = 'disabled'
    return {'scope': scope, 'global': global_config, 'override': override,
            'effective': effective}


def save_settings(scope, value):
    with _lock, store._conn() as c:
        c.execute('INSERT OR REPLACE INTO blocking_config VALUES(?,?)', (scope, json.dumps(value)))
    publish_all()
    return settings(scope)


def rules(scope='*', kind=None, search='', enabled=None):
    sql = 'SELECT * FROM blocking_rules WHERE scope=?'
    args = [scope]
    if kind:
        sql += ' AND kind=?'
        args.append(kind)
    if search:
        sql += ' AND (instr(number,?)>0 OR instr(description,?)>0)'
        args.extend([search, search])
    if enabled is not None:
        sql += ' AND enabled=?'
        args.append(int(enabled))
    with store._conn() as c:
        return [dict(r) for r in c.execute(sql + ' ORDER BY kind,number', args)]


def save_rule(value, rid=None):
    with _lock, store._conn() as c:
        if rid is None:
            cur = c.execute('''INSERT INTO blocking_rules(scope,kind,number,match_type,description,enabled)
                VALUES(:scope,:kind,:number,:match_type,:description,:enabled)''', value)
            rid = cur.lastrowid
        else:
            cur = c.execute('''UPDATE blocking_rules SET scope=:scope,kind=:kind,number=:number,
                match_type=:match_type,description=:description,enabled=:enabled WHERE id=:id''',
                {**value, 'id': rid})
            if not cur.rowcount:
                raise KeyError(rid)
    publish_all()
    return rid


def delete_rule(rid):
    with _lock, store._conn() as c:
        if not c.execute('DELETE FROM blocking_rules WHERE id=?', (rid,)).rowcount:
            raise KeyError(rid)
    publish_all()


def snapshot_path(iid):
    # Instance ids originate in config, but still prevent path traversal.
    if not iid or any(ch not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for ch in iid):
        raise ValueError('Invalid instance id')
    return Path(cfg.DATA_DIR) / 'instances' / iid / 'run' / 'blocking.sqlite'


def build_snapshot(c, iid):
    effective = settings(iid)['effective']
    c.executescript('''CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
        CREATE TABLE rules(kind TEXT,number TEXT,match_type TEXT,priority INTEGER DEFAULT 0);
        CREATE INDEX rules_lookup ON rules(kind,number);''')
    c.executemany('INSERT INTO settings VALUES(?,?)',
                  [(k, json.dumps(v) if isinstance(v, bool) else v) for k, v in effective.items()])
    with store._conn() as source:
        c.executemany('INSERT INTO rules(kind,number,match_type) VALUES(?,?,?)', source.execute(
            'SELECT kind,number,match_type FROM blocking_rules WHERE scope IN (\'*\',?) AND enabled=1', (iid,)))
        c.executemany('INSERT INTO rules VALUES(?,?,?,?)', source.execute(
            "SELECT CASE WHEN action='allow' THEN provider || '_allow' ELSE provider END,"
            "number,match_type,priority FROM blocking_imports"))


def publish(iid):
    with _lock:
        path = snapshot_path(str(iid))
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix='.blocking-', dir=path.parent)
        os.close(fd)
        try:
            with closing(sqlite3.connect(tmp)) as c, c:
                build_snapshot(c, str(iid))
            os.chmod(tmp, 0o644)  # contains only filter rules, no secrets
            with open(tmp, 'rb') as f:
                os.fsync(f.fileno())
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)


def publish_all():
    for inst in cfg.list_instances():
        publish(str(inst['id']))


def lookup(iid, caller, presentation='allowed'):
    # Same query and schema as the AGI, without writing test events.
    with _lock, closing(sqlite3.connect(':memory:')) as c:
        build_snapshot(c, iid)
        return decision(c, caller, presentation)


def record(iid, peer, call_id, result, ts=None):
    with _lock, store._conn() as c:
        cur = c.execute('INSERT OR IGNORE INTO blocking_events(instance,peer,ts,call_id,decision) VALUES(?,?,?,?,?)',
                        (iid, peer, ts or int(time.time()), call_id, json.dumps(result)))
        return bool(cur.rowcount)


def events(iid=None, limit=100, offset=0, decision=None, source=None, since=None, until=None):
    clauses, args = [], []
    if iid:
        clauses.append('instance=?'); args.append(iid)
    if decision == 'rejected':
        clauses.append("json_extract(decision,'$.action')='reject'")
    elif decision == 'would_block':
        clauses.append("json_extract(decision,'$.action')='allow' AND json_extract(decision,'$.would_block')=1")
    elif decision == 'allowed':
        clauses.append("json_extract(decision,'$.action')='allow' AND coalesce(json_extract(decision,'$.would_block'),0)=0")
    if source:
        clauses.append("json_extract(decision,'$.source')=?"); args.append(source)
    if since is not None:
        clauses.append('ts>=?'); args.append(since)
    if until is not None:
        clauses.append('ts<=?'); args.append(until)
    where = 'WHERE ' + ' AND '.join('(' + clause + ')' for clause in clauses) if clauses else ''
    with store._conn() as c:
        rows = c.execute('SELECT * FROM blocking_events ' + where +
                         ' ORDER BY ts DESC,id DESC LIMIT ? OFFSET ?', (*args, limit, offset))
        return [{**dict(r), 'decision': json.loads(r['decision'])} for r in rows]
