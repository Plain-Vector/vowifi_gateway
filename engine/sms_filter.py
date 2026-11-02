#!/usr/bin/env python3
"""Body-free, bounded local SMS decision on Asterisk's Message channel.

SIP transaction response and SMS RP-ACK remain in res_pjsip_messaging, independent
of the user inbox policy. A missing/failed AGI leaves SMS_SUPPRESS=0 in the dialplan.
"""
import base64
import json
import os
import re
import signal
import sys
import time
import uuid

from call_filter import lookup, timeout


def command(text):
    print(text, flush=True)
    response = sys.stdin.readline(16384)
    if not response.startswith('200 result='):
        raise RuntimeError('AGI command failed')
    return response


def main():
    env = {}
    signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, 0.5)
    try:
        for _ in range(100):
            line = sys.stdin.readline(4096).strip()
            if not line:
                break
            key, _, value = line.partition(':')
            env[key] = value.strip()
        response = command('GET FULL VARIABLE ${MESSAGE(from)}')
        match = re.fullmatch(r'200 result=1 \((.*)\)\s*', response)
        peer = match.group(1)[:128] if match else ''
        try:
            result = lookup(os.environ.get('VOWIFI_BLOCKING_SNAPSHOT', '/run/vowifi/blocking.sqlite'), peer, 'allowed', 'sms')
        except Exception:
            result = {'action':'allow', 'would_block':False, 'source':'error', 'rule':'',
                      'reason':'Local SMS lookup failed; SMS allowed', 'mode':'monitor', 'normalized':None}
        report = {'peer':peer, 'event_id':str(uuid.uuid4()), 'ts':int(time.time()), 'decision':result}
        encoded = base64.b64encode(json.dumps(report).encode()).decode()
        # Report must be available before suppressing so blocked messages have no body log.
        command('SET VARIABLE SMS_FILTER_REPORT ' + encoded)
        if result['action'] == 'reject':
            command('SET VARIABLE SMS_SUPPRESS 1')
    except Exception:
        pass  # fixed dialplan default is normal delivery
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


if __name__ == '__main__':
    main()
