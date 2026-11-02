"""Run the baseline and write compact evidence. Never accepts arbitrary mounts."""
from pathlib import Path
import argparse
import datetime
import json
import os
import re
import shlex
import shutil
import stat
import tempfile
from bounded import clean_env, run
from prepare import HERE, CACHE, BUILD, PIN, sha

CASES = ['normal', 'readonly', 'readonly-hardlink', 'paths', 'realfs-shell',
         'realfs-syscall', 'realfs-nonroot', 'realfs-readonly', 'realfs-alias',
         'realfs-replace', 'realfs-remount']
SENTINEL = 'SYNTHETIC_SENTINEL\n'


def guest(root, script, log, mounts, timeout=45):
    # Only this harness's disposable cache may ever be exposed to a guest.
    assert root.resolve().is_relative_to(CACHE.resolve())
    for _, host, _ in mounts:
        assert host.resolve().is_relative_to(CACHE.resolve())
        assert not any(c in str(host) for c in ',=:\n')
    env = clean_env()
    env['ISH_BIND_MOUNTS'] = ','.join(f'{g}={h}:{m}' for g, h, m in mounts)
    wrapped = '/bin/sh -c ' + shlex.quote(script)
    wrapped += '; rc=$?; printf "\n__GUEST_EXIT__:%d\n" "$rc"; exit "$rc"'
    result = run([BUILD / 'ish', '-f', root, '/bin/sh', '-c', wrapped],
                 log, cwd=HERE, env=env, timeout=timeout)
    output = log.read_text(errors='replace')
    codes = re.findall(r'^__GUEST_EXIT__:(\d+)$', output, re.M)
    result['guestExit'] = int(codes[-1]) if codes else None
    result['observations'] = [json.loads(line[8:]) for line in output.splitlines()
                              if line.startswith('__OBS__:')]
    result['fatalDiagnostic'] = bool(re.search(
        r'SAFETY-VALVE|HOST CRASH|Assertion|Segmentation fault|Traceback', output))
    return result, output


def snapshot(root):
    result = {}
    # Never follow symlinks while collecting host evidence.
    for area in ['input', 'toolbase', 'hidden']:
        for path in sorted((root / area).rglob('*')):
            mode = path.lstat().st_mode
            key = str(path.relative_to(root))
            if stat.S_ISREG(mode):
                result[key] = {'sha256': sha(path), 'bytes': path.stat().st_size,
                               'mode': oct(stat.S_IMODE(mode))}
            elif stat.S_ISDIR(mode):
                result[key] = {'directory': True}
            elif stat.S_ISLNK(mode):
                result[key] = {'symlink': os.readlink(path)}
    return result


def fixture(root):
    for name in ['input', 'toolbase', 'output', 'scratch', 'hidden', 'fixtures']:
        (root / name).mkdir()
    for name in ['overwrite', 'truncate', 'rename', 'unlink', 'chmod', 'hardlink',
                 'shell', 'node']:
        (root / 'input' / name).write_text(SENTINEL)
    (root / 'input/fixture.json').write_text(json.dumps({'text': '中文 English 😀 "quotes"\n'}, ensure_ascii=False))
    (root / 'toolbase/sentinel').write_text(SENTINEL)
    (root / 'hidden/sentinel').write_text(SENTINEL)
    (root / 'hidden/sentinel').chmod(0o666)  # Nonroot guest control, disposable only.
    for name in ['absolute-file', 'relative-file', 'absolute-dir', 'relative-dir']:
        d = root / 'hidden' / name
        d.mkdir()
        (d / 'sentinel').write_text(SENTINEL)
        target = d if name.endswith('dir') else d / 'sentinel'
        if name.startswith('relative'):
            target = Path(os.path.relpath(target, root / 'output'))
        (root / 'output' / ('host-' + name)).symlink_to(target)
    shutil.copyfile(HERE / 'guest.py', root / 'fixtures/guest.py')
    (root / 'fixtures/config.json').write_text(json.dumps(
        {k: str(root / k) for k in ['input', 'hidden']}))
    return [(g, root / h, mode) for g, h, mode in [
        ('/input', 'input', 'ro'), ('/toolbase', 'toolbase', 'ro'),
        ('/output', 'output', 'rw'), ('/scratch', 'scratch', 'rw'),
        ('/fixtures', 'fixtures', 'ro')]]


def healthy(result):
    return (result['hostExit'] == 0 and result['guestExit'] == 0
            and result['stopReason'] is None and not result['fatalDiagnostic'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--case', choices=CASES, action='append')
    args = parser.parse_args()
    CACHE.mkdir(exist_ok=True)
    provenance = json.loads((CACHE / 'build.json').read_text())
    assert sha(BUILD / 'ish') == provenance['binarySHA256']
    suite = Path(tempfile.mkdtemp(prefix='run-', dir=CACHE))
    # Fresh pinned base, fresh offline package install on every run.
    template = suite / 'template'
    shutil.copytree(CACHE / 'base/fs', template, symlinks=True)
    install, output = guest(template,
        'apk add --no-network /packages/*.apk && printf "INSTALL_OK\\n"',
        suite / 'install.log', [('/packages', CACHE / 'packages', 'ro')], 180)
    if not healthy(install) or 'INSTALL_OK' not in output:
        raise RuntimeError(f'Install failed: {install}; see {suite}/install.log')
    reports = []
    for name in args.case or CASES:
        root = suite / name
        root.mkdir()
        mounts = fixture(root)
        guestroot = root / 'rootfs'
        shutil.copytree(template, guestroot, symlinks=True)
        # Remove the installation-only package mapping in the private copy.
        package_link = guestroot / 'data/packages'
        if package_link.is_symlink():
            package_link.unlink()
        before = snapshot(root)
        result, output = guest(guestroot, 'python3 /fixtures/guest.py ' + name,
                               root / 'guest.log', mounts)
        after = snapshot(root)
        changes = {k: {'before': before.get(k), 'after': after.get(k)}
                   for k in sorted(before.keys() | after.keys()) if before.get(k) != after.get(k)}
        complete = healthy(result) and '__CASE_COMPLETE__:' + name in output
        violations = [x['name'] for x in result['observations']
                      if x['expectedDenied'] and x['succeeded']]
        checks = {}
        if name == 'normal':
            file = root / 'output/中文 notes.json'
            checks['hostOutputMatches'] = file.exists() and json.loads(file.read_text()) == {
                'text': '中文 English 😀 "quotes"\n', 'phase': 'node'}
            checks['protectedSentinelsUnchanged'] = not changes
            complete &= all(checks.values())
        report = {'case': name, **result, 'complete': bool(complete),
                  'policyViolations': violations, 'protectedHostChanges': changes,
                  'hostChecks': checks}
        reports.append(report)
        (root / 'evidence.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'case': name, 'complete': bool(complete),
              'violations': violations, 'hostChanges': list(changes)}, ensure_ascii=False), flush=True)
        # Delete only this case's disposable guest copy, preserving fixtures/logs/evidence.
        shutil.rmtree(guestroot)
    report = {'schema': 1, 'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'scope': 'macOS ARM64 host iSH C CLI; no phone, Rust exec hook, native tools or model calls',
              'verdict': 'current baseline fails isolation' if any(r['policyViolations'] or r['protectedHostChanges'] for r in reports)
                         else 'no bypass observed in selected cases; not an isolation proof',
              'allCasesComplete': all(r['complete'] for r in reports),
              'ishCommit': PIN, 'build': provenance, 'install': install,
              'limits': {'commandSeconds': 45, 'installSeconds': 180,
                         'sampledRSSGuardBytes': 1536 * 1024**2,
                         'cleanup': 'SIGKILL own process group on every exit'},
              'diagnostics': str(suite.relative_to(HERE)), 'cases': reports}
    (suite / 'evidence.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    (CACHE / 'latest.json').write_text(json.dumps({'run': str(suite)}) + '\n')
    print('Evidence: ' + str(suite / 'evidence.json'))
    if not report['allCasesComplete']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
