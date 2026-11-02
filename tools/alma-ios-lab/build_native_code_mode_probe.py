#!/usr/bin/env python3
"""Bounded, opt-in iOS build with verified native V8 inputs; never installs/runs."""
from pathlib import Path
import argparse
import json
import os
import shutil
import signal
import subprocess
import time

HERE = Path(__file__).resolve().parent

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--allow-purgeable-capacity', action='store_true',
                        help='Use a 6 GiB immediate floor only after Foundation confirms at least 64 GiB important-use capacity; never remove snapshots')
    args = parser.parse_args()
    env = dict(os.environ)
    verified = json.loads(subprocess.check_output(
        ['python3', str(HERE/'prepare_native_v8.py'), '--check-only', '--print-env-json'], text=True))
    env.update(verified)
    for key in ['V8_FROM_SOURCE', 'RUSTY_V8_MIRROR', 'RUSTY_V8_SRC_BINDING_URL', 'DOCS_RS']:
        env.pop(key, None)
    command = ['bash', str(HERE/'cargo_ios.sh'), 'check' if args.check else 'rustc',
               '--locked', '--offline', '-p', 'codex-mobile-client', '--target', 'aarch64-apple-ios',
               '--profile', 'ios-dev', '--no-default-features', '--features', 'alma-code-mode-probe', '-j', '2']
    if not args.check:
        command += ['--crate-type', 'staticlib']
    mode = 'check' if args.check else 'staticlib'
    log = HERE/'.cache'/f'native-code-mode-{mode}.log'
    receipt_path = HERE/'.cache'/f'native-code-mode-{mode}.json'
    if receipt_path.exists():
        history = HERE/'.cache/native-code-mode-history'/str(time.time_ns())
        history.mkdir(parents=True)
        shutil.copyfile(receipt_path, history/'receipt.json')
        if log.exists(): shutil.copyfile(log, history/'build.log')
    started = time.monotonic()
    receipt = {'mode': mode, 'command': command, 'phoneRun': False,
               'scope': 'opt-in qualification; JIT disabled; no desktop V8 memory sandbox',
               'freeDiskFloorBytes': 12*1024**3, 'deadlineSeconds': 600 if args.check else 1800}
    if args.allow_purgeable_capacity:
        # APFS snapshots can make statvfs under-report reclaimable capacity.
        # Read the system estimate; do not delete or thin the user's backups.
        source = ('import Foundation; let u=URL(fileURLWithPath:CommandLine.arguments[1]); '
                  'let v=try u.resourceValues(forKeys:[.volumeAvailableCapacityForImportantUsageKey]); '
                  'print(v.volumeAvailableCapacityForImportantUsage ?? -1)')
        important = int(subprocess.check_output(
            ['xcrun', 'swift', '-e', source, str(HERE)], text=True, timeout=30,
            env=dict(env, DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')).strip())
        if important < 64*1024**3:
            raise RuntimeError('Important-use capacity is below 64 GiB; retain the default floor')
        receipt['importantUseCapacityBytesAtStart'] = important
        receipt['freeDiskFloorBytes'] = 6*1024**3
    if shutil.disk_usage(HERE).free < receipt['freeDiskFloorBytes']:
        raise RuntimeError('Not enough free space for the bounded build')
    with log.open('w') as output:
        process = subprocess.Popen(command, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            while process.poll() is None:
                if shutil.disk_usage(HERE).free < receipt['freeDiskFloorBytes']:
                    raise RuntimeError('Free-space floor reached')
                if time.monotonic()-started > receipt['deadlineSeconds']:
                    raise RuntimeError('Build deadline reached')
                time.sleep(2)
        except BaseException as error:
            os.killpg(process.pid, signal.SIGTERM)
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            receipt['stoppedReason'] = str(error)
        receipt.update(exitCode=process.returncode, seconds=time.monotonic()-started,
                       freeBytesAfter=shutil.disk_usage(HERE).free)
    receipt_path.write_text(json.dumps(receipt, indent=2)+'\n')
    print(json.dumps(receipt, indent=2))
    print('\n'.join(log.read_text().splitlines()[-12:]))
    return 0 if receipt['exitCode'] == 0 and 'stoppedReason' not in receipt else 1

if __name__ == '__main__':
    raise SystemExit(main())
