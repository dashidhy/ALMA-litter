#!/usr/bin/env python3
"""Original TS -> actual Rust differential, offline host-only, bounded writes."""
from pathlib import Path
import hashlib,json,os,shutil,signal,subprocess,time,tomllib

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[2]
ALMA=REPO.parent/'ALMA'
MAC=ALMA/'app/TAH'
TOOLCHAIN=ALMA/'.build/tauri-toolchain'
CACHE=HERE/'.cache'
LIMIT=1024**3
SOURCES={'tah_attempt.rs': REPO/'shared/rust-bridge/codex-mobile-client/src/tah_attempt.rs',
         'scoped_files.rs': REPO.parent/'ALMA-codex/ios/native/src/scoped_files.rs'}


def sha(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def size():
    return sum(p.stat().st_size for p in CACHE.rglob('*') if p.is_file() and not p.is_symlink())


def guard():
    if size()>LIMIT:raise RuntimeError('1 GiB new-cache ceiling exceeded; stopped')


def bounded(argv,name,env,timeout):
    guard();begin=time.monotonic();reason=None
    with (CACHE/(name+'.log')).open('wb') as log:
        proc=subprocess.Popen(argv,cwd=HERE,env=env,stdin=subprocess.DEVNULL,
                              stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:
            while proc.poll() is None:
                guard()
                if time.monotonic()-begin>timeout:raise RuntimeError('external deadline exceeded')
                time.sleep(.2)
        except BaseException as error:
            reason=str(error);os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=3)
    if size()>LIMIT:reason='1 GiB new-cache ceiling exceeded'
    return {'command':argv,'exit':proc.returncode,'host_seconds':round(time.monotonic()-begin,4),
            'deadline_seconds':timeout,'stopped_reason':reason,'log':str(CACHE/(name+'.log'))}


def main():
    CACHE.mkdir(exist_ok=True);guard()
    original={name:sha(path) for name,path in SOURCES.items()}
    report={'source_hashes_before':original,'source_paths':{k:str(v) for k,v in SOURCES.items()},
            'scope':'Original Mac builder/projector fixtures -> unchanged production Rust module; no mobile build, device, model, auth or network',
            'limits':{'new_cache_bytes':LIMIT,'jobs':2,'build_seconds':180},'runs':[]}
    (HERE/'cases.json').unlink(missing_ok=True) # Only this harness's prior result, never fixture/source data.
    env=dict(os.environ)
    for key in ['RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER','RUSTC','SDKROOT','IPHONEOS_DEPLOYMENT_TARGET']:
        env.pop(key,None)
    try:
        generation=bounded(['node',str(MAC/'node_modules/vitest/vitest.mjs'),'run','--config',str(HERE/'vitest.config.ts')],
                           'generate',env,30)
        report['runs'].append(generation)
        if generation['exit'] or generation['stopped_reason']:raise RuntimeError('Original TS fixture generation failed')
        shutil.copyfile(CACHE/'fixtures/generation.json',HERE/'generation.json')
        for directory in ['harness','cargo-home/registry','target','workspaces','tmp']:(CACHE/directory).mkdir(parents=True,exist_ok=True)
        home=CACHE/'cargo-home'
        for name in ['src','cache']:
            target=home/'registry'/name
            if not target.exists():target.symlink_to(TOOLCHAIN/'cargo/registry'/name,target_is_directory=True)
        if not (home/'registry/index').exists():shutil.copytree(TOOLCHAIN/'cargo/registry/index',home/'registry/index')
        guard()
        root=CACHE/'harness'
        scaffold='uniffi::setup_scaffolding!();\n'
        for name,path in SOURCES.items():
            scaffold+=f'#[allow(dead_code)]\n#[path = {json.dumps(str(path))}]\nmod {name[:-3]};\n'
        scaffold+=f'#[cfg(test)]\n#[path = {json.dumps(str(HERE/"tests.rs"))}]\nmod tests;\n'
        (root/'lib.rs').write_text(scaffold)
        versions={'serde':'1.0.228','serde_json':'1.0.149','sha2':'0.10.9','base64':'0.22.1','uuid':'1.22.0','uniffi':'0.31.0','libc':'0.2.191'}
        packages=tomllib.loads((REPO/'shared/rust-bridge/Cargo.lock').read_text())['package']
        for name,version in versions.items():
            if not any(p['name']==name and p['version']==version for p in packages):raise RuntimeError('Main lock version drift: '+name)
        lines=['[package]','name="alma-tah-attempt-regression"','version="0.0.0"','edition="2024"','[workspace]',
               '[lib]','path="lib.rs"','doctest=false','[dependencies]']
        for name,version in versions.items():
            features={'serde':['derive'],'uuid':['v4']}.get(name,[])
            lines.append(name+'={ version="='+version+'"'+(', features='+json.dumps(features) if features else '')+' }')
        lines+=['[profile.dev]','debug=0','opt-level=0','incremental=false','[profile.test]','debug=0','opt-level=0','incremental=false']
        (root/'Cargo.toml').write_text('\n'.join(lines)+'\n')
        shutil.copyfile(root/'Cargo.toml',HERE/'harness-manifest.toml')
        if not (root/'Cargo.lock').exists():shutil.copyfile(REPO/'shared/rust-bridge/Cargo.lock',root/'Cargo.lock')
        env.update(CARGO_HOME=str(home),RUSTUP_HOME=str(TOOLCHAIN/'rustup'),RUSTUP_TOOLCHAIN='stable-aarch64-apple-darwin',
                   CARGO_TARGET_DIR=str(CACHE/'target'),CARGO_NET_OFFLINE='true',TMPDIR=str(CACHE/'tmp'),
                   TAH_FIXTURES=str(CACHE/'fixtures'),TAH_WORKSPACES=str(CACHE/'workspaces'),TAH_CASE_REPORT=str(HERE/'cases.json'))
        env['PATH']=str(TOOLCHAIN/'cargo/bin')+os.pathsep+env['PATH']
        test=bounded([str(TOOLCHAIN/'cargo/bin/cargo'),'test','--offline','-j','2','--target','aarch64-apple-darwin',
                      '--manifest-path',str(root/'Cargo.toml'),'--','--test-threads=1'], 'rust-tests',env,180)
        report['runs'].append(test)
        if (root/'Cargo.lock').exists():shutil.copyfile(root/'Cargo.lock',HERE/'Cargo.lock')
        if (HERE/'cases.json').exists():report['cases']=json.loads((HERE/'cases.json').read_text())
        report['passed']=test['exit']==0 and not test['stopped_reason']
    except BaseException as error:
        report.update(passed=False,error=str(error))
    finally:
        report['source_hashes_after']={name:sha(path) for name,path in SOURCES.items()}
        report['production_sources_unchanged']=report['source_hashes_after']==original
        report['cache_bytes']=size()
        if not report['production_sources_unchanged'] or report['cache_bytes']>LIMIT:report['passed']=False
        report['test_hashes']={name:sha(HERE/name) for name in ['tests.rs','generate.test.ts','run.py','vitest.config.ts']}
        (HERE/'results.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'passed':report['passed'],'production_sources_unchanged':report['production_sources_unchanged'],
                      'cache_bytes':report['cache_bytes'],'error':report.get('error'),'cases':report.get('cases',{})},indent=2))
    raise SystemExit(0 if report['passed'] else 1)


if __name__=='__main__':main()
