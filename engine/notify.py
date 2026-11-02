#!/usr/bin/env python3
"""
notify.py - Best-effort event hook: POST engine events to the manager.

Usage (from the Asterisk dialplan or swu_ike tunnel hooks):
  notify.py <event> [arg1] [arg2] ...

Events: call_in <from>, call_out <to>, sms_in <from> <body_b64>,
        sms_out <to> <body_b64>, tunnel_up, tunnel_down, registered, unregistered

Reads MANAGER_URL and VOWIFI_ID from /run/vowifi/engine.env (written by render.py).
Never fails the caller (all exceptions swallowed).
"""
import os
import sys
import json
import hashlib
import ssl
import re
from urllib.parse import urlsplit


def load_env():
    env = {}
    path = os.environ.get("VOWIFI_ENV", "/run/vowifi/engine.env")
    try:
        with open(path) as f:
            for line in f:
                if "=" in line:
                    k, v = line.strip().split("=", 1)
                    env[k] = v
    except Exception:
        pass
    return env


def main():
    if len(sys.argv) < 2:
        return
    event = sys.argv[1]
    args = sys.argv[2:]
    env = load_env()
    manager_url = os.environ.get("MANAGER_URL") or env.get("MANAGER_URL", "")
    inst_id = os.environ.get("VOWIFI_ID") or env.get("VOWIFI_ID", "1")
    payload = {"instance": inst_id, "event": event, "args": args}
    # Always append to a local event log so nothing is lost if the manager is down.
    try:
        journal = os.environ.get("VOWIFI_EVENT_LOG", "/logs/events.jsonl")
        os.makedirs(os.path.dirname(journal), exist_ok=True)
        with open(journal, "a") as f:
            f.write(json.dumps(payload) + "\n")
    except Exception:
        pass
    if not manager_url:
        return
    try:
        import requests
        import urllib3
        urllib3.disable_warnings()
        headers = {"X-Engine-Instance": str(inst_id)}
        try:
            with open(os.environ.get("VOWIFI_MANAGER_TOKEN_FILE", "/run/vowifi/manager-token")) as f:
                headers["X-Engine-Token"] = f.read().strip()
        except OSError:
            pass
        session = requests.Session()
        session.trust_env = False
        verify = True
        certificate = os.environ.get("VOWIFI_MANAGER_CERT", "/etc/asterisk/certificate.crt")
        if headers.get("X-Engine-Token") or os.path.isfile(certificate):
            # Engines already mount the same certificate used by the manager. Pin its
            # fingerprint so host.docker.internal works with a self-signed LAN cert.
            with open(certificate) as f:
                pem = re.search(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", f.read(), re.S).group(0)
            fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()
            class PinnedAdapter(requests.adapters.HTTPAdapter):
                def init_poolmanager(self, *args, **kwargs):
                    kwargs['assert_fingerprint'] = fingerprint
                    return super().init_poolmanager(*args, **kwargs)
            if urlsplit(manager_url).scheme != 'https':
                return  # never send the callback credential over plaintext HTTP
            session.mount('https://', PinnedAdapter())
            verify = False  # verification is the exact certificate fingerprint above
        with session:
            session.post(f"{manager_url.rstrip('/')}/api/engine/event",
                         json=payload, headers=headers, timeout=3, verify=verify, allow_redirects=False)
    except Exception:
        pass


if __name__ == "__main__":
    main()
