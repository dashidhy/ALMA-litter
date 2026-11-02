"""Build only the plain-V8 qualification app using verified prebuilt artifacts."""
from pathlib import Path
import argparse, hashlib, json, os, subprocess, tarfile, tempfile, shutil

HERE=Path(__file__).resolve().parent
LAB=HERE.parent
REPO=LAB.parents[1]
DATA=LAB/'.cache/v8-ios'

def sha(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--refresh-lock',action='store_true');parser.add_argument('--rust-only',action='store_true');args=parser.parse_args()
    lock=json.loads((HERE/'source-lock.json').read_text());DATA.mkdir(parents=True,exist_ok=True)
    artifacts=[('v8-ios.a.gz',lock['archiveURL'],lock['artifacts']['v8-ios.a.gz']),
               ('bindings-ios.rs',lock['bindingsURL'],lock['artifacts']['bindings-ios.rs']),
               ('source.tar.gz',lock['sourceURL'],lock['sourceSHA256'])]
    for name,url,digest in artifacts:
        path=DATA/name
        if not path.exists():
            subprocess.run(['curl','--fail','--location','--max-time','60','--max-filesize','67108864','--silent','--show-error',url,'-o',str(path)],check=True,timeout=65)
        if sha(path)!=digest:raise ValueError('Pinned artifact hash differs: '+name)
    source=DATA/('rusty_v8-'+lock['commit'])
    with tempfile.TemporaryDirectory(dir=DATA,prefix='verify-source-') as temp:
        temp=Path(temp)
        with tarfile.open(DATA/'source.tar.gz') as archive:
            members=archive.getmembers()
            if len(members)>10000 or sum(item.size for item in members)>128*1024*1024:raise ValueError('Source archive exceeds bound')
            archive.extractall(temp,filter='data')
        expected=temp/source.name
        if not source.exists():shutil.copytree(expected,source,symlinks=True)
        for path in expected.rglob('*'):
            if path.is_file() and not path.is_symlink():
                target=source/path.relative_to(expected)
                if not target.is_file() or target.is_symlink() or sha(path)!=sha(target):raise ValueError('Source modified; preserving edits')
    toolchain=Path(os.environ.get('ALMA_RUST_TOOLCHAIN_ROOT',REPO.parent/'ALMA/.build/tauri-toolchain'))
    env=dict(os.environ,CARGO_HOME=str(toolchain/'cargo'),RUSTUP_HOME=str(toolchain/'rustup'),
        RUSTUP_TOOLCHAIN='stable-aarch64-apple-darwin',CARGO_TARGET_DIR=str(HERE/'.cache/target'),
        RUSTC_WRAPPER='',SCCACHE_DISABLE='1',DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer',
        IPHONEOS_DEPLOYMENT_TARGET='18.0',RUSTY_V8_ARCHIVE=str(DATA/'v8-ios.a.gz'),
        RUSTY_V8_ARCHIVE_SHA256=lock['artifacts']['v8-ios.a.gz'],RUSTY_V8_SRC_BINDING_PATH=str(DATA/'bindings-ios.rs'))
    for key in ['V8_FROM_SOURCE','RUSTY_V8_MIRROR','RUSTY_V8_SRC_BINDING_URL','DOCS_RS']:env.pop(key,None)
    env['PATH']=str(toolchain/'cargo/bin')+os.pathsep+env['PATH']
    command=[str(toolchain/'cargo/bin/cargo'),'build','--manifest-path',str(HERE/'rust/Cargo.toml'),'--target','aarch64-apple-ios','-j','2']
    if not args.refresh_lock:command.append('--locked')
    subprocess.run(command,cwd=HERE,env=env,check=True,timeout=600)
    if args.rust_only:return
    for name in ['fs','work']:(HERE/'.cache/payload'/name).mkdir(parents=True,exist_ok=True)
    subprocess.run(['xcodegen','generate','--spec',str(HERE/'project.yml')],env=env,check=True)
    subprocess.run(['xcodebuild','-project',str(HERE/'AlmaV8Probe.xcodeproj'),'-scheme','AlmaV8Probe',
        '-configuration','Release','-destination','generic/platform=iOS','-jobs','2',
        '-derivedDataPath',str(HERE/'.cache/DerivedData'),'-allowProvisioningUpdates','build'],env=env,check=True,timeout=300)

if __name__=='__main__':main()
