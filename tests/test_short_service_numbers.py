"""Personal short codes use the existing incoming matcher; outgoing routes stay separate."""
import re
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from jinja2 import Environment, FileSystemLoader, StrictUndefined
import pytest

from app import auth, blocking, store
from app.main import app, hub
from app.ami import AmiClient
from conftest import ROOT


@pytest.fixture
def client(db):
    client = TestClient(app, base_url='https://testserver')
    result = client.post('/api/auth/setup', json={'username':'admin', 'password':'synthetic-service-test-only',
                         'setup_code': (db/'auth/setup-code').read_text()})
    assert result.status_code == 200
    return client


def add(client, number, kind='allow', scope='*', match_type='exact'):
    return client.post('/api/blocking/rules', json={'number':number, 'kind':kind, 'scope':scope, 'match_type':match_type})


@pytest.mark.parametrize('number', ['15', '666', '1023', '123456'])
@pytest.mark.parametrize('scope', ['*', '1'])
def test_exact_service_rules_preserve_digits_and_whitelist_precedence(client, number, scope):
    blocking.save_settings('*', {'mode':'enforce', 'arcep':True, 'saracroche':True})
    assert add(client, number, 'block').status_code == 201
    # Provider short-code block data, in the same format supported before this fix.
    with store._conn() as c:
        c.execute('INSERT INTO blocking_imports(provider,number,match_type) VALUES(?,?,?)', ('saracroche', number, 'exact'))
    assert blocking.lookup('1', number)['action'] == 'reject'
    result = add(client, number, 'allow', scope)
    assert result.status_code == 201
    rules = client.get('/api/blocking/rules', params={'scope':scope, 'kind':'allow'}).json()['rules']
    assert rules[0]['number'] == number and rules[0]['match_type'] == 'exact'
    verdict = client.post('/api/blocking/lookup', json={'instance':'1','number':number}).json()
    assert verdict['normalized'] == number
    assert verdict['source'] == 'whitelist' and verdict['action'] == 'allow'
    assert blocking.lookup('2', number)['action'] == ('allow' if scope == '*' else 'reject')
    # Exact codes do not become a prefix for longer codes.
    assert blocking.lookup('1', number + '9')['source'] != 'whitelist'
    blocking.init()
    assert blocking.lookup('1', number)['action'] == 'allow'


@pytest.mark.parametrize('number', ['1','1234567','0123','00','66 6','66-6','66*','6#6','٦٦٦','ABC',''])
def test_invalid_short_inputs_are_rejected_without_writing(client, number):
    assert add(client, number).status_code == 422
    assert client.get('/api/blocking/rules').json()['rules'] == []


@pytest.mark.parametrize('number,expected', [('0612345678','+33612345678'),('+33612345678','+33612345678'),
                                            ('00442071234567','+442071234567')])
def test_regular_number_normalization_is_preserved(client, number, expected):
    assert add(client, number).status_code == 201
    assert client.get('/api/blocking/rules').json()['rules'][0]['number'] == expected


def test_short_prefix_is_not_accepted_and_whitelist_update_delete_work(client):
    assert add(client, '666', match_type='prefix').status_code == 422
    rid = add(client, '666').json()['id']
    response = client.put(f'/api/blocking/rules/{rid}', json={'number':'1023','kind':'allow','scope':'1','match_type':'exact'})
    assert response.status_code == 200
    assert client.get('/api/blocking/rules?scope=1').json()['rules'][0]['number'] == '1023'
    assert client.delete(f'/api/blocking/rules/{rid}').status_code == 200
    assert client.get('/api/blocking/rules?scope=1').json()['rules'] == []


@pytest.mark.parametrize('mode', ['disabled','monitor','enforce'])
@pytest.mark.parametrize('number', ['666','1023','+33612345678'])
def test_outgoing_control_calls_bypass_incoming_filter_even_if_destination_blocked(client, monkeypatch, mode, number):
    blocking.save_settings('*', {'mode':mode})
    assert add(client, number, 'block').status_code == 201
    def no_lookup(*args, **kwargs):
        pytest.fail('Outgoing call must not consult incoming filtering')
    monkeypatch.setattr(blocking, 'lookup', no_lookup)
    ami = type('SyntheticAMI', (), {'originate':AsyncMock(return_value={'ok':True})})()
    monkeypatch.setattr(hub, 'ami_for', AsyncMock(return_value=ami))
    response = client.post('/api/instances/1/call', json={'to':number,'from_endpoint':'desk'})
    assert response.status_code == 200 and response.json()['ok']
    ami.originate.assert_awaited_once_with(number, 'desk')
    assert store.list_calls('1')[0]['direction'] == 'out'
    assert store.list_calls('1')[0]['peer'] == number
    assert blocking.events() == []


def test_rendered_outgoing_context_accepts_service_codes_and_has_no_filter():
    env = Environment(loader=FileSystemLoader(ROOT/'engine/templates'), undefined=StrictUndefined)
    rendered = env.get_template('extensions.conf.j2').render(external_accounts=[{'username':'desk'}],
        webrtc_enable=True,webrtc_user='browser',ring_timeout=35,msisdn='+33612345678',realm='ims.example')
    contexts = dict(re.findall(r'^\[([^]]+)\]\n(.*?)(?=^\[|\Z)',rendered,re.M|re.S))
    assert rendered.count('AGI(/usr/local/bin/call_filter.py)') == 1
    assert 'AGI(/usr/local/bin/call_filter.py)' in contexts['volte_ims']
    outgoing = contexts['from-local']
    assert 'AGI(' not in outgoing and 'CB_REJECT' not in outgoing
    assert 'Dial(PJSIP/${EXTEN}@volte_ims,35)' in outgoing
    assert 'exten => _[+0-9].,1,' in outgoing
    # The existing Asterisk pattern's first digit and >=1 trailing characters admit
    # both service codes; this is structural evidence, not a live Asterisk/SIM call.
    for number in ('666','1023','+33612345678'):
        assert re.fullmatch(r'[+0-9].+',number)
    pjsip = (ROOT/'engine/templates/pjsip.conf.j2').read_text()
    assert re.search(r'\[endpoint-local\]\(!\).*?\ncontext=from-local\n',pjsip,re.S)


@pytest.mark.parametrize('number', ['666', '1023', '+33612345678'])
def test_ami_originate_preserves_destination_and_uses_outgoing_context(number):
    import asyncio
    ami = AmiClient('1', 'localhost', 5038, 'synthetic', 'synthetic', 'ims.example')
    ami._connected = True
    ami._mgr = object()
    ami._action = AsyncMock(return_value={'Response':'Success'})
    assert asyncio.run(ami.originate(number, 'desk'))['ok']
    action = ami._action.call_args.args[0]
    assert action['Exten'] == number
    assert action['Context'] == 'from-local'
    assert action['Channel'] == 'PJSIP/desk'
