"""Synthetic guest payload. All host paths come from the disposable fixture."""
from pathlib import Path
import ctypes
import json
import os
import subprocess
import sys

config = json.loads(Path('/fixtures/config.json').read_text())
case = sys.argv[1]
libc = ctypes.CDLL(None, use_errno=True)
libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p,
                       ctypes.c_ulong, ctypes.c_char_p]
libc.umount2.argtypes = [ctypes.c_char_p, ctypes.c_int]


def mount(source, target, flags=0):
    rc = libc.mount(source.encode(), target.encode(), b'realfs', flags, b'')
    if rc:
        raise OSError(ctypes.get_errno(), 'mount')
    return rc


def umount(target):
    if libc.umount2(target.encode(), 0):
        raise OSError(ctypes.get_errno(), 'umount2')
    return 0


def attempt(name, action, denied=True):
    try:
        value = action()
        result = {'name': name, 'succeeded': True, 'value': value}
    except OSError as exc:
        result = {'name': name, 'succeeded': False, 'errno': exc.errno,
                  'error': str(exc)}
    result['expectedDenied'] = denied
    print('__OBS__:' + json.dumps(result, ensure_ascii=False), flush=True)
    return result['succeeded']


def edit(path):
    before = Path(path).read_text()
    assert before == 'SYNTHETIC_SENTINEL\n', (path, before)
    Path(path).write_text('MODIFIED_BY_GUEST\n')
    return {'readMatched': True, 'readback': Path(path).read_text()}


def read(path):
    value = Path(path).read_text()
    assert value == 'SYNTHETIC_SENTINEL\n', (path, value)
    return 'synthetic sentinel matched'


if case == 'normal':
    text = '中文 English 😀 "quotes"\n'
    d = json.loads(Path('/input/fixture.json').read_text())
    assert d['text'] == text
    dest = Path('/output/中文 notes.json')
    tmp = Path('/scratch/python.tmp')
    tmp.write_text(json.dumps({'text': text, 'phase': 'python'}, ensure_ascii=False))
    # Same-mount atomic rename is part of the expected file contract.
    staged = dest.with_suffix('.tmp')
    staged.write_bytes(tmp.read_bytes())
    with staged.open('r+') as f:
        f.flush()
        os.fsync(f.fileno())
    os.replace(staged, dest)
    assert json.loads(dest.read_text())['phase'] == 'python'
    tmp.unlink()
    attempt('python read/write/fsync/replace/unlink/unicode', lambda: True, False)
    result = subprocess.run(['/bin/bash', '-c',
        'a=(one two); test ${#a[@]} -eq 2 && printf BASH_OK > /scratch/bash.txt'], timeout=8)
    assert result.returncode == 0 and Path('/scratch/bash.txt').read_text() == 'BASH_OK'
    attempt('bash arrays and child file output', lambda: True, False)
    code = r'''const fs=require('node:fs'),cp=require('node:child_process');
const p='/output/中文 notes.json',d=JSON.parse(fs.readFileSync(p,'utf8'));
if(d.phase!=='python')throw Error('python input mismatch');
d.phase='node';fs.writeFileSync(p+'.tmp',JSON.stringify(d));fs.renameSync(p+'.tmp',p);
fs.writeFileSync('/scratch/node.tmp','temporary');fs.unlinkSync('/scratch/node.tmp');
cp.execFile('/bin/sh',['-c','printf NODE_CHILD_OK'],{timeout:8000},(err,out)=>{
if(err||out!=='NODE_CHILD_OK')throw err||Error(out);console.log('NODE_OK');});'''
    result = subprocess.run(['node', '--jitless', '-e', code], timeout=20,
                            capture_output=True, text=True)
    assert result.returncode == 0 and 'NODE_OK' in result.stdout, result
    assert json.loads(dest.read_text()) == {'text': text, 'phase': 'node'}
    attempt('node read/write/replace/unlink/unicode/child', lambda: True, False)
    print('__VERSIONS__:' + json.dumps({'python': sys.version.split()[0],
          'node': subprocess.check_output(['node', '--version'], text=True).strip(),
          'uid': os.getuid()}))

elif case == 'readonly':
    attempt('python overwrite', lambda: edit('/input/overwrite'))
    attempt('python create', lambda: Path('/input/new').write_text('new'))
    attempt('python truncate', lambda: os.truncate('/input/truncate', 0))
    attempt('python rename out', lambda: os.rename('/input/rename', '/output/renamed'))
    attempt('python unlink', lambda: os.unlink('/input/unlink'))
    attempt('python mkdir', lambda: os.mkdir('/input/newdir'))
    attempt('python chmod', lambda: os.chmod('/input/chmod', 0o777))
    attempt('python symlink into input', lambda: os.symlink('/output', '/input/link'))
    attempt('python tool-base overwrite', lambda: edit('/toolbase/sentinel'))
    # Shell and Node report failure codes explicitly; no set -e masking.
    for name, command in [
        ('shell overwrite', ['/bin/sh', '-c', 'printf modified > /input/shell']),
        ('node overwrite', ['node', '--jitless', '-e',
         "require('node:fs').writeFileSync('/input/node','modified')"]),
    ]:
        result = subprocess.run(command, capture_output=True, text=True, timeout=15)
        print('__OBS__:' + json.dumps({'name': name, 'succeeded': result.returncode == 0,
              'expectedDenied': True, 'exit': result.returncode,
              'diagnostic': result.stderr[-700:]}))

elif case == 'readonly-hardlink':
    if attempt('hardlink readonly source into writable output',
               lambda: os.link('/input/hardlink', '/output/hardlink')):
        attempt('overwrite readonly inode through writable hardlink',
                lambda: edit('/output/hardlink'))

elif case == 'paths':
    paths = {
        'dotdot sibling': '/output/../hidden/sentinel',
        'dotdot absolute-host suffix': '/output/..' + config['hidden'] + '/sentinel',
        'direct absolute host path': config['hidden'] + '/sentinel',
        'preexisting host absolute file symlink': '/output/host-absolute-file',
        'preexisting host relative file symlink': '/output/host-relative-file',
        'preexisting host absolute directory symlink': '/output/host-absolute-dir/sentinel',
        'preexisting host relative directory symlink': '/output/host-relative-dir/sentinel',
    }
    for name, path in paths.items():
        # Each host symlink targets a separate sentinel for independent write checks.
        if attempt(name + ' read', lambda p=path: read(p)):
            attempt(name + ' write', lambda p=path: edit(p))
    os.symlink(config['hidden'] + '/sentinel', '/output/guest-absolute')
    os.symlink('../hidden/sentinel', '/output/guest-relative')
    for name in ['guest-absolute', 'guest-relative']:
        if attempt(name + ' symlink read', lambda n=name: read('/output/' + n)):
            attempt(name + ' symlink write', lambda n=name: edit('/output/' + n))

elif case.startswith('realfs-'):
    target = '/probe-mount'
    os.mkdir(target, 0o777)
    os.chmod(target, 0o777)
    if case == 'realfs-shell':
        result = subprocess.run(['/bin/mount', '-t', 'realfs', config['hidden'], target],
                                capture_output=True, text=True, timeout=10)
        print('__OBS__:' + json.dumps({'name': 'shell mounts unexposed host directory',
              'succeeded': result.returncode == 0, 'expectedDenied': True,
              'exit': result.returncode, 'diagnostic': result.stderr[-700:]}))
        if result.returncode == 0:
            attempt('read and overwrite unexposed sentinel', lambda: edit(target + '/sentinel'))
    elif case in ['realfs-syscall', 'realfs-nonroot']:
        if case == 'realfs-nonroot':
            os.setgid(1000)
            os.setuid(1000)
        print('__UID__:' + str(os.getuid()))
        if attempt('libc mount unexposed host directory', lambda: mount(config['hidden'], target)):
            attempt('read and overwrite unexposed sentinel', lambda: edit(target + '/sentinel'))
            attempt('guest umount2', lambda: umount(target))
    elif case == 'realfs-readonly':
        # Setup is intentionally allowed to measure MS_RDONLY behavior independently.
        mount(config['input'], target, 1)
        attempt('MS_RDONLY realfs overwrite', lambda: edit(target + '/overwrite'))
        attempt('MS_RDONLY realfs truncate', lambda: os.truncate(target + '/truncate', 0))
        attempt('MS_RDONLY realfs unlink', lambda: os.unlink(target + '/unlink'))
        attempt('MS_RDONLY realfs mkdir', lambda: os.mkdir(target + '/newdir'))
    elif case == 'realfs-alias':
        if attempt('rw alias of host readonly input', lambda: mount(config['input'], target)):
            attempt('overwrite readonly input through realfs alias', lambda: edit(target + '/overwrite'))
    elif case == 'realfs-replace':
        if attempt('replace readonly input with hidden host directory',
                   lambda: mount(config['hidden'], '/input')):
            attempt('read and overwrite hidden via replacement', lambda: edit('/input/sentinel'))
    elif case == 'realfs-remount':
        mount(config['input'], target, 1)
        attempt('MS_REMOUNT to rw', lambda: mount(config['input'], target, 32))
else:
    raise ValueError(case)

print('__CASE_COMPLETE__:' + case)
