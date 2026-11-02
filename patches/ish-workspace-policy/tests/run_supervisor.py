#!/usr/bin/env python3
"""Real supervisor protocol test, only inside this directory's private fakefs."""
from pathlib import Path
import base64,json,os,select,signal,struct,subprocess,time,resource
HERE=Path(__file__).resolve().parents[1];C=HERE/'.cache';binary=C/'build/ish';root=C/'rootfs';elf=C/'cargo-target/aarch64-unknown-linux-musl/release/ish-supervisor'
env=dict(os.environ)
for key in ['ISH_BIND_MOUNTS','ISH_NATIVE_OFFLOAD','ISH_ENABLE_SESSION_JOBS','ISH_ENABLE_WORKSPACE_POLICY','ISH_POLICY_READ_ROOTS','ISH_POLICY_WRITE_ROOTS']:env.pop(key,None)
r=subprocess.run([str(binary),'-f',str(root),'/bin/sh','-c','base64 -d > /tmp/ish-policy-supervisor; chmod 755 /tmp/ish-policy-supervisor; echo INSTALLED'],input=base64.b64encode(elf.read_bytes()),capture_output=True,env=env,timeout=15)
assert b'INSTALLED' in r.stdout,(r.stdout,r.stderr)
worker="""import pathlib,socket
p=pathlib.Path('/policy')
assert (p/'input/source.txt').read_text()=='fixture input\\n'
try:(p/'input/source.txt').write_text('bad')
except PermissionError:pass
else:raise AssertionError('RO modified')
(p/'candidate/wire.txt').write_text('wire result')
try:socket.socket(socket.AF_INET,socket.SOCK_STREAM)
except PermissionError:pass
else:raise AssertionError('direct network opened')
print('WIRE_POLICY_PASS',flush=True)
"""
r=subprocess.run([str(binary),'-f',str(root),'/bin/sh','-c','cat > /policy/input/wire-worker.py'],input=worker.encode(),capture_output=True,env=env,timeout=10);assert not r.stderr,r.stderr

def var(n):
 out=bytearray()
 while n>=128:out.append((n&127)|128);n>>=7
 out.append(n);return bytes(out)
def string(s):
 b=s.encode();return var(len(b))+b
def opening(i,argv,grant=None,explicit=True):
 opts=var(len(argv))+b''.join(string(a) for a in argv)
 e=[('PATH','/usr/bin:/bin'),('HOME','/policy/tmp'),('TMPDIR','/policy/tmp'),('PYTHONMALLOC','malloc'),('PYTHONDONTWRITEBYTECODE','1')]
 opts+=(b'\x01'+var(len(e))+b''.join(string(k)+string(v) for k,v in e)) if explicit else b'\x00'
 opts+=b'\x01'+string('/policy/candidate')+b'\x00\x00\x00\x00'
 return var(0 if grant is None else 6)+var(i)+opts+(b'' if grant is None else var(grant))
def decode(payload):
 pos=0
 def v():
  nonlocal pos
  n=0;shift=0
  while True:
   b=payload[pos];pos+=1;n|=(b&127)<<shift
   if b<128:return n
   shift+=7
 def signed():
  n=v();return (n>>1)^-(n&1)
 def blob():
  nonlocal pos
  n=v();b=payload[pos:pos+n];pos+=n;return b.decode(errors='replace')
 tag=v();out={'tag':tag}
 if tag==0:out['version']=v()
 elif tag==1:out.update(id=v(),pid=signed())
 elif tag==2:out.update(id=v(),seq=v(),stream=v(),output=blob())
 elif tag==3:out.update(id=v(),exit=signed(),signal=signed())
 elif tag==4:out.update(id=v())
 elif tag==5:out.update(id=v() if v() else None,code=v(),error=blob())
 else:raise AssertionError(tag)
 assert pos==len(payload);return out
results=[]
for version in [4,3,2]:
 e=dict(env)
 if version>=3:e['ISH_ENABLE_SESSION_JOBS']='1'
 if version==4:e.update(ISH_ENABLE_WORKSPACE_POLICY='1',ISH_POLICY_READ_ROOTS='/bin:/sbin:/usr:/lib:/etc:/policy/input',ISH_POLICY_WRITE_ROOTS='/policy/candidate:/policy/tmp')
 # Direct trusted PID-1 ELF; pipe stdio needs no terminal setup or setup fork.
 with (C/f'wire-{version}.stderr').open('wb') as stderr:
  p=subprocess.Popen([str(binary),'-f',str(root),'/tmp/ish-policy-supervisor'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr,env=e,start_new_session=True)
  os.set_blocking(p.stdin.fileno(),False);buf=bytearray();events=[];began=time.monotonic()
  def send(payload):
   data=memoryview(struct.pack('<I',len(payload))+payload);deadline=time.monotonic()+6
   while data:
    if time.monotonic()>deadline:raise TimeoutError('write deadline')
    if select.select([], [p.stdin], [], .1)[1]:
     try:data=data[os.write(p.stdin.fileno(),data):]
     except BlockingIOError:pass
  def receive():
   deadline=time.monotonic()+10
   while True:
    if len(buf)>=4:
     n=struct.unpack('<I',buf[:4])[0];assert n<1024*1024
     if len(buf)>=n+4:
      frame=decode(bytes(buf[4:n+4]));del buf[:n+4];events.append(frame);return frame
    if time.monotonic()>deadline or time.monotonic()-began>35:raise TimeoutError('frame deadline')
    if select.select([p.stdout],[],[],.1)[0]:
     chunk=os.read(p.stdout.fileno(),65536)
     if not chunk:raise AssertionError('unexpected EOF')
     buf.extend(chunk)
  def closed(i,rejected=False):
   seen_error=False
   for _ in range(100):
    event=receive()
    if event.get('id')!=i:continue
    if rejected:assert event['tag'] not in [1,2],event
    if event['tag']==5:
     assert rejected,event
     seen_error=True
    if event['tag']==4:
     if rejected:assert seen_error
     return
   raise AssertionError('event count bound')
  try:
   assert receive()=={'tag':0,'version':version}
   if version==4:
    send(opening(1,['/bin/echo','MUST_NOT_RUN']));closed(1,True)
    send(opening(2,['/bin/echo','MUST_NOT_RUN'],999));closed(2,True)
    send(opening(3,['/usr/bin/python3','/policy/input/wire-worker.py'],1));closed(3)
    assert any('WIRE_POLICY_PASS' in x.get('output','') for x in events)
    assert any(x.get('id')==3 and x.get('exit')==0 for x in events)
    send(opening(4,['/bin/echo','MUST_NOT_RUN'],1));closed(4,True)
   else:
    send(opening(1,['/bin/echo','LEGACY_OK'],explicit=False));closed(1)
    assert any('LEGACY_OK' in x.get('output','') for x in events)
   send(var(5));p.wait(timeout=5)
   results.append({'version':version,'passed':True,'seconds':time.monotonic()-began,'events':events})
  except Exception as error:
   results.append({'version':version,'passed':False,'error':repr(error),'events':events});raise
  finally:
   if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
   (HERE/'reports/supervisor.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
