#!/usr/bin/env python3
"""Bounded local AGI lookup. No HTTP or shell in the decision path."""
import base64
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import time

from blocking_match import decision


def timeout(*_):
    raise TimeoutError('Local lookup deadline exceeded')


def lookup(path, caller, presentation):
    start = time.monotonic()
    with sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro&immutable=1', uri=True, timeout=0.05) as c:
        c.set_progress_handler(lambda: int(time.monotonic() - start > 0.1), 100)
        return decision(c, caller, presentation)


def main():
    env = {}
    result = {'action': 'allow', 'would_block': False, 'source': 'error', 'rule': '',
              'reason': 'Local lookup failed; call allowed', 'mode': 'monitor', 'normalized': None}
    signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, 0.5)
    try:
        for _ in range(100):
            line = sys.stdin.readline(4096).strip()
            if not line:
                break
            key, _, value = line.partition(':')
            env[key] = value.strip()
        result = lookup(os.environ.get('VOWIFI_BLOCKING_SNAPSHOT', '/run/vowifi/blocking.sqlite'),
                        env.get('agi_callerid', ''), env.get('agi_callingpres', 'allowed'))
        # Asterisk AGI exposes numeric presentation indicators in agi_callingpres.
        # 32..63 = prohibited; 64..95 = unavailable.
    except Exception:
        pass  # fail open, sanitized error recorded below
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    if result['action'] == 'reject':
        # Only a fixed constant reaches the AGI protocol (no untrusted caller interpolation).
        signal.setitimer(signal.ITIMER_REAL, 0.2)
        try:
            print('SET VARIABLE CB_REJECT 1', flush=True)
            sys.stdin.readline(4096)
        except Exception:
            # The command may already have been applied; retain the decision sent.
            result['reason'] += '; AGI acknowledgement unavailable'
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
    # notify.py performs best-effort delivery in a detached process, after the local decision.
    # It also journals the event locally if the manager is down. Never pass caller ID to a shell.
    if result['mode'] != 'disabled' or result['source'] == 'error':
        report = {'peer': env.get('agi_callerid', '')[:128],
                  'call_id': env.get('agi_uniqueid', '')[:128] or str(time.time_ns()),
                  'ts': int(time.time()), 'decision': result}
        encoded = base64.b64encode(json.dumps(report).encode()).decode()
        try:
            subprocess.Popen([sys.executable, '/usr/local/bin/notify.py', 'call_filter', encoded],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
        except Exception:
            try:
                with open('/logs/blocking-errors.jsonl', 'a') as f:
                    f.write(json.dumps(report) + '\n')
            except Exception:
                pass


if __name__ == '__main__':
    main()
