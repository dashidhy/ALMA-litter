"""Give the C-host guest POSIX pipes rather than Node's socketpair stdio."""
import os
import subprocess
import sys
import threading


def copy_stream(source, destination):
    try:
        while True:
            data = os.read(source, 4096)
            if not data:
                return
            offset = 0
            while offset < len(data):
                offset += os.write(destination, data[offset:])
    except (BrokenPipeError, OSError):
        return


child = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
os.write(1, f'__KIMI_CHILD_PID__:{child.pid}\n'.encode())
incoming = threading.Thread(target=copy_stream, args=(0, child.stdin.fileno()), daemon=True)
outgoing = threading.Thread(target=copy_stream, args=(child.stdout.fileno(), 1), daemon=True)
incoming.start()
outgoing.start()
code = child.wait()
outgoing.join(timeout=2)
raise SystemExit(code)
