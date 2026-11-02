# Runs only inside a granted job in a private copied fakefs.
import errno,json,mmap,os,pathlib,socket,subprocess,tempfile
p=pathlib.Path('/policy')
assert (p/'input/source.txt').read_text()=='fixture input\n'
def denied(fn):
 try:fn()
 except OSError as e:assert e.errno in (errno.EACCES,errno.EPERM,errno.ENOTSUP,errno.EROFS),e
 else:raise AssertionError('read-only operation unexpectedly succeeded')
denied(lambda:(p/'input/source.txt').write_text('changed'))
denied(lambda:os.unlink(p/'input/source.txt'))
denied(lambda:os.rename(p/'input/source.txt',p/'candidate/stolen'))
f=os.open(p/'input/source.txt',os.O_RDONLY)
denied(lambda:os.fchmod(f,0o777));denied(lambda:os.ftruncate(f,0))
denied(lambda:mmap.mmap(f,0,flags=mmap.MAP_SHARED,prot=mmap.PROT_READ))
view=mmap.mmap(f,0,access=mmap.ACCESS_COPY);view[0:1]=b'X';view.close();os.close(f)
denied(lambda:(p/'not_granted.txt').read_text())
assert (p/'input/source.txt').read_text()=='fixture input\n'
(p/'candidate/new.txt').write_text('hello 中文\n')
with open(p/'candidate/new.txt','r+') as f:f.truncate(5);f.flush();os.fsync(f.fileno())
os.rename(p/'candidate/new.txt',p/'candidate/final.txt')
assert (p/'candidate/final.txt').read_text()=='hello'
denied(lambda:os.link(p/'candidate/final.txt',p/'candidate/hard'))
denied(lambda:os.symlink('final.txt',p/'candidate/sym'))
(p/'candidate/d').mkdir();denied(lambda:os.rename(p/'candidate/d',p/'candidate/e'));(p/'candidate/d').rmdir()
with tempfile.TemporaryDirectory(dir=p/'tmp') as d:
 q=pathlib.Path(d)/'ok';q.write_text('temporary');assert q.read_text()=='temporary'
# Normal local subprocess and anonymous IPC, no remote connection attempt.
a,b=socket.socketpair();a.sendall(b'ipc');assert b.recv(3)==b'ipc';a.close();b.close()
denied(lambda:socket.socket(socket.AF_INET,socket.SOCK_STREAM))
denied(lambda:socket.socket(socket.AF_INET6,socket.SOCK_DGRAM))
r=subprocess.run(['/bin/bash','-c','a=(one two); printf "%s" "${a[1]}"'],capture_output=True,timeout=5)
assert r.returncode==0 and r.stdout==b'two',(r.returncode,r.stdout,r.stderr)
r=subprocess.run(['/bin/sh','-c','read line; echo "stdout:$line"; echo stderr >&2'],input=b'hello\n',capture_output=True,timeout=5)
assert r.returncode==0 and r.stdout==b'stdout:hello\n' and r.stderr==b'stderr\n',(r.returncode,r.stdout,r.stderr)
r=subprocess.run(['/usr/bin/node','-e',"const fs=require('fs'),cp=require('child_process'); const r=cp.spawnSync('/bin/sh',['-c','read x; echo $x'],{input:'node-child\\n'}); if(r.status!==0||r.stdout.toString()!=='node-child\\n')throw Error('child'); const x=fs.readFileSync('/policy/input/source.txt','utf8'); fs.writeFileSync('/policy/candidate/node.txt',x+'node'); console.log('NODE_OK')"],capture_output=True,timeout=10)
assert r.returncode==0 and b'NODE_OK' in r.stdout,(r.returncode,r.stdout,r.stderr)
assert (p/'candidate/node.txt').read_text()=='fixture input\nnode'
print('WORKSPACE_POLICY_PASS',flush=True)
