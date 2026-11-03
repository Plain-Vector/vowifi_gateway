"""Standalone CI smoke inside the built Engine image; no SIM or real IMS registration.

Exercises the actual Asterisk Message channel/AGI, SIP client forwarding and synthetic
SMS-over-IMS RP-DATA -> SIP 200 + RP-ACK. Never run against a production Asterisk.
"""
import base64
from contextlib import closing
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import tempfile
import time
import uuid

from jinja2 import Environment, FileSystemLoader


def main():
    with tempfile.TemporaryDirectory(prefix='vowifi-sms-ci-') as temporary:
        root = Path(temporary)
        for name in ('etc','run','logs','spool','keys'):
            (root/name).mkdir()
        Path('/logs').mkdir(exist_ok=True)
        config = root/'etc'
        (config/'asterisk.conf').write_text(f'''[directories]
astetcdir => {config}
astmoddir => /usr/lib/asterisk/modules
astvarlibdir => /var/lib/asterisk
astdbdir => {root}
astkeydir => {root/'keys'}
astdatadir => /var/lib/asterisk
astagidir => /usr/local/bin
astspooldir => {root/'spool'}
astrundir => {root/'run'}
astlogdir => {root/'logs'}
[options]
verbose = 3
debug = 0
''')
        (config/'modules.conf').write_text('[modules]\nautoload=yes\nnoload=chan_sip.so\n')
        (config/'logger.conf').write_text('[logfiles]\nconsole => notice,warning,error,verbose\n')
        (config/'pjsip.conf').write_text('''[global]
type=global
endpoint_identifier_order=ip,username
[ims-tcp]
type=transport
protocol=tcp
bind=127.0.0.1:5088
[local-udp]
type=transport
protocol=udp
bind=127.0.0.1:5089
[ims]
type=endpoint
transport=ims-tcp
context=volte_ims
message_context=volte_ims_msg
disallow=all
allow=ulaw
from_user=synthetic
from_domain=localhost
smsc_uri=sip:smsc@127.0.0.1
[ims-identify]
type=identify
endpoint=ims
match=127.0.0.1
[desk]
type=endpoint
transport=local-udp
context=from-local
aors=desk
disallow=all
allow=ulaw
[desk]
type=aor
contact=sip:desk@127.0.0.1:5099
''')
        rendered = Environment(loader=FileSystemLoader('/opt/vowifi/templates')).get_template('extensions.conf.j2').render(
            external_accounts=[{'username':'desk'}],webrtc_enable=False,webrtc_user='browser',ring_timeout=35,msisdn='synthetic',realm='localhost')
        (config/'extensions.conf').write_text('[general]\nstatic=yes\n'+rendered)
        journal=root/'events.jsonl'; snapshot=root/'blocking.sqlite'
        env={**os.environ,'VOWIFI_BLOCKING_SNAPSHOT':str(snapshot),'VOWIFI_EVENT_LOG':str(journal),
             'VOWIFI_ENV':str(root/'missing.env'),'MANAGER_URL':'','VOWIFI_ID':'1'}
        log=(root/'asterisk.log').open('w+')
        process=subprocess.Popen(['asterisk','-f','-g','-q','-C',str(config/'asterisk.conf')],env=env,stdout=log,stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                ready=subprocess.run(['asterisk','-C',str(config/'asterisk.conf'),'-rx','core waitfullybooted'],capture_output=True)
                if ready.returncode == 0: break
                if process.poll() is not None: raise AssertionError('Asterisk exited')
                time.sleep(.1)
            else: raise AssertionError('Asterisk did not boot')
            with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sink:
                sink.bind(('127.0.0.1',5099)); sink.settimeout(2)
                for binary in (False,True):
                    for mode in ('disabled','monitor','enforce','broken'):
                        if snapshot.exists(): snapshot.unlink()
                        if mode != 'broken':
                            with closing(sqlite3.connect(snapshot)) as c, c:
                                c.executescript('CREATE TABLE settings(key TEXT,value TEXT); CREATE TABLE rules(kind TEXT,number TEXT,match_type TEXT,priority INTEGER); CREATE TABLE sms_rules(kind TEXT,number TEXT,match_type TEXT,priority INTEGER); CREATE INDEX sms_idx ON sms_rules(kind,number);')
                                c.executemany('INSERT INTO settings VALUES(?,?)',[('mode','enforce'),('sms_mode',mode)])
                                c.execute("INSERT INTO sms_rules VALUES('block','666','exact',0)")
                        count=len(journal.read_text().splitlines()) if journal.exists() else 0
                        body_log=Path('/logs/messages.txt')
                        body_log_size=body_log.stat().st_size if body_log.exists() else 0
                        with socket.create_connection(('127.0.0.1',5088),timeout=3) as transport:
                            transport.settimeout(3)
                            port=transport.getsockname()[1]; identity=uuid.uuid4().hex
                            if binary:
                                # SMS-DELIVER: OA=666, GSM7 body='hello', valid synthetic timestamp.
                                tpdu=bytes.fromhex('00038166f600006211202143650005e8329bfd06')
                                body=bytes([1,42,0,0,len(tpdu)])+tpdu
                                content_type='application/vnd.3gpp.sms'
                            else:
                                body=b'hello'; content_type='text/plain'
                            request=(f'MESSAGE sip:synthetic@127.0.0.1:5088 SIP/2.0\r\nVia: SIP/2.0/TCP 127.0.0.1:{port};branch=z9hG4bK{identity}\r\n'
                                f'From: <sip:666@localhost>;tag={identity}\r\nTo: <sip:synthetic@localhost>\r\nCall-ID: {identity}\r\nCSeq: 1 MESSAGE\r\n'
                                f'P-Asserted-Identity: <sip:smsc@127.0.0.1:{port};transport=tcp>\r\nMax-Forwards: 70\r\n'
                                f'Content-Type: {content_type}\r\nContent-Length: {len(body)}\r\n\r\n').encode()+body
                            transport.sendall(request)
                            buffer=b''
                            def read_packet():
                                nonlocal buffer
                                while b'\r\n\r\n' not in buffer:
                                    chunk=transport.recv(65536)
                                    if not chunk: raise EOFError('SIP TCP closed')
                                    buffer+=chunk
                                headers,tail=buffer.split(b'\r\n\r\n',1)
                                length=int(re.search(br'(?im)^Content-Length:\s*(\d+)',headers)[1])
                                while len(tail)<length:
                                    chunk=transport.recv(65536)
                                    if not chunk: raise EOFError('SIP TCP closed')
                                    tail+=chunk
                                payload=tail[:length]; buffer=tail[length:]
                                return headers,payload
                            headers,payload=read_packet()
                            assert headers.startswith(b'SIP/2.0 '+(b'200' if binary else b'202')),headers
                            if binary:
                                headers,payload=read_packet()
                                assert headers.startswith(b'MESSAGE ') and payload[:2]==bytes([2,42]),(headers,payload)
                                # Confirm the generated RP-ACK as an IP-SM-GW would.
                                reply=[b'SIP/2.0 202 Accepted']+[line for line in headers.split(b'\r\n')[1:]
                                    if line.lower().startswith((b'via:',b'from:',b'to:',b'call-id:',b'cseq:'))]
                                transport.sendall(b'\r\n'.join(reply)+b'\r\nContent-Length: 0\r\n\r\n')
                            for _ in range(100):
                                events=[json.loads(line) for line in journal.read_text().splitlines()] if journal.exists() else []
                                if len(events)>count: break
                                time.sleep(.02)
                            else: raise AssertionError('No engine notification')
                            event=events[-1]
                            if mode=='enforce':
                                assert event['event']=='sms_filter',event
                                with_timeout=False
                                try: sink.recvfrom(65536)
                                except socket.timeout: with_timeout=True
                                assert with_timeout,'Suppressed SMS forwarded to SIP client'
                                assert 'hello' not in json.dumps(event)
                                assert (body_log.stat().st_size if body_log.exists() else 0)==body_log_size, 'Suppressed SMS body logged'
                            else:
                                assert event['event']=='sms_in',event
                                forwarded,address=sink.recvfrom(65536)
                                assert b'hello' in forwarded,forwarded
                                # Complete the local SIP transaction to avoid retransmission noise.
                                head=forwarded.split(b'\r\n\r\n')[0]
                                reply=[b'SIP/2.0 200 OK']+[line for line in head.split(b'\r\n')[1:]
                                    if line.lower().startswith((b'via:',b'from:',b'to:',b'call-id:',b'cseq:'))]
                                sink.sendto(b'\r\n'.join(reply)+b'\r\nContent-Length: 0\r\n\r\n',address)
                                verdict=json.loads(base64.b64decode(event['args'][2]))['decision']
                                assert verdict['action']=='allow',verdict
                            print(f'Asterisk SMS smoke: binary={binary} mode={mode} passed',flush=True)
            assert process.poll() is None
        except Exception:
            log.flush(); log.seek(0); print(log.read(), flush=True)
            raise
        finally:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
            log.seek(0)
            if process.returncode not in (0,-15): print(log.read())
            log.close()


if __name__=='__main__':
    main()
