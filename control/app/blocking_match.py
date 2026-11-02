"""Load the same pure matcher shipped into the standalone engine Docker context."""
import importlib.util
from pathlib import Path

_path = Path(__file__).resolve().parents[2] / 'engine' / 'blocking_match.py'
_spec = importlib.util.spec_from_file_location('vowifi_blocking_match', _path)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
DEFAULT_CONFIG = _module.DEFAULT_CONFIG
ARCEP_PREFIXES = _module.ARCEP_PREFIXES
normalize = _module.normalize
decision = _module.decision
