import datetime
import hashlib
import sys
from unittest.mock import Mock

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

import notify
import requests


def test_engine_callback_token_is_scoped_and_certificate_pinned(tmp_path, monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537,key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(1).not_valid_before(now).not_valid_after(now+datetime.timedelta(days=1))
            .sign(key,hashes.SHA256()))
    path = tmp_path/'cert.pem';path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    token = tmp_path/'token';token.write_text('test-only-engine-token')
    log = tmp_path/'events.jsonl'
    monkeypatch.setenv('VOWIFI_MANAGER_TOKEN_FILE',str(token))
    monkeypatch.setenv('VOWIFI_MANAGER_CERT',str(path))
    monkeypatch.setenv('VOWIFI_EVENT_LOG',str(log))
    monkeypatch.setenv('MANAGER_URL','https://host.docker.internal:8443')
    monkeypatch.setenv('VOWIFI_ID','1')
    monkeypatch.setattr(sys,'argv',['notify.py','tunnel_up'])
    session = Mock()
    session.__enter__ = Mock(return_value=session);session.__exit__ = Mock()
    monkeypatch.setattr(requests,'Session',lambda:session)
    notify.main()
    args = session.post.call_args.kwargs
    assert args['headers']['X-Engine-Token'] == 'test-only-engine-token'
    assert args['headers']['X-Engine-Instance'] == args['json']['instance'] == '1'
    adapter = session.mount.call_args.args[1]
    assert adapter.poolmanager.connection_pool_kw['assert_fingerprint'] == hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest()
    assert args['allow_redirects'] is False
    assert 'test-only-engine-token' not in log.read_text()
