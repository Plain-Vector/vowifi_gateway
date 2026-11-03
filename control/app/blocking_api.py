"""Validated management API. Inherits gateway proxy authentication, optional extra token."""
import os
import re
import secrets
import sqlite3
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import blocking, blocking_providers as providers, config as cfg
from .blocking_match import normalize


def access(request: Request):
    token = os.environ.get('VOWIFI_BLOCKING_TOKEN', '')
    if token and not secrets.compare_digest(request.headers.get('X-Blocking-Token', ''), token):
        raise HTTPException(401, 'Call Blocking access token required')
    if request.method not in ('GET', 'HEAD'):
        origin = request.headers.get('origin')
        if origin and urlsplit(origin).netloc != request.headers.get('host'):
            raise HTTPException(403, 'Cross-origin write rejected')
        if request.headers.get('sec-fetch-site') == 'cross-site':
            raise HTTPException(403, 'Cross-site write rejected')


router = APIRouter(prefix='/api/blocking', dependencies=[Depends(access)])


def scope_check(scope):
    if scope != '*' and not cfg.get_instance(scope):
        raise HTTPException(404, 'Unknown instance')
    return scope


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Settings(Strict):
    mode: Literal['disabled', 'monitor', 'enforce'] | None = None
    sms_mode: Literal['disabled', 'monitor', 'enforce'] | None = None
    arcep: bool | None = None
    saracroche: bool | None = None
    block_withheld: bool | None = None
    block_unavailable: bool | None = None


class Rule(Strict):
    scope: str = Field(default='*', max_length=64)
    kind: Literal['allow', 'block']
    number: str = Field(min_length=1, max_length=128)
    match_type: Literal['exact', 'prefix'] = 'exact'
    description: str = Field(default='', max_length=500)
    enabled: bool = True
    communication: Literal['calls', 'sms', 'both'] = 'calls'

    def normalized(self):
        scope_check(self.scope)
        value = self.model_dump()
        number = self.number.strip()
        # Match the existing engine's short-code contract; never turn service codes into +33.
        short_exact = self.match_type == 'exact' and re.fullmatch(r'[1-9][0-9]{1,5}', number)
        value['number'] = number if short_exact else normalize(self.number, prefix=self.match_type == 'prefix')
        if not value['number']:
            raise HTTPException(422, 'Use an exact 2-6 digit service number starting 1-9, a French number or international +/00 number; no wildcards or regex')
        if 'communication' not in self.model_fields_set:
            value.pop('communication', None)
        return value


class Lookup(Strict):
    communication: Literal['calls', 'sms'] = 'calls'
    instance: str = Field(max_length=64)
    number: str = Field(default='', max_length=128)
    presentation: Literal['allowed', 'prohib', 'unavailable'] = 'allowed'


class UpdateSettings(Strict):
    auto_update: bool = True
    interval_hours: int = Field(default=24, ge=1, le=720)
    country_codes: str = Field(default='FR', pattern=r'^[A-Z]{2}(,[A-Z]{2}){0,9}$')
    selected_list_ids: list[int] | None = Field(default=None, max_length=100)
    source: Literal['remote', 'local'] = 'remote'

    @field_validator('selected_list_ids')
    @classmethod
    def valid_ids(cls, ids):
        if ids is not None and (not ids or any(i <= 0 for i in ids) or len(ids) != len(set(ids))):
            raise ValueError('Select one or more unique positive list IDs, or null for Android defaults')
        return ids


@router.get('/settings')
def get_settings(scope: str = '*'):
    return blocking.settings(scope_check(scope))


@router.put('/settings')
def put_settings(body: Settings, scope: str = '*'):
    scope_check(scope)
    # PUT replaces this scope's overrides; null means inherit, empty object resets inheritance.
    return blocking.save_settings(scope, body.model_dump(exclude_none=True))


@router.get('/rules')
def get_rules(scope: str = '*', kind: Literal['allow', 'block'] | None = None,
              search: str = Query(default='', max_length=128), enabled: bool | None = None):
    return {'rules': blocking.rules(scope_check(scope), kind, search, enabled)}


def write_rule(body, rid=None):
    try:
        return {'id': blocking.save_rule(body.normalized(), rid)}
    except sqlite3.IntegrityError:
        raise HTTPException(409, 'This rule already exists')
    except KeyError:
        raise HTTPException(404, 'Rule not found')


@router.post('/rules', status_code=201)
def add_rule(body: Rule):
    return write_rule(body)


@router.put('/rules/{rid}')
def edit_rule(rid: int, body: Rule):
    return write_rule(body, rid)


@router.delete('/rules/{rid}')
def delete_rule(rid: int):
    try:
        blocking.delete_rule(rid)
    except KeyError:
        raise HTTPException(404, 'Rule not found')
    return {'ok': True}


@router.post('/lookup')
def lookup(body: Lookup):
    scope_check(body.instance)
    return blocking.lookup(body.instance, body.number, body.presentation, body.communication)


@router.get('/events')
def events(instance: str | None = None, limit: int = Query(100, ge=1, le=500),
           offset: int = Query(0, ge=0), decision: Literal['allowed', 'rejected', 'would_block'] | None = None,
           source: Literal['none', 'whitelist', 'blacklist', 'arcep', 'saracroche', 'withheld', 'unavailable', 'error'] | None = None,
           since: int | None = Query(None, ge=0), until: int | None = Query(None, ge=0)):
    if instance:
        scope_check(instance)
    if since is not None and until is not None and since > until:
        raise HTTPException(422, 'Start time must be before end time')
    rows = blocking.events(instance, limit + 1, offset, decision, source, since, until)
    return {'events': rows[:limit], 'has_more': len(rows) > limit}


@router.get('/providers')
def provider_status():
    return {'providers': providers.status()}


@router.put('/providers/saracroche')
def provider_config(body: UpdateSettings):
    # Preserve omitted fields for existing clients that save one provider section.
    providers.configure(**body.model_dump(exclude_unset=True))
    return provider_status()


@router.post('/providers/saracroche/import')
async def import_saracroche(request: Request, version: str = Query('', max_length=128),
                             license_info: str = Query('', max_length=500)):
    content = bytearray()
    async for chunk in request.stream():
        if len(content) + len(chunk) > providers.MAX_IMPORT_BYTES:
            raise HTTPException(413, 'Database exceeds 64 MiB')
        content.extend(chunk)
    import asyncio
    try:
        return await asyncio.to_thread(providers.import_android, bytes(content), version, license_info)
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@router.post('/providers/saracroche/update')
def update_now():
    return providers.update()


class FilterDecision(Strict):
    mode: Literal['disabled', 'monitor', 'enforce']
    normalized: str | None = Field(default=None, max_length=32)
    would_block: bool
    action: Literal['allow', 'reject']
    source: Literal['none', 'whitelist', 'blacklist', 'arcep', 'saracroche', 'withheld', 'unavailable', 'error']
    rule: str = Field(max_length=128)
    reason: str = Field(max_length=500)


class FilterReport(Strict):
    peer: str = Field(max_length=128)
    call_id: str = Field(min_length=1, max_length=128)
    ts: int = Field(ge=0)
    decision: FilterDecision


class QuickRule(Rule):
    action: Literal['block', 'unblock'] = 'block'
    kind: Literal['block'] = 'block'
    match_type: Literal['exact'] = 'exact'


@router.post('/quick-rule')
def quick_rule(body: QuickRule):
    value = body.normalized()
    value.setdefault('communication', 'calls')
    try:
        blocking.quick_rule(value, body.action)
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    return {'ok':True}


@router.get('/sms-events')
def sms_events(instance: str | None = None, decision: Literal['allowed', 'suppressed'] | None = None,
               limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
    if instance:
        scope_check(instance)
    rows = blocking.sms_events(instance, decision, limit + 1, offset)
    return {'events':rows[:limit], 'has_more':len(rows) > limit}


class SMSReport(Strict):
    event_id: str = Field(min_length=1, max_length=128)
    peer: str = Field(max_length=128)
    ts: int = Field(ge=0)
    decision: FilterDecision
