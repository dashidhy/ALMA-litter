"""Local process-group deadlines, sampled aggregate RSS and bounded log capture."""
from pathlib import Path
import os
import resource
import signal
import subprocess
import time

RSS_LIMIT = 1536 * 1024 * 1024


def run(argv, log, *, cwd, env, timeout=45):
    if not 0 < timeout <= 180:
        raise ValueError('invalid deadline')
    log = Path(log)
    log.parent.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    peak = 0
    stopped = None

    def limits():
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_FSIZE, (256 * 1024**2,) * 2)
        resource.setrlimit(resource.RLIMIT_CPU, (timeout, timeout + 1))

    with log.open('wb') as output:
        proc = subprocess.Popen([str(x) for x in argv], cwd=cwd, env=env,
                                stdin=subprocess.DEVNULL, stdout=output,
                                stderr=subprocess.STDOUT, start_new_session=True,
                                preexec_fn=limits)
        try:
            while proc.poll() is None:
                ps = subprocess.run(['/bin/ps', '-axo', 'pgid=,rss='],
                                    capture_output=True, text=True, timeout=2)
                rss = sum(int(v[1]) * 1024 for line in ps.stdout.splitlines()
                          if len(v := line.split()) == 2 and v[0] == str(proc.pid))
                peak = max(peak, rss)
                if time.monotonic() - start >= timeout:
                    stopped = 'wall_timeout'
                elif rss >= RSS_LIMIT:
                    stopped = 'rss_guard'
                elif log.stat().st_size > 4 * 1024**2:
                    stopped = 'output_guard'
                if stopped:
                    break
                time.sleep(0.05)
        finally:
            # Also reap surviving children on normal leader exit, never broad pkill.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            code = proc.wait(timeout=5)
    return {'hostExit': code, 'stopReason': stopped,
            'seconds': round(time.monotonic() - start, 3),
            'peakSampledGroupRSSBytes': peak, 'deadlineSeconds': timeout}


def clean_env():
    # No inherited credentials or iOS build flags in the host probe process.
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'TMPDIR') if k in os.environ}
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    return env
