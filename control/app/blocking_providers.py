"""Provider lifecycle and opt-in Saracroche Android-protocol synchronization."""
import asyncio
import hashlib
import json
import re
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Protocol

from . import blocking, store, saracroche
from .blocking_match import normalize
from .blocking_coverage import calculate as coverage

log = logging.getLogger(__name__)
_update_lock = threading.Lock()
UNAVAILABLE = 'Saracroche source unavailable; the last valid local database is retained.'


@dataclass(frozen=True)
class Dataset:
    version: str
    rules: list[tuple[str, str]]
    records: list = field(default_factory=list)
    catalog: list = field(default_factory=list)
    license: str = ''


class Provider(Protocol):
    supported: bool
    def fetch(self) -> Dataset:
        """Fetch with bounded time/size and validate transport integrity before returning."""


class Saracroche:
    supported = True
    def fetch(self):
        return saracroche.fetch()


PROVIDERS = {'saracroche': Saracroche()}


def status():
    with store._conn() as c:
        rows = [dict(r) for r in c.execute('SELECT * FROM blocking_providers')]
    for row in rows:
        row['supported'] = PROVIDERS[row['name']].supported
        row['status'] = 'local_ready' if saracroche.options()['source'] == 'local' and row['entries'] else 'available' if row['supported'] else 'access_required'
        row['connection'] = saracroche.options()
        row['catalog'] = json.loads(row['catalog'])
        row['coverage'] = json.loads(row['coverage'])
        row.pop('options', None)
        row['enabled'] = saracroche.enabled()
        row['can_auto_update'] = bool(row['supported'] and row['connection']['source'] == 'remote')
        if not row['can_auto_update'] or not row['enabled']:
            row['next_update'] = None
        row['notice'] = ('Local Android-format database loaded; remote automatic downloads are not configured.'
                         if row['connection']['source'] == 'local' else 'Android-compatible source. Data: CC BY-NC-SA 4.0 (noncommercial); Saracroche / La bonne patte.' if row['supported'] else UNAVAILABLE)
    return rows


def configure(auto_update, interval_hours, **connection):
    now = int(time.time())
    opts = {**saracroche.options(), **connection}
    with store._conn() as c:
        c.execute("UPDATE blocking_providers SET options=? WHERE name='saracroche'", (json.dumps(opts),))
    with store._conn() as c:
        c.execute('UPDATE blocking_providers SET auto_update=?,interval_hours=?,next_update=? WHERE name=?',
                  (auto_update, interval_hours, now + interval_hours * 3600 if auto_update and status()[0]['can_auto_update'] else None, 'saracroche'))


def update(name='saracroche'):
    if isinstance(PROVIDERS[name], Saracroche) and (not saracroche.enabled() or saracroche.options()['source'] != 'remote'):
        return {'ok': False, 'error': 'Enable Saracroche and select the remote source first'}
    if not PROVIDERS[name].supported:
        return {'ok': False, 'error': UNAVAILABLE}
    if not _update_lock.acquire(blocking=False):
        return {'ok': False, 'error': 'Update already in progress'}
    try:
        now = int(time.time())
        try:
            dataset = PROVIDERS[name].fetch()
            records = dataset.records or [(n, k, 'block', 100) for n, k in dataset.rules]
            if not dataset.version or len(dataset.version) > 128 or not records or len(records) > 2_000_000:
                raise ValueError('Invalid dataset metadata or entry count')
            validated = set()
            for number, kind, action, priority in records:
                if kind == 'android':
                    parse_android_ndjson(json.dumps({'name': '', 'pattern': number}).encode())
                elif kind == 'exact' and re.fullmatch(r'(?:[1-9][0-9]{1,5}|\+[1-9][0-9]{6,14})', number):
                    pass
                elif kind not in ('exact', 'prefix') or normalize(number, prefix=kind == 'prefix') != number:
                    raise ValueError('Invalid number or match type in dataset')
                if action not in ('allow', 'block') or type(priority) is not int:
                    raise ValueError('Invalid provider action or priority')
                validated.add((name, number, kind, action, priority))
            by_rule = {}
            for entry in sorted(validated, key=lambda x: (x[4], x[3] != 'allow')):
                by_rule.setdefault(entry[:3], entry)
            validated = list(by_rule.values())
            covered = coverage([(n, k, a, p) for _, n, k, a, p in validated])
            # Replacement + metadata commit together. No change to last good data on error.
            with blocking._lock, store._conn() as c:
                c.execute('DELETE FROM blocking_imports WHERE provider=?', (name,))
                c.executemany('INSERT INTO blocking_imports(provider,number,match_type,action,priority) VALUES(?,?,?,?,?)', validated)
                c.execute('''UPDATE blocking_providers SET last_success=?,version=?,entries=?,
                    error=NULL,failures=0,next_update=CASE WHEN auto_update THEN ?+interval_hours*3600 ELSE NULL END
                    WHERE name=?''', (now, dataset.version, len(validated), now, name))
                c.execute("UPDATE blocking_providers SET source_mode='remote',catalog=?,license=?,checksum=NULL WHERE name=?",
                          (json.dumps(dataset.catalog), dataset.license, name))
                c.execute('UPDATE blocking_providers SET coverage=? WHERE name=?', (json.dumps(covered), name))
            blocking.publish_all()
            return {'ok': True}
        except Exception as exc:
            # Never persist raw transport exception text: it may contain credentials/URLs.
            error = str(exc) if isinstance(exc, saracroche.ProviderError) else UNAVAILABLE if not PROVIDERS[name].supported else 'Download, validation or snapshot publication failed'
            with store._conn() as c:
                row = c.execute('SELECT failures FROM blocking_providers WHERE name=?', (name,)).fetchone()
                failures = row[0] + 1
                delay = min(86400, 300 * 2 ** min(failures - 1, 9))
                c.execute('''UPDATE blocking_providers SET error=?,failures=?,
                    next_update=CASE WHEN auto_update THEN ? ELSE NULL END WHERE name=?''',
                          (error, failures, now + delay, name))
            return {'ok': False, 'error': error}
    finally:
        _update_lock.release()


async def scheduler():
    while True:
        try:
            for row in status():
                if row['enabled'] and row['can_auto_update'] and row['auto_update'] and (row['next_update'] is None or row['next_update'] <= time.time()):
                    await asyncio.to_thread(update, row['name'])
        except Exception:
            log.warning('Blocklist scheduler iteration failed')
        await asyncio.sleep(30)


MAX_IMPORT_BYTES = 64 * 1024 * 1024
MAX_IMPORT_ENTRIES = 1_000_000


def parse_android_ndjson(content):
    """Parse Android ListPatternInfo records without executing untrusted patterns."""
    if not content or len(content) > MAX_IMPORT_BYTES:
        raise ValueError('Database must be nonempty and at most 64 MiB')
    try:
        text = content.decode('utf-8-sig')
    except UnicodeError:
        raise ValueError('Database must be UTF-8 NDJSON') from None
    rules = set()
    count = 0
    for line_number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        count += 1
        if count > MAX_IMPORT_ENTRIES or len(line) > 8192:
            raise ValueError('Database entry or line limit exceeded')
        try:
            item = json.loads(line)
        except (ValueError, RecursionError):
            raise ValueError(f'Invalid JSON at line {line_number}') from None
        if not isinstance(item, dict) or set(item) != {'name', 'pattern'} or not isinstance(item['name'], str):
            raise ValueError(f'Expected Android name/pattern record at line {line_number}')
        pattern = item['pattern']
        if not isinstance(pattern, str) or not re.fullmatch(r'\+?[1-9][0-9]*#*', pattern):
            raise ValueError(f'Unsupported Android pattern at line {line_number}')
        pattern = '+' + pattern.lstrip('+')
        total = len(pattern) - 1
        if not 2 <= total <= 15:
            raise ValueError(f'Invalid Android pattern length at line {line_number}')
        if '#' in pattern:
            digits = pattern.index('#') - 1
            if digits < 1:
                raise ValueError(f'Invalid Android mask at line {line_number}')
            kind = 'android'
        else:
            kind = 'exact'
        # Android catalogs also contain short service codes, without a country code.
        # Keep those separate from E.164; do not expand them into French numbers.
        if total < 7:
            pattern = pattern[1:]
        rules.add(('saracroche', pattern, kind))
    if not rules:
        raise ValueError('Database contains no rules')
    return rules


def import_android(content, version='', license_info=''):
    if not _update_lock.acquire(blocking=False):
        raise ValueError('A database update is already in progress')
    try:
        rules = parse_android_ndjson(content)
        checksum = hashlib.sha256(content).hexdigest()
        version = version.strip() or 'sha256:' + checksum[:16]
        if len(version) > 128 or len(license_info) > 500:
            raise ValueError('Version or license metadata is too long')
        covered = coverage([(n, k, 'block', 100) for _, n, k in rules])
        opts = {**saracroche.options(), 'source': 'local'}
        with blocking._lock, store._conn() as c:
            c.execute("DELETE FROM blocking_imports WHERE provider='saracroche'")
            c.executemany('INSERT INTO blocking_imports(provider,number,match_type) VALUES(?,?,?)', rules)
            c.execute("UPDATE blocking_providers SET options=? WHERE name='saracroche'", (json.dumps(opts),))
            c.execute("UPDATE blocking_providers SET coverage=? WHERE name='saracroche'", (json.dumps(covered),))
            c.execute("""UPDATE blocking_providers SET source_mode='local',last_success=?,version=?,
                entries=?,license=?,checksum=?,error=NULL,failures=0,next_update=NULL
                WHERE name='saracroche'""", (int(time.time()), version, len(rules), license_info, checksum))
        blocking.publish_all()
        return {'ok': True, 'entries': len(rules), 'version': version, 'checksum': checksum}
    finally:
        _update_lock.release()
