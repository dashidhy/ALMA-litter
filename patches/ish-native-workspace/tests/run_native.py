from pathlib import Path
import json,os,shlex,shutil,subprocess,time,hashlib,signal
HERE=Path(__file__).resolve().parents[1];REPO=HERE.parents[1]
h=HERE/'.cache';b=h/'build';s=h/'source';native=h/'workspace';root=h/'rootfs'
if not root.exists():
 candidates=list((REPO/'tools/alma-ios-lab/.cache/runtime-rootfs').glob('*/fs'))
 if len(candidates)!=1:raise RuntimeError('Prepare exactly one pinned runtime rootfs first')
 shutil.copytree(candidates[0],root)
for d in ['input','candidate','tmp']:(native/d).mkdir(parents=True,exist_ok=True)
(native/'input/source.txt').write_text('fixture input\n')
worker=r'''import errno,pathlib,subprocess,os
p=pathlib.Path('/workspace'); assert (p/'input/source.txt').read_text()=='fixture input\n'
try:(p/'input/source.txt').write_text('changed')
except OSError as e:assert e.errno in (errno.EACCES,errno.EPERM,errno.EROFS),e
else:raise AssertionError('read-only input was writable')
(p/'candidate/python.txt').write_text('Python 中文\n')
r=subprocess.run(['/bin/bash','-c','a=(one two); sed "s/中文/共享/" python.txt > bash.txt; printf "%s" "${a[1]}"'],cwd=p/'candidate',capture_output=True,timeout=6)
assert r.returncode==0 and r.stdout==b'two',(r.returncode,r.stdout,r.stderr)
r=subprocess.run(['/usr/bin/node','-e',"const fs=require('fs');const x=fs.readFileSync('/workspace/candidate/bash.txt','utf8');fs.writeFileSync('/workspace/candidate/node.tmp',x+'Node\\n');fs.renameSync('/workspace/candidate/node.tmp','/workspace/candidate/final.txt');console.log('NODE_OK')"],capture_output=True,timeout=10)
assert r.returncode==0 and b'NODE_OK' in r.stdout,(r.returncode,r.stdout,r.stderr)
assert (p/'candidate/final.txt').read_text()=='Python 共享\nNode\n'
print('NATIVE_WORKSPACE_GUEST_PASS',flush=True)
'''
(native/'input/worker.py').write_text(worker)
# Existing test controller creates exactly one owned job and waits for complete cleanup.
controller=(HERE/'tests/controller.py').read_text()
env=dict(os.environ)
for k in ['ISH_BIND_MOUNTS','ISH_NATIVE_OFFLOAD','ISH_ENABLE_SESSION_JOBS','ISH_ENABLE_WORKSPACE_POLICY','ISH_POLICY_READ_ROOTS','ISH_POLICY_WRITE_ROOTS','ALMA_PRIVATE_NATIVE_WORKSPACE']:env.pop(k,None)
# Test harness only: the production Rust host uses the typed mount API.
main=(s/'main.c').read_text();needle='int e=ish_workspace_enable();'
if needle not in main:
 print([l for l in main.splitlines() if 'ish_workspace_enable' in l]);raise SystemExit(2)
main=main.replace(needle,'const char *fixture=getenv("ALMA_PRIVATE_NATIVE_WORKSPACE"); if(fixture && ish_workspace_mount_native(fixture)<0) return 91; '+needle)
(h/'native_main.c').write_text('int ish_workspace_mount_native(const char *source);\n'+main)
commands=json.loads((b/'compile_commands.json').read_text());command=next(x for x in commands if x['file'].endswith('/main.c'))
a=shlex.split(command['command']);a[a.index('-o')+1]=str(h/'native-main.o');a[a.index('-c')+1]=str(h/'native_main.c')
# quoted local command arguments, never a shell-built evaluation
subprocess.run(a,cwd=b,env=env,check=True)
link=shlex.split(subprocess.check_output(['ninja','-C',str(b),'-t','commands','ish'],text=True).splitlines()[-1]);link[link.index('-o')+1]=str(h/'native-ish');link=[str(h/'native-main.o') if x=='ish.p/main.c.o' else x for x in link]
subprocess.run(link,cwd=b,env=env,check=True)
binary=h/'native-ish'
r=subprocess.run([str(binary),'-f',str(root),'/bin/sh','-c','mkdir -p /controller; cat > /controller/main.py'],input=controller.encode(),capture_output=True,env=env,timeout=10);assert r.returncode==0,r.stderr
# Controller itself is pre-policy trusted init, not the granted worker.
env.update(ISH_ENABLE_SESSION_JOBS='1',ISH_ENABLE_WORKSPACE_POLICY='1',ISH_POLICY_READ_ROOTS='/bin:/sbin:/usr:/lib:/etc:/workspace/input',ISH_POLICY_WRITE_ROOTS='/workspace/candidate:/workspace/tmp',ALMA_PRIVATE_NATIVE_WORKSPACE=str(native))
t=time.monotonic();p=subprocess.Popen([str(binary),'-f',str(root),'/usr/bin/python3','-B','/controller/main.py'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,start_new_session=True)
try:out,err=p.communicate(timeout=35)
except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);out,err=p.communicate();raise RuntimeError('native workspace bounded deadline: '+err.decode(errors='replace')[-1000:])
result={'passed':p.returncode==0 and b'NATIVE_WORKSPACE_GUEST_PASS' in out and b'POLICY_CONTROLLER_PASS' in out,'seconds':time.monotonic()-t,'stdout':out.decode(errors='replace'),'stderr':err.decode(errors='replace'),'exit':p.returncode,'scope':'actual iSH C guest Bash/Python/Node in one host-authorized private fixture; no model, no network, no unexposed host-directory probes'}
if result['passed']:
 assert (native/'candidate/final.txt').read_text()=='Python 共享\nNode\n'
 assert (native/'input/source.txt').read_text()=='fixture input\n'
 result['native_files_match']=True
(h.parent/'reports').mkdir(exist_ok=True);(h.parent/'reports/native-workspace.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2));raise SystemExit(0 if result['passed'] else 1)
