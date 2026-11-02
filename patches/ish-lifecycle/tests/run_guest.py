#!/usr/bin/env python3
from pathlib import Path
import hashlib,json,os,resource,shutil,signal,subprocess,time
HERE=Path(__file__).resolve().parents[1];REPO=HERE.parent.parent;CACHE=HERE/'.cache'
root=CACHE/'rootfs'
if not root.exists():shutil.copytree(REPO/'tools/alma-ios-lab/.cache/ish-augmented/fs',root,symlinks=True)
env=dict(os.environ,ISH_ENABLE_SESSION_JOBS='1');env.pop('ISH_BIND_MOUNTS',None);env.pop('ISH_NATIVE_OFFLOAD',None)
def limits():
 resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_CPU,(35,36));resource.setrlimit(resource.RLIMIT_FSIZE,(128*1024*1024,128*1024*1024))
build=json.loads((HERE/'reports/build.json').read_text())
binary=CACHE/'build/ish';assert hashlib.sha256(binary.read_bytes()).hexdigest()==build['host_binary_sha256']
fixture=(HERE/'tests/guest_fixture.py').read_text();start=time.monotonic()
with (CACHE/'guest.stdout').open('wb') as out,(CACHE/'guest.stderr').open('wb') as err:
 p=subprocess.Popen([str(binary),'-f',str(root),'/usr/bin/python3','-c',fixture],stdin=subprocess.DEVNULL,stdout=out,stderr=err,env=env,start_new_session=True,preexec_fn=limits)
 timeout=False
 try:p.wait(timeout=30)
 except subprocess.TimeoutExpired:
  timeout=True;os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
stdout=(CACHE/'guest.stdout').read_text(errors='replace');stderr=(CACHE/'guest.stderr').read_text(errors='replace')
passed=not timeout and 'ISH_JOB_FIXTURE_PASS:' in stdout
report={'patch_sha256':build['patch_sha256'],'passed':passed,'host_exit':p.returncode,'timed_out':timeout,'seconds':time.monotonic()-start,'stdout':stdout,'stderr':stderr,'binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'scope':'real patched iSH C kernel/ARM64 interpreter with Python control fixture; not Rust supervisor/host or phone acceptance'}
(HERE/'reports/guest-results.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2));raise SystemExit(0 if passed else 1)
