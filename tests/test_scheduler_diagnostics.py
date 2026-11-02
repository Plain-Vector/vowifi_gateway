import asyncio
import logging
import sqlite3

import pytest

from app import blocking_providers as providers


def test_scheduler_logs_sqlite_failure_and_continues_without_exposing_credentials(monkeypatch, caplog):
    calls = 0
    def status():
        nonlocal calls
        calls += 1
        if calls == 1:
            try:
                raise RuntimeError('https://user:secret@example.invalid/list?token=private-token')
            except RuntimeError as error:
                raise sqlite3.OperationalError('unable to open database file') from error
        return []
    async def tick(_):
        if calls >= 2:
            raise asyncio.CancelledError
    monkeypatch.setattr(providers, 'status', status)
    monkeypatch.setattr(providers.asyncio, 'sleep', tick)
    with caplog.at_level(logging.WARNING):
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(providers.scheduler())
    assert calls == 2
    assert 'OperationalError: unable to open database file' in caplog.text
    assert 'RuntimeError' in caplog.text and 'test_scheduler_diagnostics.py' in caplog.text
    for secret in ('secret', 'private-token', 'https://user', 'example.invalid'):
        assert secret not in caplog.text


def test_unknown_exception_text_is_not_logged():
    try:
        raise sqlite3.OperationalError('SQL contains secret-token')
    except sqlite3.Error as error:
        diagnostic = providers._failure_details(error)
    assert 'OperationalError' in diagnostic
    assert 'secret-token' not in diagnostic
