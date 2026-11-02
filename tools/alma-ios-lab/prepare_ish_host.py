"""Build the pinned iSH C host lane on Apple Silicon; keep everything in .cache.

Requires the repository's existing Rust toolchain (for lld), Xcode/CLT, uv,
Ninja, curl. No sudo, global package install, model or device access.
"""
from pathlib import Path
import argparse, hashlib, json, os, shlex, subprocess, tarfile

HERE=Path(__file__).resolve().parent
PROJECT=HERE.parents[1]
CACHE=HERE/'.cache'
PIN='4f783cd957b83de3019d6a843408d5bb3ff902c7'
ASSETS=[
    ('ish-4f783cd9.tar.gz','https://codeload.github.com/dnakov/litter-ish/tar.gz/'+PIN,
     '3df629379e1403821909f5e822b24b631f7e576f4fce6f8357e85423a3a46067'),
    ('litter-rootfs-v0.1.2.tar.gz','https://api.github.com/repos/dnakov/litter-ish/releases/assets/424728088',
     '70e7d8acc9520ca45d53821dd3ffab1035620156dda3e513e66013e848f6ba0a')]


def sha(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def run(args,**kw):subprocess.run([str(x) for x in args],check=True,**kw)


def main():
    p=argparse.ArgumentParser();p.add_argument('--fetch',action='store_true');p.add_argument('--prepare-only',action='store_true');a=p.parse_args()
    CACHE.mkdir(exist_ok=True)
    for filename,url,digest in ASSETS:
        path=CACHE/filename
        if not path.exists():
            if not a.fetch:raise FileNotFoundError(path)
            part=path.with_suffix(path.suffix+'.partial')
            run(['curl','-fLsS','--connect-timeout','10','--max-time','600','--continue-at','-',
                 '-H','Accept: application/octet-stream',url,'-o',part])
            if sha(part)!=digest:raise ValueError('Download checksum mismatch: '+filename)
            part.rename(path)
        if sha(path)!=digest:raise ValueError('Asset checksum mismatch: '+filename)
    source=CACHE/('litter-ish-'+PIN)
    with tarfile.open(CACHE/ASSETS[0][0]) as archive:
        if not source.exists():archive.extractall(CACHE,filter='data')
        for m in archive.getmembers():
            if m.isfile():
                with archive.extractfile(m) as stream:
                    expected=hashlib.file_digest(stream,'sha256').hexdigest()
                if sha(CACHE/m.name)!=expected:raise ValueError('Modified upstream source: '+m.name)
    base=CACHE/'ish-base'
    if not base.exists():
        base.mkdir()
        with tarfile.open(CACHE/ASSETS[1][0]) as archive:archive.extractall(base,filter='data')
    env=dict(os.environ)
    env.pop('IPHONEOS_DEPLOYMENT_TARGET',None)
    venv=CACHE/'ish-tools'
    if not (venv/'bin/meson').exists():
        run(['uv','venv','--python','python3',venv])
        run(['uv','pip','install','--python',venv/'bin/python','meson==1.7.0'],
            env=dict(env,UV_NATIVE_TLS='true'))
    toolchain=Path(os.environ.get('ALMA_RUST_TOOLCHAIN_ROOT',str(PROJECT.parent/'ALMA/.build/tauri-toolchain')))
    lib=toolchain/'rustup/toolchains/stable-aarch64-apple-darwin/lib'
    linker=lib/'rustlib/aarch64-apple-darwin/bin/rust-lld'
    if not linker.exists() or not (lib/'libLLVM.dylib').exists():
        raise FileNotFoundError('The repository Rust LLVM linker/runtime is missing')
    # Package-local launcher supplies rust-lld's existing LLVM dylib. It does
    # not alter the toolchain or system library paths for other processes.
    bindir=CACHE/'host-bin';bindir.mkdir(exist_ok=True)
    shim=bindir/'ld.lld'
    shim.write_text('#!/bin/sh\nexport DYLD_LIBRARY_PATH='+shlex.quote(str(lib))+
                    '\nexec '+shlex.quote(str(linker))+' -flavor gnu "$@"\n')
    shim.chmod(0o755)
    env['PATH']=str(bindir)+os.pathsep+env['PATH']
    if a.prepare_only:
        print('Pinned sources, packages and build tools prepared.')
        return
    build=CACHE/'ish-host-build'
    run([venv/'bin/meson','setup',*(['--reconfigure'] if (build/'build.ninja').exists() else []),
         build,source,'--buildtype=release','-Dguest_arch=arm64','-Dkernel=ish','-Dno_crlf=true'],env=env)
    run(['ninja','-C',build,'-j','3','ish'],env=env)
    vdso=build/'vdso/arm64/libvdso.so.elf'
    if vdso.stat().st_size<1024 or vdso.read_bytes()[:4]!=b'\x7fELF':
        raise ValueError('Invalid/empty Linux VDSO: do not run the guest')
    report={'ishCommit':PIN,'sourceUnmodified':True,'binarySHA256':sha(build/'ish'),
            'vdsoBytes':vdso.stat().st_size,'vdsoSHA256':sha(vdso),
            'scope':'macOS C host CLI with the pinned iSH kernel/interpreter; no embedded Rust supervisor or phone build',
            'assets':[{'file':x,'sha256':h,'url':u} for x,u,h in ASSETS]}
    (CACHE/'ish-host-build-provenance.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))


if __name__=='__main__':main()
