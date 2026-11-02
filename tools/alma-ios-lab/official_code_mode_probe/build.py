"""Offline iOS staticlib build; all writes confined to this probe directory."""
from pathlib import Path
import hashlib, json, os, shutil, signal, subprocess, tarfile, tempfile, time, tomllib

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
UPSTREAM = REPO / 'shared/third_party/codex/codex-rs'
DATA = HERE.parent / '.cache/v8-ios'
CACHE = HERE / '.cache'
TOOLCHAIN = REPO.parent / 'ALMA/.build/tauri-toolchain'
GIB = 1024 ** 3


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def value(v):
    if isinstance(v, str): return json.dumps(v)
    if isinstance(v, bool): return str(v).lower()
    if isinstance(v, list): return '[' + ', '.join(value(x) for x in v) + ']'
    if isinstance(v, dict): return '{' + ', '.join(json.dumps(k) + '=' + value(x) for k, x in v.items()) + '}'
    return str(v)


def resources():
    free = shutil.disk_usage(HERE).free
    used = sum(p.stat().st_size for p in CACHE.rglob('*') if p.is_file() and not p.is_symlink())
    return {'free_bytes': free, 'private_cache_bytes': used}


def guard():
    snapshot = resources()
    free, used = snapshot['free_bytes'], snapshot['private_cache_bytes']
    if free < 12 * GIB: raise RuntimeError('free space below 12 GiB floor')
    if used > 3 * GIB: raise RuntimeError('private cache exceeded 3 GiB ceiling')
    return snapshot


def prepare():
    CACHE.mkdir(exist_ok=True)
    guard()
    lock_path = HERE.parent / 'v8_plain_probe/source-lock.json'
    lock = json.loads(lock_path.read_text())
    for name, expected in {**lock['artifacts'], 'source.tar.gz': lock['sourceSHA256']}.items():
        if sha(DATA / name) != expected: raise RuntimeError('V8 input hash mismatch: ' + name)
    (HERE / 'source-lock.json').write_text(json.dumps(lock, indent=2) + '\n')
    v8 = CACHE / 'v8-source'
    with tempfile.TemporaryDirectory(dir=CACHE, prefix='verify-v8-') as directory:
        temp = Path(directory)
        with tarfile.open(DATA / 'source.tar.gz') as archive:
            members = archive.getmembers()
            if len(members) > 10000 or sum(m.size for m in members) > 128 * 1024**2:
                raise RuntimeError('source archive exceeds bound')
            archive.extractall(temp, filter='data')
        original = temp / ('rusty_v8-' + lock['commit'])
        if not v8.exists(): shutil.copytree(original, v8, symlinks=True)
        for p in original.rglob('*'):
            if p.is_file() and not p.is_symlink():
                if sha(v8 / p.relative_to(original)) != sha(p): raise RuntimeError('private V8 source changed')
    upstream = tomllib.loads((UPSTREAM / 'Cargo.toml').read_text())
    manifest = tomllib.loads((UPSTREAM / 'code-mode-runtime/Cargo.toml').read_text())
    runtime = CACHE / 'official-runtime'
    if not runtime.exists(): shutil.copytree(UPSTREAM / 'code-mode-runtime', runtime)
    source_hashes = {}
    for p in (UPSTREAM / 'code-mode-runtime').rglob('*'):
        if p.is_file() and p.name != 'Cargo.toml':
            relative = str(p.relative_to(UPSTREAM / 'code-mode-runtime'))
            if sha(runtime / relative) != sha(p): raise RuntimeError('official runtime source changed: ' + relative)
            source_hashes[relative] = sha(p)

    def dependency(name, spec):
        spec = dict(spec) if isinstance(spec, dict) else {'version': spec}
        if spec.pop('workspace', False):
            base = upstream['workspace']['dependencies'][name]
            base = dict(base) if isinstance(base, dict) else {'version': base}
            if 'path' in base: base['path'] = str(UPSTREAM / base['path'])
            features = base.get('features', []) + spec.pop('features', [])
            base.update(spec)
            if features: base['features'] = features
            spec = base
        if name == 'v8':
            spec.pop('features', None)  # Sole deliberate runtime dependency feature difference.
        return spec

    lines = ['[package]', 'name="codex-code-mode-runtime"']
    lines += [k+'='+value(upstream['workspace']['package'][k]) for k in ['version', 'edition', 'license']]
    lines += ['[workspace]', '[lib]', 'name="codex_code_mode_runtime"', 'path="src/lib.rs"', 'doctest=false']
    for section in ['dependencies', 'dev-dependencies']:
        lines.append('['+section+']')
        lines += [name+'='+value(dependency(name, spec)) for name, spec in manifest[section].items()]
    (runtime / 'Cargo.toml').write_text('\n'.join(lines)+'\n')
    fixture = CACHE / 'fixture'
    fixture.mkdir(exist_ok=True)
    root = ['[package]', 'name="alma-official-code-mode-probe"', 'version="0.0.0"', 'edition="2024"', 'publish=false',
            '[workspace]', 'resolver="2"',
            '[lib]', 'crate-type=["staticlib"]', 'path="../../src/lib.rs"',
            '[dependencies]', 'codex-code-mode-runtime={path="../official-runtime"}',
            'codex-protocol='+value({'path':str(UPSTREAM/'protocol')}),
            'serde_json='+value(upstream['workspace']['dependencies']['serde_json']),
            'libc='+value(upstream['workspace']['dependencies']['libc']),
            'tokio='+value(dependency('tokio', {'workspace':True, 'features':['rt-multi-thread','macros','sync','time']})),
            'tokio-util='+value(dependency('tokio-util', {'workspace':True,'features':['rt']})),
            '[patch.crates-io]', 'v8='+value({'path':str(v8)}),
            '[profile.dev]', 'opt-level=0', 'debug=0', 'incremental=false', 'codegen-units=16']
    (fixture / 'Cargo.toml').write_text('\n'.join(root)+'\n')
    if not (fixture / 'Cargo.lock').exists():
        seed = HERE/'Cargo.lock' if (HERE/'Cargo.lock').exists() else REPO/'shared/rust-bridge/Cargo.lock'
        shutil.copyfile(seed, fixture / 'Cargo.lock')
    home = CACHE / 'cargo-home'
    (home / 'registry').mkdir(parents=True, exist_ok=True)
    for name in ['src', 'cache']:
        target = home / 'registry' / name
        target.mkdir(exist_ok=True)
        for registry in (TOOLCHAIN/'cargo/registry'/name).iterdir():
            if registry.is_dir():
                local = target/registry.name
                local.mkdir(exist_ok=True)
                for entry in registry.iterdir():
                    if not (local/entry.name).exists():
                        (local/entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
    if not (home/'registry/index').exists(): shutil.copytree(TOOLCHAIN/'cargo/registry/index', home/'registry/index')
    # This graph uses registry/upstream paths and the verified local V8 source.
    # Do not duplicate unrelated shared git metadata (528 MB logical in the first run).
    # This exact data-only dependency was absent from the initial cache. The
    # optional replay fetch is independently bounded and checksum-locked; Cargo
    # remains offline and no V8 source/binary download or source build is enabled.
    icu_lock = HERE/'icu-artifact.json'
    if icu_lock.exists():
        icu = json.loads(icu_lock.read_text())
        target = home/'registry/cache/index.crates.io-1949cf8c6b5b557f/deno_core_icudata-0.78.0.crate'
        if not target.exists():
            subprocess.run(['curl','--fail','--location','--max-time','45','--max-filesize','41943040',
                            '--silent','--show-error',icu['url'],'-o',str(target)],check=True,timeout=50)
        if sha(target) != icu['sha256']: raise RuntimeError('ICU archive checksum mismatch')
    evidence = {'codex_revision':'6ff1e1ca3b30fc8b914720681fcf5fe62e95f856',
                'runtime_source_hashes':source_hashes, 'runtime_source_unchanged':True,
                'sandbox_test_preserved':'src/runtime/mod.rs::linked_v8_has_sandbox_enabled',
                'sandbox_test_executed':False, 'v8_memory_sandbox_enabled':False,
                'manifest_difference':'Expand workspace metadata/dependencies/lints; omit v8_enable_sandbox only in probe runtime manifest; no Rust/JS edits',
                'v8_inputs':lock, 'build_bounds':{'jobs':2,'seconds':600,'cache_bytes':3*GIB,'free_floor_bytes':12*GIB}}
    (HERE/'source-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n')
    return fixture, home, lock


def main():
    fixture, home, lock = prepare()
    shutil.copyfile(fixture/'Cargo.toml',HERE/'fixture-manifest.toml')
    shutil.copyfile(CACHE/'official-runtime/Cargo.toml',HERE/'runtime-manifest.toml')
    report = {'before':guard(),'compiled':False,'device_run':False}
    env = dict(os.environ, CARGO_HOME=str(home), RUSTUP_HOME=str(TOOLCHAIN/'rustup'),
               RUSTUP_TOOLCHAIN='stable-aarch64-apple-darwin', CARGO_TARGET_DIR=str(CACHE/'target'),
               CARGO_NET_OFFLINE='true', RUSTC_WRAPPER='', SCCACHE_DISABLE='1',
               DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer', IPHONEOS_DEPLOYMENT_TARGET='18.0',
               RUSTY_V8_ARCHIVE=str(DATA/'v8-ios.a.gz'), RUSTY_V8_ARCHIVE_SHA256=lock['artifacts']['v8-ios.a.gz'],
               RUSTY_V8_SRC_BINDING_PATH=str(DATA/'bindings-ios.rs'))
    for key in ['V8_FROM_SOURCE','RUSTY_V8_MIRROR','RUSTY_V8_SRC_BINDING_URL','DOCS_RS','RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS']:
        env.pop(key,None)
    env['PATH']=str(TOOLCHAIN/'cargo/bin')+os.pathsep+env['PATH']
    command=[str(TOOLCHAIN/'cargo/bin/cargo'),'build','--offline','--manifest-path',str(fixture/'Cargo.toml'),'--target','aarch64-apple-ios','-j','2']
    if (HERE/'Cargo.lock').exists(): command.append('--locked')
    begin=time.monotonic()
    with (CACHE/'build.log').open('w') as log:
        process=subprocess.Popen(command,cwd=HERE,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:
            while process.poll() is None:
                report['latest_resources']=guard()
                if time.monotonic()-begin>600: raise RuntimeError('600-second build deadline')
                time.sleep(2)
            report['exit_code']=process.returncode
            report['compiled']=process.returncode==0
        except BaseException as error:
            os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
            report['stopped_reason']=str(error)
    report['host_seconds']=time.monotonic()-begin
    report['after']=resources()
    if report['after']['private_cache_bytes'] > 3*GIB or report['after']['free_bytes'] < 12*GIB:
        report['stopped_reason']='Final resource ceiling/floor violated; no subsequent checks permitted'
    report['command']=command
    if report['compiled']:
        archive=CACHE/'target/aarch64-apple-ios/debug/libalma_official_code_mode_probe.a'
        report['staticlib']={'path':str(archive),'bytes':archive.stat().st_size,'sha256':sha(archive)}
        shutil.copyfile(fixture/'Cargo.toml',HERE/'fixture-manifest.toml')
        shutil.copyfile(CACHE/'official-runtime/Cargo.toml',HERE/'runtime-manifest.toml')
        shutil.copyfile(fixture/'Cargo.lock',HERE/'Cargo.lock')
        if 'stopped_reason' not in report:
            tree = subprocess.run([str(TOOLCHAIN/'cargo/bin/cargo'),'tree','--offline','--locked',
                                   '--manifest-path',str(fixture/'Cargo.toml'),'--target','aarch64-apple-ios',
                                   '-e','features','-i','v8'],env=env,cwd=HERE,capture_output=True,text=True,timeout=15)
            (HERE/'v8-feature-tree.txt').write_text(tree.stdout+tree.stderr)
            report['v8_feature_tree_exit']=tree.returncode
            report['v8_sandbox_feature_present']='v8_enable_sandbox' in tree.stdout
    (HERE/'build-evidence.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
    raise SystemExit(0 if report['compiled'] and 'stopped_reason' not in report else 1)


if __name__=='__main__': main()
