#!/usr/bin/env python3
"""Drive actual cross-built supervisor inside private iSH; ordinary processes only."""
from pathlib import Path
import base64,hashlib,json,os,select,selectors,signal,struct,subprocess,time
HERE=Path(__file__).resolve().parents[1];C=HERE/'.cache';binary=C/'build/ish';root=C/'rootfs';elf=C/'cargo-target/aarch64-unknown-linux-musl/release/ish-supervisor'
build=json.loads((HERE/'reports/build.json').read_text())
assert hashlib.sha256(binary.read_bytes()).hexdigest()==build['host_binary_sha256']
assert hashlib.sha256(elf.read_bytes()).hexdigest()==build['supervisor_sha256']
env=dict(os.environ,ISH_ENABLE_SESSION_JOBS='1');env.pop('ISH_BIND_MOUNTS',None);env.pop('ISH_NATIVE_OFFLOAD',None)
r=subprocess.run([str(binary),'-f',str(root),'/bin/sh','-c','base64 -d > /tmp/ish-owned-supervisor; chmod 755 /tmp/ish-owned-supervisor; echo INSTALL_PASS'],input=base64.b64encode(elf.read_bytes()),stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=15)
assert b'INSTALL_PASS' in r.stdout,(r.stdout,r.stderr)
def var(n):
 b=bytearray()
 while n>=128:b.append((n&127)|128);n>>=7
 b.append(n);return bytes(b)
def string(s):
 b=s.encode();return var(len(b))+b
def open_request(i,argv,stdin=False,cwd=None):
 return var(0)+var(i)+var(len(argv))+b''.join(string(s) for s in argv)+b'\x00'+(b'\x01'+string(cwd) if cwd else b'\x00')+b'\x00\x00'+bytes([stdin])+b'\x00'
def write_request(i,b):return var(1)+var(i)+var(len(b))+b

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
  n=v();b=payload[pos:pos+n];pos+=n;return b
 tag=v();d={'tag':tag}
 if tag==0:d['version']=v()
 elif tag==1:d.update(id=v(),pid=signed())
 elif tag==2:d.update(id=v(),seq=v(),stream=v(),output=blob().decode(errors='replace'))
 elif tag==3:d.update(id=v(),exit=signed(),signal=signed())
 elif tag==4:d.update(id=v())
 elif tag==5:d.update(id=v() if v() else None,code=v(),error=blob().decode(errors='replace'))
 else:raise AssertionError(tag)
 assert pos==len(payload),(d,payload[pos:]);return d

results=[]
for owned in [True,False]:
 e=dict(env)
 if not owned:e.pop('ISH_ENABLE_SESSION_JOBS',None)
 p=subprocess.Popen([str(binary),'-f',str(root),'/bin/sh','-c','stty raw -echo; exec /tmp/ish-owned-supervisor'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=e,start_new_session=True)
 sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ);buf=bytearray();events=[];start=time.monotonic()
 os.set_blocking(p.stdin.fileno(),False)
 def send(payload):
  data=memoryview(struct.pack('<I',len(payload))+payload)
  deadline=time.monotonic()+6
  while data:
   if time.monotonic()>deadline:raise TimeoutError('supervisor write deadline')
   if select.select([], [p.stdin], [], .1)[1]:
    try:data=data[os.write(p.stdin.fileno(),data):]
    except BlockingIOError:pass
 def receive():
  deadline=time.monotonic()+6
  while True:
   if len(buf)>=4:
    n=struct.unpack('<I',buf[:4])[0];assert n<1024*1024,n
    if len(buf)>=n+4:
     payload=bytes(buf[4:4+n]);del buf[:4+n];d=decode(payload);events.append(d);return d
   if time.monotonic()>deadline or time.monotonic()-start>40:raise TimeoutError('supervisor frame deadline')
   if sel.select(.1):
    b=os.read(p.stdout.fileno(),65536)
    if not b:raise AssertionError(('supervisor EOF',p.poll()))
    buf.extend(b)
 def wait(tag,i=None):
  for _ in range(400):
   d=receive()
   if d['tag']==5:raise AssertionError(d)
   if d['tag']==tag and (i is None or d.get('id')==i):return d
  raise AssertionError('event bound')
 try:
  assert receive()=={'tag':0,'version':3 if owned else 2}
  send(open_request(1,['/bin/sh','-c','read line; echo "OUT:$line"; echo ERR:ok >&2; exit 7'],True));wait(1,1)
  send(write_request(1,b'hello\n'));wait(4,1)
  output=''.join(x.get('output','') for x in events if x.get('id')==1)
  assert 'OUT:hello' in output and 'ERR:ok' in output,output
  if owned:assert any(x.get('id')==1 and x.get('stream')==1 and 'ERR:ok' in x.get('output','') for x in events)
  assert any(x.get('id')==1 and x.get('exit')==7 for x in events)
  if owned:
   # Leader exits with a detached ordinary child retaining no stdout/stderr.
   script="import subprocess; subprocess.Popen(['/bin/sh','-c','sleep 20'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)"
   send(open_request(2,['/usr/bin/python3','-c',script]));wait(1,2);wait(4,2)
   # A non-reading child and queued stdin must not prevent Term processing.
   send(open_request(3,['/bin/sh','-c','sleep 20'],True));wait(1,3)
   send(write_request(3,b'x'*262144));send(var(4)+var(3));wait(4,3)
   # Concurrent test session survives cancellation of its sibling.
   send(open_request(4,['/bin/sh','-c','sleep 20']));wait(1,4)
   send(open_request(5,['/bin/sh','-c','read line; echo "SURVIVED:$line"'],True));wait(1,5)
   send(var(4)+var(4));wait(4,4);send(write_request(5,b'ok\n'));wait(4,5)
   assert any('SURVIVED:ok' in x.get('output','') for x in events)
   script="import signal,time,sys; signal.signal(signal.SIGINT,lambda a,b:(print('INTERRUPTED',flush=True),sys.exit(0))); print('INT_READY',flush=True); time.sleep(20)"
   send(open_request(6,['/usr/bin/python3','-c',script]));wait(1,6)
   while 'INT_READY' not in wait(2,6).get('output',''):pass
   send(var(3)+var(6)+var(2*2));wait(4,6)
   assert any('INTERRUPTED' in x.get('output','') for x in events)
   send(open_request(7,['/bin/echo','must_not_run'],cwd='/__ish_fixture_missing_directory__'))
   seen_error=False
   for _ in range(10):
    event=receive()
    if event.get('id')!=7:continue
    assert event['tag'] not in [1,2],event
    if event['tag']==5:seen_error=True
    if event['tag']==4:break
   else:raise AssertionError('failed cwd was not closed')
   assert seen_error
  send(var(5));p.wait(timeout=6)
  results.append({'patch_sha256':build['patch_sha256'],'supervisor_sha256':build['supervisor_sha256'],'owned':owned,'passed':True,'seconds':time.monotonic()-start,'events':events,'host_exit':p.returncode})
 except Exception as ex:
  results.append({'owned':owned,'passed':False,'error':repr(ex),'events':events})
  raise
 finally:
  if p.poll() is None:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
  sel.close()
  (HERE/'reports/supervisor-results.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
