"""Validated management API. Inherits gateway proxy authentication, optional extra token."""
import os
import secrets
import sqlite3
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

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

    def normalized(self):
        scope_check(self.scope)
        value = self.model_dump()
        value['number'] = normalize(self.number, prefix=self.match_type == 'prefix')
        if not value['number']:
            raise HTTPException(422, 'Use a French number or international +/00 number; no wildcards or regex')
        return value


class Lookup(Strict):
    instance: str = Field(max_length=64)
    number: str = Field(default='', max_length=128)
    presentation: Literal['allowed', 'prohib', 'unavailable'] = 'allowed'


class UpdateSettings(Strict):
    auto_update: bool = True
    interval_hours: int = Field(default=24, ge=1, le=720)


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
    return blocking.lookup(body.instance, body.number, body.presentation)


@router.get('/events')
def events(instance: str | None = None, limit: int = Query(100, ge=1, le=500),
           offset: int = Query(0, ge=0)):
    if instance:
        scope_check(instance)
    return {'events': blocking.events(instance, limit, offset)}


@router.get('/providers')
def provider_status():
    return {'providers': providers.status()}


@router.put('/providers/saracroche')
def provider_config(body: UpdateSettings):
    providers.configure(body.auto_update, body.interval_hours)
    return provider_status()


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
