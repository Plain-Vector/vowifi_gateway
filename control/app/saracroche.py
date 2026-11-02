"""Opt-in client for the public Android protocol. Never receives caller numbers."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import re
import time
from urllib.parse import urljoin, urlsplit

import requests

from . import store, config as cfg

HOST = 'https://app.saracroche.org'
CATALOG_URL = HOST + '/api/v2/lists'
LICENSE = 'CC BY-NC-SA 4.0'


class ProviderError(Exception):
    """Only sanitized, fixed messages may be returned to the API."""


def options():
    with store._conn() as c:
        row = c.execute("SELECT options FROM blocking_providers WHERE name='saracroche'").fetchone()
    return {'country_codes': 'FR', 'selected_list_ids': None, 'source': 'remote', **json.loads(row[0])}


def enabled():
    from . import blocking
    scopes = ['*', *(str(i['id']) for i in blocking.cfg.list_instances())]
    return any(settings['saracroche'] and settings['mode'] != 'disabled'
               for settings in (blocking.settings(scope)['effective'] for scope in scopes))


def read_response(session, url, headers, limit, deadline):
    target = urlsplit(url)
    if target.scheme != 'https' or target.netloc != 'app.saracroche.org' or target.username or target.fragment:
        raise ProviderError('Rejected download URL outside the Saracroche HTTPS host')
    if time.monotonic() >= deadline:
        raise ProviderError('Saracroche update deadline exceeded')
    try:
        with session.get(url, headers=headers, timeout=(5, 10), stream=True, allow_redirects=False) as response:
            if response.status_code in (401, 403):
                raise ProviderError('Saracroche denied access; check issued API credentials')
            if response.status_code == 429:
                raise ProviderError('Saracroche rate limit reached; retry later')
            if response.status_code != 200:
                raise ProviderError('Saracroche server returned an unsuccessful response')
            data = bytearray()
            for chunk in response.iter_content(16384):
                if time.monotonic() >= deadline:
                    raise ProviderError('Saracroche update deadline exceeded')
                if len(data) + len(chunk) > limit:
                    raise ProviderError('Saracroche response exceeds the download size limit')
                data.extend(chunk)
            return bytes(data)
    except requests.RequestException:
        raise ProviderError('Saracroche network or TLS request failed') from None


def fetch():
    from .blocking_providers import Dataset, MAX_IMPORT_BYTES, parse_android_ndjson
    opts = options()
    if not enabled() or opts['source'] != 'remote':
        raise ProviderError('Enable Saracroche and select the remote source first')
    headers = {'Accept': 'application/json', 'X-Country-Code': opts['country_codes'],
               'User-Agent': 'VoWiFi-Gateway/CallBlocking'}
    key = os.environ.get('VOWIFI_SARACROCHE_API_KEY', '')
    device = os.environ.get('VOWIFI_SARACROCHE_DEVICE_ID', '')
    if bool(key) != bool(device):
        raise ProviderError('Both the issued API key and device ID must be configured')
    if key:
        headers.pop('X-Country-Code')
        headers.update({'X-API-Key': key, 'X-Device-Id': device})
    deadline = time.monotonic() + 90
    with requests.Session() as session:
        session.trust_env = False
        try:
            catalog = json.loads(read_response(session, CATALOG_URL, headers, 1024 * 1024, deadline))
        except (ValueError, RecursionError):
            raise ProviderError('Saracroche catalog is not valid JSON') from None
        if not isinstance(catalog, list) or len(catalog) > 100:
            raise ProviderError('Saracroche catalog has an invalid shape')
        selected_ids = opts['selected_list_ids']
        seen = set(); public_catalog = []; records = []; versions = []
        downloaded = 0
        for item in catalog:
            if not isinstance(item, dict) or type(item.get('id')) is not int or item['id'] <= 0 or item['id'] in seen:
                raise ProviderError('Saracroche catalog contains invalid list identifiers')
            seen.add(item['id'])
            if item.get('channel') != 'phone' or item.get('type') not in ('allow', 'block'):
                continue
            selected = item['id'] in selected_ids if selected_ids is not None else item.get('is_enabled_by_default') is True
            meta = {k: item.get(k) for k in ('id', 'name', 'license', 'type', 'channel', 'version', 'item_count', 'priority')}
            meta['selected'] = selected
            meta['is_enabled_by_default'] = item.get('is_enabled_by_default') is True
            public_catalog.append(meta)
            if not selected:
                continue
            if item.get('license') != LICENSE:
                raise ProviderError('Selected Saracroche list has an unrecognized license; previous database retained')
            count = item.get('item_count'); priority = item.get('priority', 100)
            version = item.get('version'); digest = item.get('hash'); url = item.get('download_url')
            if (type(count) is not int or not 0 <= count <= 1_000_000 or type(priority) is not int
                    or not 0 <= priority <= 100000 or not isinstance(version, str) or len(version) > 128
                    or not isinstance(digest, str) or not re.fullmatch('[0-9a-fA-F]{32}', digest)
                    or not isinstance(url, str)):
                raise ProviderError('Saracroche list metadata is invalid or unsupported')
            if not enabled():
                raise ProviderError('Saracroche was disabled during the update')
            cache_dir = Path(cfg.DATA_DIR) / 'saracroche-cache'
            cache = cache_dir / f"{item['id']}.jsonl"
            content = b''
            try:
                if cache.stat().st_size <= MAX_IMPORT_BYTES:
                    cached = cache.read_bytes()
                    if hashlib.md5(cached, usedforsecurity=False).hexdigest().lower() == digest.lower():
                        content = cached
            except OSError:
                pass
            if not content:
                content = read_response(session, urljoin(HOST, url),
                                        {**headers, 'Accept': 'application/x-ndjson'}, MAX_IMPORT_BYTES, deadline)
            downloaded += len(content)
            if downloaded > 128 * 1024 * 1024:
                raise ProviderError('Saracroche aggregate download size limit exceeded')
            # MD5 matches current catalog semantics; authenticity relies on verified HTTPS.
            if hashlib.md5(content, usedforsecurity=False).hexdigest().lower() != digest.lower():
                raise ProviderError('Saracroche list checksum mismatch; previous database retained')
            if sum(bool(line.strip()) for line in content.splitlines()) != count:
                raise ProviderError('Saracroche list entry count mismatch')
            try:
                parsed = parse_android_ndjson(content) if count else set()
            except ValueError:
                raise ProviderError('Saracroche list contains unsupported patterns; previous database retained') from None
            # Cache only content that passed hash, count and format validation.
            cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd, temporary = tempfile.mkstemp(prefix='.download-', dir=cache_dir)
            try:
                with os.fdopen(fd, 'wb') as handle:
                    handle.write(content)
                os.replace(temporary, cache)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            records.extend((number, kind, item['type'], priority) for _, number, kind in parsed)
            if len(records) > 2_000_000:
                raise ProviderError('Saracroche aggregate entry limit exceeded')
            versions.append((item['id'], version, digest))
        if selected_ids is not None and not set(selected_ids).issubset({i['id'] for i in public_catalog}):
            raise ProviderError('A selected Saracroche phone list is no longer available')
        if not records:
            raise ProviderError('No usable Saracroche phone lists selected')
        version = 'catalog:' + hashlib.sha256(json.dumps(versions).encode()).hexdigest()[:24]
        return Dataset(version, [], records, public_catalog, LICENSE)
