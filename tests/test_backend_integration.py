import asyncio
import base64
import json

from fastapi.testclient import TestClient

from app import blocking, blocking_providers, store, auth
from app.main import app


def test_full_app_filter_callback_and_preserved_calls(db):
    client = TestClient(app)
    client.headers.update({"X-Engine-Instance": "1", "X-Engine-Token": auth.engine_token("1")})
    blocking.save_settings('*', {'mode': 'enforce', 'block_unavailable': True})
    result = blocking.lookup('1', '')
    report = {'peer': '', 'call_id': 'integration.1', 'ts': 12345, 'decision': result}
    payload = {'instance': '1', 'event': 'call_filter',
               'args': [base64.b64encode(json.dumps(report).encode()).decode()]}
    assert client.post('/api/engine/event', json=payload).status_code == 200
    assert client.post('/api/engine/event', json=payload).status_code == 200
    calls = store.list_calls('1')
    assert len(calls) == 1 and calls[0]['status'] == 'blocked' and calls[0]['end_ts']
    assert blocking.events()[0]['decision']['source'] == 'unavailable'
    assert client.post('/api/engine/event', json={**payload, 'args': ['invalid']}).status_code == 422
    # Monitor does not create a rejected entry; original call_in / call_result remain responsible.
    blocking.save_settings('*', {'mode': 'monitor', 'block_unavailable': True})
    report['call_id'] = 'integration.2'
    report['decision'] = blocking.lookup('1', '')
    payload['args'] = [base64.b64encode(json.dumps(report).encode()).decode()]
    client.post('/api/engine/event', json=payload)
    assert len(store.list_calls('1')) == 1
    assert client.post('/api/engine/event', json={'instance': '1', 'event': 'call_in', 'args': ['']}).status_code == 200
    assert client.post('/api/engine/event', json={'instance': '1', 'event': 'call_result', 'args': ['in', '', 'NOANSWER', '19']}).status_code == 200
    assert any(c['status'] == 'missed' for c in store.list_calls('1'))
    client.headers.update({"X-Engine-Instance": "2", "X-Engine-Token": auth.engine_token("2")})
    assert client.post('/api/engine/event', json={'instance': '2', 'event': 'call_out', 'args': ['+442071234567']}).status_code == 200
    assert client.post('/api/engine/event', json={'instance': '2', 'event': 'call_result', 'args': ['out', '+442071234567', 'ANSWER', '16']}).status_code == 200
    assert store.list_calls('2')[0]['status'] == 'answered'


def test_scheduler_runs_due_source_and_can_be_cancelled(db, monkeypatch):
    called = []
    blocking.save_settings('*', {'saracroche': True})
    monkeypatch.setattr(blocking_providers.Saracroche, 'supported', True)
    monkeypatch.setattr(blocking_providers, 'update', lambda name: called.append(name))
    async def scenario():
        task = asyncio.create_task(blocking_providers.scheduler())
        for _ in range(100):
            await asyncio.sleep(0.001)
            if called:
                break
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    asyncio.run(scenario())
    assert called == ['saracroche']
