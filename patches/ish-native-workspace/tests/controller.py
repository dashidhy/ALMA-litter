import ctypes,errno,os,subprocess,time
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
env=dict(os.environ,HOME='/workspace/tmp',TMPDIR='/workspace/tmp',PYTHONDONTWRITEBYTECODE='1')
p=subprocess.Popen(['/usr/bin/python3','/workspace/input/worker.py'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,cwd='/workspace/candidate')
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
