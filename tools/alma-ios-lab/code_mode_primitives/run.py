#!/usr/bin/env python3
"""Run bounded packaged-Node primitives through an unchanged Mac iSH harness."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import shutil
import signal
import subprocess
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
CACHE = HERE / '.cache'
ROOT = CACHE / 'rootfs'
FIXTURE = CACHE / 'native-fixture'
BINARY = REPO / 'patches/ish-native-workspace/.cache/native-ish'
BASELINE = REPO / 'tools/alma-ios-lab/.cache/runtime-rootfs/354d49ec25295e6c/fs'
OFFICIAL = REPO / 'shared/third_party/codex/codex-rs/code-mode-runtime'
PRIMARY_GROUPS = ['modules', 'settled', 'exit-sync', 'exit-async', 'cpu']
GROUPS = PRIMARY_GROUPS + ['baseline', 'flags', 'vm', 'worker-load', 'process-exit', 'process-cpu']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree_digest(path):
    result = hashlib.sha256()
    for entry in sorted(path.rglob('*')):
        if entry.is_symlink():
            raise RuntimeError('unexpected host symlink in private/source rootfs: ' + str(entry))
        if entry.is_file():
            result.update(str(entry.relative_to(path)).encode())
            result.update(bytes.fromhex(digest(entry)))
    return result.hexdigest()


def before_exec():
    # Applied in the native child before iSH starts, covering all its guest threads.
    resource.setrlimit(resource.RLIMIT_CPU, (20, 24))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def bounded(command, env, timeout, input_bytes=None):
    assert 0 < timeout <= 30
    started = time.monotonic()
    child = subprocess.Popen(command, stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                             start_new_session=True, preexec_fn=before_exec)
    expired = False
    try:
        out, err = child.communicate(input=input_bytes, timeout=timeout)
    except subprocess.TimeoutExpired:
        expired = True
        os.killpg(child.pid, signal.SIGKILL)
        out, err = child.communicate(timeout=3)
    try:
        os.killpg(child.pid, 0)
    except ProcessLookupError:
        group_gone = True
    else:
        group_gone = False
        os.killpg(child.pid, signal.SIGKILL)
    return {'host_seconds': round(time.monotonic() - started, 4),
            'host_watchdog_seconds': timeout, 'watchdog_fired': expired,
            'host_exit': child.returncode, 'host_process_group_gone': group_gone,
            'stdout': out.decode('utf8', errors='replace'),
            'stderr': err.decode('utf8', errors='replace')}


def prepare():
    CACHE.mkdir(exist_ok=True)
    if not ROOT.exists():
        shutil.copytree(BASELINE, ROOT, symlinks=True)
    for directory in ('input', 'tmp'):
        (FIXTURE / directory).mkdir(parents=True, exist_ok=True)
    shutil.copyfile(HERE / 'primitives.cjs', FIXTURE / 'input/primitives.cjs')
    shutil.copyfile(HERE / 'process-alternative.cjs', FIXTURE / 'input/process-alternative.cjs')
    shutil.copyfile(OFFICIAL / 'src/runtime/settled.js', FIXTURE / 'input/settled.js')
    expected = [
        ('preserves_settlement_order_before_and_during_iteration', [
            {'index': 2, 'status': 'fulfilled', 'value': 'two'},
            {'index': 0, 'status': 'fulfilled', 'value': 'zero'},
            {'index': 3, 'status': 'fulfilled', 'value': 'three'},
            {'index': 1, 'status': 'fulfilled', 'value': 'one'}]),
        ('accepts_iterables_values_thenables_and_duplicate_promises', [
            {'index': 0, 'status': 'fulfilled', 'value': 42},
            {'index': 1, 'status': 'fulfilled', 'value': 'thenable'},
            {'index': 2, 'status': 'fulfilled', 'value': 'shared'},
            {'index': 3, 'status': 'fulfilled', 'value': 'shared'},
            {'index': 4, 'status': 'rejected', 'reason': {'message': 'failed'}},
            {'index': 5, 'status': 'rejected', 'reason': 'getter failed'}]),
        ('preserves_map_keys_and_completes_empty_inputs', [
            {'index': 'success', 'status': 'fulfilled', 'value': 7},
            {'index': 'failure', 'status': 'rejected', 'reason': 'failed'}]),
        ('awaits_each_callback_including_rejected_inputs', [
            {'index': 0, 'status': 'rejected', 'reason': 'failed'}, ['callback finished', 0],
            {'index': 1, 'status': 'fulfilled', 'value': 2}, ['callback finished', 1], 'stream finished']),
        ('propagates_callback_errors_and_closes_early_iterations', [
            {'index': 0, 'status': 'fulfilled', 'value': 1}, True,
            {'index': 0, 'status': 'fulfilled', 'value': 3}, {'done': True}]),
        ('preserves_identity_of_keys_values_and_rejections', [True, True]),
    ]
    tests = (OFFICIAL / 'tests/settled.rs').read_text()
    fixtures = []
    for name, values in expected:
        suffix = tests[tests.index('async fn ' + name + '('):]
        source = re.search(r'r#"([\s\S]*?)"#', suffix).group(1)
        fixtures.append({'name': name, 'source': source, 'expected': values})
    (FIXTURE / 'input/settled-fixtures.json').write_text(json.dumps(fixtures) + '\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--groups', nargs='+', choices=GROUPS, default=PRIMARY_GROUPS)
    parser.add_argument('--report', default='results.json')
    args = parser.parse_args()
    assert Path(args.report).name == args.report and args.report.endswith('.json')
    assert BINARY.is_file() and BASELINE.is_dir()
    inputs_before = {'native_ish_sha256': digest(BINARY),
                     'source_rootfs_tree_sha256': tree_digest(BASELINE),
                     'official_settled_sha256': digest(OFFICIAL / 'src/runtime/settled.js'),
                     'official_settled_tests_sha256': digest(OFFICIAL / 'tests/settled.rs')}
    prepare()
    env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'C.UTF-8'}
    # Bootstrap writes through guest fakefs APIs; never edit data/ directly.
    setup = bounded([str(BINARY), '-f', str(ROOT), '/bin/sh', '-c',
                     'mkdir -p /controller; cat > /controller/main.py'],
                    env, 10, (HERE / 'controller.py').read_bytes())
    assert setup['host_exit'] == 0 and not setup['watchdog_fired'], setup
    env.update(ISH_ENABLE_SESSION_JOBS='1', ISH_ENABLE_WORKSPACE_POLICY='1',
               ISH_POLICY_READ_ROOTS='/bin:/sbin:/usr:/lib:/etc:/workspace/input',
               ISH_POLICY_WRITE_ROOTS='/workspace/tmp',
               ALMA_PRIVATE_NATIVE_WORKSPACE=str(FIXTURE))
    report = {'scope': 'Actual packaged Node22 in Mac iSH; primitives only, no provider/protocol/phone/auth/model/network qualification',
              'inputs': inputs_before, 'node_package': json.loads((BASELINE / 'alma-tools.json').read_text())['version'],
              'read_roots': env['ISH_POLICY_READ_ROOTS'].split(':'),
              'write_roots': env['ISH_POLICY_WRITE_ROOTS'].split(':'),
              'direct_network_policy': 'DenyDirect (host registration network=0); no network tests',
              'workspace_gate': 'none; /workspace is only this private test fixture, not model workspace',
              'host_cpu_limits_seconds': {'soft': 20, 'hard': 24}, 'host_core_dump_limit_bytes': 0,
              'bootstrap': setup, 'runs': []}
    result_path = HERE / args.report
    for group in args.groups:
        phase_path = FIXTURE / 'tmp/cpu-phase.json'
        phase_path.unlink(missing_ok=True)
        worker_phase_path = FIXTURE / 'tmp/cpu-worker-phase.json'
        worker_phase_path.unlink(missing_ok=True)
        (FIXTURE / 'input/selection.json').write_text(json.dumps({'group': group}) + '\n')
        run = bounded([str(BINARY), '-f', str(ROOT), '/usr/bin/python3', '-B', '/controller/main.py'], env, 30)
        run['group'] = group
        if phase_path.exists():
            run['last_cpu_phase'] = json.loads(phase_path.read_text())
        if worker_phase_path.exists():
            run['last_worker_cpu_phase'] = json.loads(worker_phase_path.read_text())
        try:
            controller = json.loads(run['stdout'].strip())
            run['controller'] = controller
            run['primitives'] = json.loads(controller['stdout'].strip())
            if group == 'process-cpu':
                valid = (run['primitives'].get('phase') == 'loop-entering'
                         and controller.get('owned_cancel_requested') is True
                         and controller['child_exit'] == -9)
                run['primitives'].update(passed=valid, cases=[{'name': 'separate_owned_process_cpu_cancel', 'passed': valid}])
            elif group == 'process-exit':
                valid = (run['primitives'].get('phase') == 'exit-requested'
                         and run['primitives'].get('output') == ['before']
                         and run['primitives'].get('writes') == {'phase': 'before'}
                         and controller['child_exit'] == 0)
                run['primitives'].update(passed=valid, cases=[{'name': 'separate_process_exit_preserves_prior_write_set', 'passed': valid}])
            run['passed'] = (run['host_exit'] == 0 and not run['watchdog_fired']
                             and run['host_process_group_gone']
                             and controller['cleanup_confirmed']
                             and run['primitives']['passed'])
        except (ValueError, KeyError):
            run['passed'] = False
        report['runs'].append(run)
        result_path.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'group': group, 'passed': run['passed'],
                          'host_seconds': run['host_seconds'], 'exit': run['host_exit'],
                          'watchdog_fired': run['watchdog_fired']}), flush=True)
    report['read_only_inputs_unchanged'] = (
        digest(BINARY) == inputs_before['native_ish_sha256']
        and tree_digest(BASELINE) == inputs_before['source_rootfs_tree_sha256']
        and digest(OFFICIAL / 'src/runtime/settled.js') == inputs_before['official_settled_sha256']
        and digest(OFFICIAL / 'tests/settled.rs') == inputs_before['official_settled_tests_sha256'])
    report['all_requested_groups_passed'] = all(run['passed'] for run in report['runs'])
    report['passed_case_count'] = sum(sum(case['passed'] for case in run.get('primitives', {}).get('cases', [])) for run in report['runs'])
    report['test_source_sha256'] = {name: digest(HERE / name) for name in ['run.py', 'controller.py', 'primitives.cjs', 'process-alternative.cjs']}
    result_path.write_text(json.dumps(report, indent=2) + '\n')
    return 0 if report['all_requested_groups_passed'] and report['read_only_inputs_unchanged'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
