# Runs as trusted PID 1 only in a private iSH CLI process. No host mounts/files.
import ctypes,errno,json,os,subprocess,sys,time
libc=ctypes.CDLL(None,use_errno=True)
PR=0x49534a42

def call(op,job=0):
    result=libc.prctl(PR,ctypes.c_ulong(op),ctypes.c_ulong(job),0,0)
    if result < 0:raise OSError(ctypes.get_errno(),os.strerror(ctypes.get_errno()))
    return result

def empty(job,seconds=5):
    until=time.monotonic()+seconds
    while time.monotonic()<until:
        if call(4,job)==0:return
        time.sleep(.01)
    raise AssertionError('job did not become empty before deadline')

def spawn(argv,**kwargs):
    job=call(1)
    p=subprocess.Popen(argv,**kwargs)
    return job,p

def finish(job,p):
    call(3,job);empty(job);p.wait(timeout=2);call(5,job)
    try:call(4,job)
    except OSError as e:assert e.errno==errno.ESRCH
    else:raise AssertionError('released job reported false completion')

assert call(0)==1
results=[]
job,p=spawn(['/bin/sh','-c','read line; printf "OUT:%s\\n" "$line"; printf "ERR:ok\\n" >&2; exit 7'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
out,err=p.communicate(b'hello\n',timeout=5)
assert p.returncode==7 and out==b'OUT:hello\n' and err==b'ERR:ok\n',(p.returncode,out,err)
empty(job);call(5,job);results.append('stdio_and_exit')

# Ordinary nested child in its own POSIX session: group-only kill misses it.
code="import subprocess,time; p=subprocess.Popen(['/bin/sh','-c','sleep 20'],start_new_session=True); print('READY',flush=True); time.sleep(20)"
job,p=spawn(['/usr/bin/python3','-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
assert p.stdout.readline()==b'READY\n';count=call(4,job);assert count>=2,count
start=time.monotonic();finish(job,p);results.append({'nested_setsided_cancel_seconds':time.monotonic()-start,'live_before':count})

# EOF and leader exit are not owned completion: descendant holds no output pipe.
code="import subprocess; subprocess.Popen(['/bin/sh','-c','sleep 20'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)"
job,p=spawn(['/usr/bin/python3','-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
p.communicate(timeout=5);assert p.returncode==0;assert call(4,job)>0
finish(job,p);results.append('leader_exit_and_eof_not_completion')

# Both siblings are created by this fixture. Cancelling A must leave B usable.
a,pa=spawn(['/bin/sh','-c','sleep 20'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
b,pb=spawn(['/bin/sh','-c','read line; printf "B:%s\\n" "$line"'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
finish(a,pa);assert call(4,b)>0
out,err=pb.communicate(b'alive\n',timeout=3);assert out==b'B:alive\n' and pb.returncode==0
empty(b);call(5,b);results.append('sibling_job_survives')

# Kernel authority is not inherited by an ordinary child, including across exec.
code="import ctypes,errno; c=ctypes.CDLL(None,use_errno=True); assert c.prctl(0x49534a42,1,0,0,0)==-1 and ctypes.get_errno()==errno.EPERM; print('DENIED')"
job,p=spawn(['/usr/bin/python3','-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
out,err=p.communicate(timeout=4);assert p.returncode==0 and out==b'DENIED\n',(out,err)
empty(job);call(5,job);results.append('controller_authority_not_inherited')

# Small, finite startup/cancellation overlap; no unrelated process is signalled.
code="import subprocess,time; print('READY',flush=True);\nfor i in range(8):\n subprocess.Popen(['/bin/sh','-c','sleep 20']); time.sleep(.02)\ntime.sleep(20)"
job,p=spawn(['/usr/bin/python3','-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
assert p.stdout.readline()==b'READY\n';time.sleep(.04);finish(job,p);results.append('cancel_during_finite_spawn_loop')
print('ISH_JOB_FIXTURE_PASS:'+json.dumps(results),flush=True)
