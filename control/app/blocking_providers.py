"""Provider lifecycle. Saracroche is intentionally unavailable until access is granted."""
import asyncio
import logging
import threading
import time
from dataclasses import dataclass
from typing import Protocol

from . import blocking, store
from .blocking_match import normalize

log = logging.getLogger(__name__)
_update_lock = threading.Lock()
UNAVAILABLE = ('Saracroche has no documented public download API. Provider permission, '
               'database license and supported gateway credentials are required; no download attempted.')


@dataclass(frozen=True)
class Dataset:
    version: str
    rules: list[tuple[str, str]]


class Provider(Protocol):
    supported: bool
    def fetch(self) -> Dataset:
        """Fetch with bounded time/size and validate transport integrity before returning."""


class Saracroche:
    supported = False
    def fetch(self):
        raise RuntimeError(UNAVAILABLE)


PROVIDERS = {'saracroche': Saracroche()}


def status():
    with store._conn() as c:
        rows = [dict(r) for r in c.execute('SELECT * FROM blocking_providers')]
    for row in rows:
        row['supported'] = PROVIDERS[row['name']].supported
        row['status'] = 'available' if row['supported'] else 'access_required'
        row['notice'] = '' if row['supported'] else UNAVAILABLE
    return rows


def configure(auto_update, interval_hours):
    now = int(time.time())
    with store._conn() as c:
        c.execute('UPDATE blocking_providers SET auto_update=?,interval_hours=?,next_update=? WHERE name=?',
                  (auto_update, interval_hours, now + interval_hours * 3600 if auto_update else None, 'saracroche'))


def update(name='saracroche'):
    if not _update_lock.acquire(blocking=False):
        return {'ok': False, 'error': 'Update already in progress'}
    try:
        now = int(time.time())
        try:
            dataset = PROVIDERS[name].fetch()
            if not dataset.version or len(dataset.version) > 128 or not dataset.rules or len(dataset.rules) > 2_000_000:
                raise ValueError('Invalid dataset metadata or entry count')
            validated = set()
            for number, kind in dataset.rules:
                if kind not in ('exact', 'prefix') or normalize(number, prefix=kind == 'prefix') != number:
                    raise ValueError('Invalid number or match type in dataset')
                validated.add((name, number, kind))
            # Replacement + metadata commit together. No change to last good data on error.
            with blocking._lock, store._conn() as c:
                c.execute('DELETE FROM blocking_imports WHERE provider=?', (name,))
                c.executemany('INSERT INTO blocking_imports VALUES(?,?,?)', validated)
                c.execute('''UPDATE blocking_providers SET last_success=?,version=?,entries=?,
                    error=NULL,failures=0,next_update=CASE WHEN auto_update THEN ?+interval_hours*3600 ELSE NULL END
                    WHERE name=?''', (now, dataset.version, len(validated), now, name))
            blocking.publish_all()
            return {'ok': True}
        except Exception:
            # Never persist raw transport exception text: it may contain credentials/URLs.
            error = UNAVAILABLE if not PROVIDERS[name].supported else 'Download, validation or snapshot publication failed'
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
                if row['auto_update'] and (row['next_update'] is None or row['next_update'] <= time.time()):
                    await asyncio.to_thread(update, row['name'])
        except Exception:
            log.warning('Blocklist scheduler iteration failed')
        await asyncio.sleep(30)
