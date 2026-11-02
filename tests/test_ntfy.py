from unittest.mock import Mock, patch

import pytest
from app import config as cfg, notify_push as n


def ntfy(**patches):
    return {**cfg.DEFAULTS['settings']['ntfy'], 'enabled': True, 'topic':'private-test', **patches}


def test_ntfy_unicode_token_privacy_and_event_dispatch():
    payload = n.build_payload(n.EV_INCOMING_SMS, {'id':'1','name':'Линия'}, '+33612345678', 'Тестовое сообщение')
    with patch.object(n.requests, 'post', return_value=Mock(status_code=200)) as post:
        assert n.send_ntfy(ntfy(token='test-only'), payload)['ok']
        args = post.call_args.kwargs
        assert args['headers']['Authorization'] == 'Bearer test-only'
        assert args['headers']['Cache'] == 'no'
        assert 'Тестовое' in args['json']['message']
        assert args['verify'] is True and args['allow_redirects'] is False
        n.send_ntfy(ntfy(include_sms_body=False), payload)
        assert 'Тестовое' not in post.call_args.kwargs['json']['message']
        post.reset_mock()
        n.dispatch({'ntfy':ntfy(events={'incoming_sms':False})}, n.EV_INCOMING_SMS, {'id':'1'}, '', 'not sent')
        post.assert_not_called()
        n.dispatch({'ntfy':ntfy()}, n.EV_INCOMING_SMS, {'id':'1'}, '', 'sent')
        post.assert_called_once()


def test_ntfy_validation_failure_and_redacted_settings(db):
    cfg.update_settings({'ntfy':ntfy(token='test-only')})
    public = cfg.public_settings()['ntfy']
    assert public['token'] == '' and public['has_token']
    cfg.update_settings({'ntfy':public})
    assert cfg.get_settings()['ntfy']['token'] == 'test-only'
    cfg.update_settings({'ntfy':{**public,'clear_token':True}})
    assert cfg.get_settings()['ntfy']['token'] == ''
    with pytest.raises(ValueError): n.validate_ntfy(ntfy(server='http://example.com',token='secret'))
    with pytest.raises(ValueError): n.validate_ntfy(ntfy(topic='../bad'))
    with patch.object(n.requests, 'post', return_value=Mock(status_code=401,text='SECRET')):
        assert n.send_ntfy(ntfy(), n.build_payload(n.EV_INCOMING_CALL, {'id':'1'}, '', None)) == {'ok':False,'error':'ntfy returned HTTP 401'}


def test_dispatch_push_does_not_drop_ntfy_only_configuration(db, monkeypatch):
    import asyncio
    from app import main
    sent = []
    monkeypatch.setattr(cfg, 'get_settings', lambda: {'ntfy': ntfy()})
    monkeypatch.setattr(n, 'dispatch', lambda *args: sent.append(args))
    async def scenario():
        main._dispatch_push(n.EV_INCOMING_SMS, '1', 'synthetic', 'synthetic SMS')
        for _ in range(20):
            await asyncio.sleep(.001)
            if sent: break
    asyncio.run(scenario())
    assert sent and sent[0][1] == n.EV_INCOMING_SMS
