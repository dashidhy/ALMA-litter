"""Trusted PID1 claims the already registered grant before child execution."""
import ctypes
import errno
import json
import os
import subprocess
import time

libc = ctypes.CDLL(None, use_errno=True)


def ctl(op, ident=0):
    result = libc.prctl(0x49534A42, ctypes.c_ulong(op), ctypes.c_ulong(ident), 0, 0)
    if result < 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    return result


assert ctl(0) == 2
role = open('/workspace/test/role.txt').read().strip()
assert role in ('guardian', 'actor')
job = ctl(7, 1)
result = {'role': role, 'mode4_capability': True, 'cleanup_confirmed': False}
try:
    child = subprocess.Popen(['/usr/bin/python3', '-B', '/workspace/test/worker.py', role],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd='/workspace/view', env={'PATH': '/usr/bin:/bin', 'HOME': '/workspace/scratch/home',
                                   'TMPDIR': '/workspace/scratch', 'LANG': 'C.UTF-8'})
    ctl(2, job)
    try:
        ctl(5, job)
    except OSError as error:
        assert error.errno == errno.EBUSY
        result['premature_release_rejected'] = True
    else:
        raise AssertionError('live job released')
    try:
        out, err = child.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        ctl(3, job)
        out, err = child.communicate(timeout=3)
        result['guest_timeout'] = True
    result.update(exit=child.returncode, stdout=out.decode(errors='replace'), stderr=err.decode(errors='replace'))
except BaseException as error:
    result['error'] = str(error)
finally:
    ctl(2, job)
    ctl(3, job)
    until = time.monotonic() + 5
    while ctl(4, job):
        assert time.monotonic() < until, 'owned completion deadline'
        time.sleep(.01)
    ctl(5, job)
    result.update(cleanup_confirmed=True, live_after_cleanup=0)
    try:
        ctl(7, 1)
    except OSError:
        result['retired_grant_reuse_rejected'] = True
    else:
        raise AssertionError('retired grant reused')
print(json.dumps(result), flush=True)
