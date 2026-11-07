"""Mac-only real Kimi SDK probe in the pinned ARM64 iSH guest; no phone/account."""
from pathlib import Path
import argparse, hashlib, json, shutil, sys

HERE = Path(__file__).resolve().parent
LAB = HERE.parent / 'alma-ios-lab'
sys.path.insert(0, str(LAB))
from ish_probe import run_case

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--kimi-dir', type=Path, required=True, help='Prepared opt/kimi containing sdk/ and node_modules/')
    p.add_argument('--mode', choices=['import', 'session', 'fixture', 'cancel', 'live'], required=True)
    p.add_argument('--run', required=True)
    p.add_argument('--dependency-store', type=Path, help='Existing upstream pnpm store; opt into node-fetch bindings')
    p.add_argument('--source-lock', type=Path, help='Reviewed SDK build lock for a newer fixed release')
    p.add_argument('--prepare-only', action='store_true')
    a = p.parse_args()
    if not a.run.replace('-', '').replace('_', '').isalnum():
        raise ValueError('Invalid run name')
    if shutil.disk_usage(HERE).free < 8 * 1024**3:
        raise RuntimeError('Insufficient disk reserve')
    source = a.kimi_dir.resolve()
    sdk_hash = '25b5db0e89c1c47655e08d72a344d6bebed77f9b07571a2e7ae317b341c748f4'
    if a.source_lock:
        sdk_hash = json.loads(a.source_lock.read_text())['sdkIndexSHA256']
    if digest(source / 'sdk/index.mjs') != sdk_hash:
        raise ValueError('SDK bundle does not match the reviewed source lock')
    if a.mode == 'live' and not a.prepare_only:
        raise ValueError('Prepare live payload, then run live-host.mjs with the private token file')
    binary = LAB / '.cache/ish-host-build/ish'
    provenance = json.loads((LAB / '.cache/ish-host-build-provenance.json').read_text())
    if digest(binary) != provenance['binarySHA256']:
        raise ValueError('iSH binary differs from recorded provenance')
    base = LAB / '.cache/runtime-rootfs/354d49ec25295e6c/fs'
    work = HERE / '.cache' / a.run
    work.mkdir(parents=True, exist_ok=False)
    payload = work / 'payload'
    payload.mkdir()
    records = []
    for directory in ['sdk', 'node_modules']:
        src = source / directory
        if not src.is_dir(): raise FileNotFoundError(src)
        # Copy only the distributable SDK closure, never source home/config/account.
        for path in sorted(src.rglob('*')):
            if path.is_symlink(): raise ValueError('Unexpected SDK dependency symlink')
            if path.is_file():
                records.append({'path': str(path.relative_to(source)), 'bytes': path.stat().st_size, 'sha256': digest(path)})
        shutil.copytree(src, payload / 'kimi' / directory)
    if a.dependency_store:
        # Existing pure-JS packages; do not install or alter the parent SDK.
        packages = {'node-fetch': '3.3.2', 'data-uri-to-buffer': '4.0.1', 'fetch-blob': '3.2.0',
                    'formdata-polyfill': '4.0.10', 'node-domexception': '1.0.0', 'web-streams-polyfill': '3.3.3'}
        for name, version in packages.items():
            src = a.dependency_store.resolve() / f'{name}@{version}' / 'node_modules' / name
            package = json.loads((src / 'package.json').read_text())
            if package['name'] != name or package['version'] != version: raise ValueError('Dependency identity mismatch')
            for path in sorted(src.rglob('*')):
                if path.is_symlink(): raise ValueError('Unexpected ponyfill package symlink')
                if path.is_file(): records.append({'path': 'runtime/node_modules/' + name + '/' + str(path.relative_to(src)),
                    'bytes': path.stat().st_size, 'sha256': digest(path)})
            shutil.copytree(src, payload / 'runtime/node_modules' / name)
    shutil.copyfile(HERE / 'probe.mjs', payload / 'probe.mjs')
    shutil.copyfile(HERE / 'pipe-fetch.mjs', payload / 'pipe-fetch.mjs')
    root = work / 'fs'
    shutil.copytree(base, root)
    workspace = work / 'workspace'
    workspace.mkdir()
    inputs = {'kimiSourceDirectory': str(source), 'files': records,
              'payloadBytes': sum(r['bytes'] for r in records), 'hostProvenance': provenance,
              'probeSHA256': digest(HERE / 'probe.mjs'), 'rootfsID': '354d49ec25295e6c',
              'scope': 'unpatched upstream C host iSH lane, not current patched Rust backend or phone'}
    (work / 'inputs.json').write_text(json.dumps(inputs, indent=2) + '\n')
    if a.prepare_only:
        print(json.dumps({'prepared': str(work), 'sdkIndexSHA256': sdk_hash}))
        return 0
    script = 'env -i PATH=/usr/bin:/bin HOME=/probe-work/home TMPDIR=/tmp '
    if a.dependency_store: script += 'ALMA_KIMI_FETCH_BINDINGS=node-fetch '
    script += 'node /probe/probe.mjs ' + a.mode
    result = run_case(a.mode, script, root, work / 'results', timeout=180,
                      mounts=[f'/probe={payload}:ro', f'/probe-work={workspace}:rw'])
    parsed = []
    for line in result['stdout'].splitlines():
        try: parsed.append(json.loads(line))
        except json.JSONDecodeError: pass
    terminal = next((x for x in reversed(parsed) if x.get('type') == 'result'), None)
    summary = {'mode': a.mode, 'run': a.run, 'passed': result['returncode'] == 0 and result['stopReason'] is None and terminal is not None and terminal['success'],
               'seconds': result['seconds'], 'peakSampledRSSBytes': result['peakSampledRSSBytes'],
               'guestReturncode': result['guestReturncode'], 'stopReason': result['stopReason'],
               'events': parsed, 'scope': inputs['scope'], 'noRealModelOrAccount': True,
               'transport': 'in-memory fixture; HTTP/SSE network transport is NOT qualified'}
    (work / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0 if summary['passed'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
