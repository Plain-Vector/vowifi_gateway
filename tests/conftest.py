import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'control'))
sys.path.insert(0, str(ROOT / 'engine'))

from app import blocking, config, store


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(store, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(store, 'DB_PATH', str(tmp_path / 'vowifi.sqlite'))
    monkeypatch.setattr(config, 'DATA_DIR', str(tmp_path))
    instances = [{'id': '1'}, {'id': '2'}]
    monkeypatch.setattr(config, 'list_instances', lambda: instances)
    monkeypatch.setattr(config, 'get_instance', lambda iid: next((i for i in instances if i['id'] == iid), None))
    store.init()
    blocking.init()
    return tmp_path
