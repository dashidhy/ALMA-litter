#!/usr/bin/env python3
from pathlib import Path
import hashlib,json,os,resource,signal,subprocess,time
HERE=Path(__file__).resolve().parents[1];C=HERE/'.cache';root=C/'rootfs';binary=C/'build/ish'
env=dict(os.environ)
for k in ['ISH_BIND_MOUNTS','ISH_NATIVE_OFFLOAD','ISH_ENABLE_SESSION_JOBS','ISH_ENABLE_WORKSPACE_POLICY','ISH_POLICY_READ_ROOTS','ISH_POLICY_WRITE_ROOTS']:env.pop(k,None)
# Bootstrap only ordinary data in this private copied fakefs. No mounts/host probes.
setup="mkdir -p /policy/input /policy/candidate /policy/tmp; printf 'fixture input\\n' > /policy/input/source.txt; printf 'private fixture\\n' > /policy/not_granted.txt; echo PREPARED"
r=subprocess.run([str(binary),'-f',str(root),'/bin/sh','-c',setup],stdin=subprocess.DEVNULL,capture_output=True,env=env,timeout=10)
assert b'PREPARED' in r.stdout,(r.stdout,r.stderr)
worker=(HERE/'tests/worker.py').read_text()
controller='''import ctypes,errno,os,subprocess,time
c=ctypes.CDLL(None,use_errno=True)
def ctl(op,id=0):
 r=c.prctl(0x49534a42,ctypes.c_ulong(op),ctypes.c_ulong(id),0,0)
 if r<0:raise OSError(ctypes.get_errno(),os.strerror(ctypes.get_errno()))
 return r
assert ctl(0)==2
try:ctl(1)
except OSError as e:assert e.errno==errno.EPERM
else:raise AssertionError('missing grant was accepted')
job=ctl(7,1)
env=dict(os.environ,HOME='/policy/tmp',TMPDIR='/policy/tmp',PYTHONDONTWRITEBYTECODE='1')
p=subprocess.Popen(['/usr/bin/python3','/policy/input/worker.py'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,cwd='/policy/candidate')
try:ctl(5,job)
except OSError as e:assert e.errno==errno.EBUSY
else:raise AssertionError('live job released')
try:ctl(7,1)
except OSError:pass
else:raise AssertionError('bound grant reused')
out,err=p.communicate(timeout=22)
print(out.decode(errors='replace'),flush=True);print(err.decode(errors='replace'),flush=True)
ctl(3,job)
until=time.monotonic()+5
while ctl(4,job):
 assert time.monotonic()<until,'owned completion deadline'
 time.sleep(.01)
ctl(5,job)
try:ctl(7,1)
except OSError:pass
else:raise AssertionError('grant reused')
assert p.returncode==0,(p.returncode,out,err)
print('POLICY_CONTROLLER_PASS',flush=True)
'''
for path,content in [('/policy/input/worker.py',worker),('/policy/controller.py',controller)]:
 r=subprocess.run([str(binary),'-f',str(root),'/bin/sh','-c','cat > '+path],input=content.encode(),capture_output=True,env=env,timeout=10)
 assert not r.stderr,r.stderr
env.update(ISH_ENABLE_SESSION_JOBS='1',ISH_ENABLE_WORKSPACE_POLICY='1',ISH_POLICY_READ_ROOTS='/bin:/sbin:/usr:/lib:/etc:/policy/input',ISH_POLICY_WRITE_ROOTS='/policy/candidate:/policy/tmp')
def limits():resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_CPU,(40,41))
start=time.monotonic();timed_out=False
with (C/'guest.stdout').open('wb') as out,(C/'guest.stderr').open('wb') as err:
 p=subprocess.Popen([str(binary),'-f',str(root),'/usr/bin/python3','-B','/policy/controller.py'],stdin=subprocess.DEVNULL,stdout=out,stderr=err,env=env,start_new_session=True,preexec_fn=limits)
 try:p.wait(timeout=35)
 except subprocess.TimeoutExpired:timed_out=True;os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
stdout=(C/'guest.stdout').read_text(errors='replace');stderr=(C/'guest.stderr').read_text(errors='replace')
result={'passed':not timed_out and 'POLICY_CONTROLLER_PASS' in stdout,'timed_out':timed_out,'host_exit':p.returncode,'seconds':time.monotonic()-start,'stdout':stdout,'stderr':stderr,'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'scope':'ordinary own private fakefs fixture, real iSH C guest; no host bind mounts or intrusion probes; no native OpenAI/Web requests'}
(HERE/'reports/guest.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));raise SystemExit(0 if result['passed'] else 1)
