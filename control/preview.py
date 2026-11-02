#!/usr/bin/env python3
"""Loopback-only local test installation. No Docker engines or PC/SC operations."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('VOWIFI_DATA', str(ROOT / 'data/local-preview'))
os.environ['VOWIFI_WEBUI'] = str(ROOT / 'webui/dist')
os.environ['VOWIFI_BIND'] = '127.0.0.1'
os.environ.setdefault('VOWIFI_HTTP_PORT', '8843')
os.environ['VOWIFI_PREVIEW'] = '1'

from app import config, engine, sim, card
from run import main


def no_hardware(*args, **kwargs):
    raise ValueError('Local preview: hardware operations are disabled')


engine.start = engine.stop = no_hardware
engine.is_running = lambda *_: False
engine.container_ip = lambda *_: None
sim.list_readers = lambda: []
card.reader_states = lambda: []
# Only a disabled synthetic line is added; runtime data never touches the default installation.
state = config.load()
if not state['instances']:
    state['instances']['preview'] = {'id':'preview', 'name':'Test line (offline)',
        'enabled':False, 'mcc':'208', 'mnc':'01', 'imsi':'208010000000000',
        'msisdn':'+33600000000', 'reader_index':0, 'ports':{}}
    config.save(state)

if __name__ == '__main__': main()
