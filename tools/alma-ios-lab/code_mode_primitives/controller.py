"""Trusted guest PID1 fixture controller; never a production provider."""
import ctypes
import json
import os
import select
import subprocess
import time

libc = ctypes.CDLL(None, use_errno=True)


def ctl(op, ident=0):
    result = libc.prctl(0x49534A42, ctypes.c_ulong(op), ctypes.c_ulong(ident), 0, 0)
    if result < 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    return result


assert ctl(0) == 2, "sealed policy required"
with open('/workspace/input/selection.json') as stream:
    selection = json.load(stream)
assert selection['group'] in ('modules', 'settled', 'exit-sync', 'exit-async', 'cpu', 'baseline', 'flags', 'vm', 'worker-load', 'process-exit', 'process-cpu')
group = selection['group']
node_args = ['--jitless', '--experimental-vm-modules', '/workspace/input/primitives.cjs', group]
if group in ('process-exit', 'process-cpu'):
    node_args = ['--jitless', '--experimental-vm-modules', '/workspace/input/process-alternative.cjs', group]
if group in ('baseline', 'flags', 'vm', 'worker-load'):
    check = {'baseline': '', 'flags': '',
             'vm': "const vm=require('node:vm'); if(typeof vm.SourceTextModule!=='function')throw Error('missing SourceTextModule'); vm.createContext({});",
             'worker-load': "const w=require('node:worker_threads'); if(typeof w.Worker!=='function')throw Error('missing Worker');"}[group]
    source = check + "console.log(JSON.stringify({node:process.version,flags:process.execArgv,group:" + json.dumps(group) + ",cases:[{name:" + json.dumps(group) + ",passed:true}],passed:true}));"
    node_args = ([] if group == 'baseline' else ['--jitless', '--experimental-vm-modules']) + ['-e', source]
job = ctl(7, 1)  # Host registered immutable grant 1 before PID1 started.
child = None
result = {'group': selection['group'], 'job': job, 'cleanup_confirmed': False}
try:
    child = subprocess.Popen(
        ['/usr/bin/node', *node_args],
        # Policy permits controller-provided pipe stdio. A /dev/null descriptor
        # opened by unowned PID1 is not a job-owned device handle.
        cwd='/workspace/tmp', stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={'PATH': '/usr/bin:/bin', 'HOME': '/workspace/tmp',
             'TMPDIR': '/workspace/tmp', 'LANG': 'C.UTF-8'},
    )
    ctl(2, job)  # Disarm, even though the successful fork consumed the claim.
    try:
        prefix = b''
        if group == 'process-cpu':
            # Only the trusted controller owns cancellation. No guest signaling
            # privileges are added. Wait for this ordinary process's ready frame.
            assert select.select([child.stdout], [], [], 10)[0], 'process loop readiness deadline'
            prefix = child.stdout.readline()
            assert json.loads(prefix)['phase'] == 'loop-entering'
            time.sleep(.025)
            ctl(3, job)
            result['owned_cancel_requested'] = True
        out, err = child.communicate(timeout=22)
        out = prefix + out
    except subprocess.TimeoutExpired:
        result['guest_timeout'] = True
        ctl(3, job)
        out, err = child.communicate(timeout=2)
    result.update(child_exit=child.returncode,
                  stdout=out.decode('utf8', errors='replace'),
                  stderr=err.decode('utf8', errors='replace'))
except BaseException as error:
    result['controller_error'] = str(error)
finally:
    ctl(2, job)
    ctl(3, job)  # Sticky cancel any remaining owned descendants/threads.
    until = time.monotonic() + 3
    while ctl(4, job):
        if time.monotonic() >= until:
            result['cleanup_error'] = 'owned job still live'
            break
        time.sleep(.01)
    else:
        result['live_after_cleanup'] = 0
        ctl(5, job)
        result['cleanup_confirmed'] = True
print(json.dumps(result), flush=True)
expected_exit = -9 if group == 'process-cpu' else 0
raise SystemExit(0 if result.get('child_exit') == expected_exit and result['cleanup_confirmed'] else 1)
