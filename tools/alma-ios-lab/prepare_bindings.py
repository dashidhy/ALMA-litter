"""Generate real Swift bindings from the iOS static library, without a host rebuild.

Only this crate owns UniFFI metadata. Copy its archive members for metadata
extraction; this smaller archive is NEVER a link library for the phone app.
"""
from pathlib import Path
import argparse, hashlib, json, os, shutil, subprocess, tempfile

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
WORKSPACE=REPO/'shared/rust-bridge'

def sha(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--library',type=Path,default=WORKSPACE/'target/aarch64-apple-ios/ios-dev/libcodex_mobile_client.a')
    parser.add_argument('--output-dir',type=Path,default=WORKSPACE/'generated/swift')
    parser.add_argument('--report',type=Path,default=HERE/'results/2026-11-01-production-bindings.json')
    args=parser.parse_args()
    library=args.library.resolve()
    ar='/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/ar'
    names=subprocess.check_output([ar,'-t',str(library)],text=True).splitlines()
    members=[name for name in names if name.startswith('codex_mobile_client-') and name.endswith('.o')]
    if not members or any('/' in name or '\\' in name for name in members):
        raise ValueError('Unexpected mobile metadata archive members')
    toolchain=Path(os.environ.get('ALMA_RUST_TOOLCHAIN_ROOT',REPO.parent/'ALMA/.build/tauri-toolchain'))
    env=dict(os.environ,RUSTUP_TOOLCHAIN='stable-aarch64-apple-darwin',RUSTUP_HOME=str(toolchain/'rustup'),
             CARGO_HOME=str(toolchain/'cargo'),CARGO_NET_OFFLINE='true',RUSTC_WRAPPER='',SCCACHE_DISABLE='1')
    env['PATH']=str(toolchain/'cargo/bin')+os.pathsep+env['PATH']
    candidates=[WORKSPACE/'target/debug/uniffi-bindgen',HERE/'auth_refresh_regression/.build/rust/target/debug/auth-refresh-bindgen-evidence']
    generator=next((path for path in candidates if path.is_file()),None)
    if generator is None:
        subprocess.run(['bash',str(HERE/'cargo_ios.sh'),'build','--locked','--offline','-p','uniffi-bindgen','-j','2'],check=True)
        generator=candidates[0]
    output=args.output_dir.resolve();output.mkdir(parents=True,exist_ok=True)
    before=library.stat()
    with tempfile.TemporaryDirectory(prefix='mobile-metadata-',dir=HERE/'.cache') as temp:
        temp=Path(temp)
        subprocess.run([ar,'-x',str(library),*members],cwd=temp,check=True)
        archive=temp/'metadata-only.a'
        subprocess.run([ar,'-rcs',str(archive),*[str(temp/name) for name in members]],check=True)
        subprocess.run([str(generator),'generate','--library',str(archive),'--metadata-no-deps',
                        '--language','swift','--out-dir',str(output)],cwd=WORKSPACE,env=env,check=True)
    if library.stat().st_mtime_ns != before.st_mtime_ns or library.stat().st_size != before.st_size:
        raise RuntimeError('Runtime library changed during generation; rerun after the build finishes')
    shutil.copyfile(output/'codex_mobile_clientFFI.modulemap',output/'module.modulemap')
    report={'sourceLibrary':str(library),'sourceLibrarySHA256':sha(library),'selectedMembers':len(members),
            'allMembers':len(names),'generatorSHA256':sha(generator),'metadataNoDeps':True,
            'scope':'actual production UniFFI metadata, not fixture API signatures; metadata archive not used for linking',
            'outputs':{str(path.relative_to(REPO)):sha(path) for path in output.iterdir() if path.is_file()}}
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'bindings':str(output),'members':len(members)},indent=2))

if __name__=='__main__':main()
