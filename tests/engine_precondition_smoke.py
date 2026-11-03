"""Standalone actual-Asterisk IMS precondition regression, run only in CI Engine.

No SIM, carrier connection, production config, or real audio destination is used.
"""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
import uuid


class Peer:
    def __init__(self, address):
        self.sock=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
        self.sock.bind((address,0)); self.sock.settimeout(5)
        self.sock.connect(('127.0.0.1',5088))
        self.port=self.sock.getsockname()[1]; self.address=address; self.buffer=b''
        self.call_id=uuid.uuid4().hex; self.tag=uuid.uuid4().hex; self.remote_to=None

    def send(self,method,cseq=1,body='',extra=None,initial=False):
        to='<sip:test@localhost>' if initial or method=='CANCEL' or not self.remote_to else self.remote_to
        branch_method='INVITE' if method in ('CANCEL','ACK') else method
        headers=[f'{method} sip:test@127.0.0.1:5088 SIP/2.0',
            f'Via: SIP/2.0/TCP {self.address}:{self.port};branch=z9hG4bK{self.call_id}{branch_method}',
            f'From: <sip:synthetic@localhost>;tag={self.tag}',f'To: {to}',
            f'Call-ID: {self.call_id}',f'CSeq: {cseq} {method}',
            f'Contact: <sip:synthetic@{self.address}:{self.port};transport=tcp>',
            'Max-Forwards: 70','Allow: INVITE, ACK, CANCEL, PRACK, UPDATE, BYE',
            'Supported: 100rel']
        headers.extend(extra or [])
        if body: headers.append('Content-Type: application/sdp')
        encoded=body.encode();headers.append(f'Content-Length: {len(encoded)}')
        self.sock.sendall(('\r\n'.join(headers)+'\r\n\r\n').encode()+encoded)

    def read(self,timeout=5):
        self.sock.settimeout(timeout)
        while b'\r\n\r\n' not in self.buffer:
            chunk=self.sock.recv(65536)
            if not chunk: raise EOFError('SIP TCP closed')
            self.buffer+=chunk
        raw,tail=self.buffer.split(b'\r\n\r\n',1)
        lines=raw.decode().split('\r\n');headers={}
        for line in lines[1:]:
            key,value=line.split(':',1);headers.setdefault(key.lower(),[]).append(value.strip())
        length=int(headers.get('content-length',['0'])[0])
        while len(tail)<length:
            chunk=self.sock.recv(65536)
            if not chunk: raise EOFError('SIP TCP closed')
            tail+=chunk
        body=tail[:length].decode(); self.buffer=tail[length:]
        if lines[0].startswith('SIP/2.0') and 'to' in headers:
            self.remote_to=headers['to'][0]
        return {'start':lines[0],'headers':headers,'body':body}

    def until(self,code,method,limit=15):
        packets=[]
        for _ in range(limit):
            packet=self.read();packets.append(packet)
            if packet['start'].startswith(f'SIP/2.0 {code} ') and packet['headers'].get('cseq',[''])[0].endswith(' '+method):
                return packet,packets
        raise AssertionError(f'Expected {code} for {method}: {packets}')

    def cancel(self):
        self.send('CANCEL',1)
        seen=set()
        for _ in range(15):
            packet=self.read()
            if packet['start'].startswith('SIP/2.0 200 ') and packet['headers']['cseq'][0].endswith(' CANCEL'): seen.add('cancel')
            if packet['start'].startswith('SIP/2.0 487 '):
                seen.add('invite'); self.send('ACK',1)
            if seen=={'cancel','invite'}: return
        raise AssertionError('CANCEL did not terminate the synthetic call')

    def close(self): self.sock.close()


def sdp(complete=False):
    status='sendrecv' if complete else 'none'
    return ('v=0\r\no=- 1 '+('2' if complete else '1')+' IN IP4 127.0.0.2\r\n'
        's=Synthetic IMS regression\r\nc=IN IP4 127.0.0.2\r\nt=0 0\r\n'
        'm=audio 40000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=sendrecv\r\n'
        f'a=curr:qos local {status}\r\na=curr:qos remote {status}\r\n'
        'a=des:qos mandatory local sendrecv\r\na=des:qos mandatory remote sendrecv\r\n')


def main():
    manifest=Path('/opt/vowifi/ims-build-manifest.txt').read_text()
    assert 'd231cb2c658545773fcd5eb9de787219b9ef6566' in manifest
    assert '20537ab1e6beb2baf9ec15599e0217a601cf7ce5' in manifest
    assert '01_precondition_capability.py' in manifest
    source=Path('/home/asterisk-build/asterisk/res/res_pjsip_session.c').read_text()
    assert 'pjsip_endpt_add_capability' not in source, 'Global capability leakage'
    assert 'endpoint->volte && endpoint->precondition_supported' in source
    with tempfile.TemporaryDirectory(prefix='vowifi-precondition-ci-') as temporary:
        root=Path(temporary);config=root/'etc';config.mkdir()
        for directory in ('run','logs','spool'): (root/directory).mkdir()
        (config/'asterisk.conf').write_text(f'''[directories]
astetcdir => {config}
astmoddir => /usr/lib/asterisk/modules
astvarlibdir => /var/lib/asterisk
astdbdir => {root}
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
        pjsip='''[global]
type=global
endpoint_identifier_order=ip
[ims-tcp]
type=transport
protocol=tcp
bind=127.0.0.1:5088
'''
        for name,address,ims,support in [('ims','127.0.0.2',True,True),('local','127.0.0.3',False,True),('unsupported','127.0.0.4',True,False)]:
            pjsip+=f'''[{name}]
type=endpoint
transport=ims-tcp
context={'ims-test' if ims else 'plain-test'}
disallow=all
allow=ulaw
100rel=peer_supported
volte={'yes' if ims else 'no'}
precondition_supported={'yes' if support else 'no'}
dedicated_bearer_up=yes
[{name}-identify]
type=identify
endpoint={name}
match={address}
'''
        (config/'pjsip.conf').write_text(pjsip)
        entered=root/'entered';completed=root/'completed'
        (config/'extensions.conf').write_text(f'''[general]
static=yes
[ims-test]
exten => _.,1,Set(FILE({entered},,,a)=${{PJSIP_HEADER(read,Call-ID)}})
same => n,WaitForPrecondition(10,5000)
same => n,Set(FILE({completed},,,a)=${{PRECONDITION_STATUS}})
same => n,Ringing()
same => n,Wait(30)
same => n,Hangup()
[plain-test]
exten => _.,1,Set(FILE({entered},,,a)=${{PJSIP_HEADER(read,Call-ID)}})
same => n,Ringing()
same => n,Wait(30)
same => n,Hangup()
''')
        log=(root/'asterisk.log').open('w+')
        process=subprocess.Popen(['asterisk','-f','-g','-q','-C',str(config/'asterisk.conf')],stdout=log,stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                ready=subprocess.run(['asterisk','-C',str(config/'asterisk.conf'),'-rx','core waitfullybooted'],capture_output=True)
                if ready.returncode==0: break
                if process.poll() is not None: raise AssertionError('Asterisk exited')
                time.sleep(.1)
            else: raise AssertionError('Asterisk did not boot')
            # Same running Asterisk: interleave IMS/non-IMS/explicitly unsupported
            # calls to expose accidental global capability registration.
            for address,required,unsupported in [
                ('127.0.0.3','precondition',{'precondition'}),
                ('127.0.0.4','precondition',{'precondition'}),
                ('127.0.0.2','x-vowifi-unknown',{'x-vowifi-unknown'}),
                ('127.0.0.2','precondition,x-vowifi-unknown',{'x-vowifi-unknown'})]:
                peer=Peer(address)
                try:
                    peer.send('INVITE',body=sdp(),extra=['Require: '+required],initial=True)
                    rejected,_=peer.until(420,'INVITE')
                    actual={item.strip().lower() for value in rejected['headers'].get('unsupported',[]) for item in value.split(',')}
                    assert actual==unsupported,(address,rejected)
                    supported=','.join(rejected['headers'].get('supported',[])).lower()
                    assert ('precondition' in supported)==(address=='127.0.0.2'),rejected
                    peer.send('ACK')
                    assert peer.call_id not in (entered.read_text() if entered.exists() else '')
                finally: peer.close()
                print(f'Unsupported Require validation: {address} {required} passed',flush=True)
            peer=Peer('127.0.0.2')
            try:
                peer.send('INVITE',body=sdp(),extra=['Require: precondition'],initial=True)
                progress,packets=peer.until(183,'INVITE')
                assert not any(p['start'].startswith('SIP/2.0 180 ') for p in packets)
                assert 'a=curr:qos ' in progress['body'] and 'a=des:qos ' in progress['body'],progress
                assert 'precondition' in ','.join(progress['headers'].get('supported',[])),progress
                assert 'precondition' in ','.join(progress['headers'].get('require',[])),progress
                assert '100rel' in ','.join(progress['headers'].get('require',[])),progress
                rseq=progress['headers']['rseq'][0]
                peer.send('PRACK',2,extra=[f'RAck: {rseq} 1 INVITE'])
                _,packets=peer.until(200,'PRACK')
                assert not any(p['start'].startswith('SIP/2.0 180 ') for p in packets)
                # No early ringing while remote mandatory QoS is still incomplete.
                try:
                    packet=peer.read(.2)
                    assert not packet['start'].startswith('SIP/2.0 180 '),packet
                except socket.timeout: pass
                peer.send('UPDATE',3,body=sdp(True),extra=['Require: precondition'])
                answer,_=peer.until(200,'UPDATE')
                assert 'a=curr:qos local sendrecv' in answer['body'],answer
                assert 'a=curr:qos remote sendrecv' in answer['body'],answer
                peer.until(180,'INVITE')
                assert entered.exists() and peer.call_id in entered.read_text()
                assert completed.exists() and 'SUCCESS' in completed.read_text()
                peer.cancel()
            finally: peer.close()
            print('IMS Require preserved: 183/PRACK/200/UPDATE/200/180 and QoS wait passed',flush=True)
            # An ordinary IMS call still works without mandatory preconditions.
            peer=Peer('127.0.0.2')
            try:
                plain='\r\n'.join(line for line in sdp().split('\r\n') if not line.startswith(('a=curr:qos','a=des:qos')))
                peer.send('INVITE',body=plain,initial=True)
                peer.until(180,'INVITE');peer.cancel()
            finally: peer.close()
            # Verify IMS admission did not leak capability to a subsequent local call.
            peer=Peer('127.0.0.3')
            try:
                peer.send('INVITE',body=sdp(),extra=['Require: precondition'],initial=True)
                peer.until(420,'INVITE');peer.send('ACK')
            finally: peer.close()
            assert process.poll() is None
            print('Ordinary IMS routing and post-IMS local endpoint isolation passed',flush=True)
        except Exception:
            log.flush();log.seek(0);print(log.read(),flush=True)
            raise
        finally:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill();process.wait()
            log.close()


if __name__=='__main__': main()
