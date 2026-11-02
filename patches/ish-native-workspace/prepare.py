"""Reconstruct the reviewed native-workspace source; optionally build its C harness."""
from pathlib import Path
import argparse, hashlib, json, os, shutil, subprocess, tarfile, tempfile

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
CACHE=HERE/'.cache'
PIN='4f783cd957b83de3019d6a843408d5bb3ff902c7'
ARCHIVE_SHA='3df629379e1403821909f5e822b24b631f7e576f4fce6f8357e85423a3a46067'

def sha(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--build',action='store_true');args=parser.parse_args()
    CACHE.mkdir(exist_ok=True)
    archive=REPO/'tools/alma-ios-lab/.cache/ish-4f783cd9.tar.gz'
    if sha(archive)!=ARCHIVE_SHA:raise ValueError('Pinned iSH archive hash differs')
    patches=[REPO/'patches'/group/name for group,name in [
        ('ish-lifecycle','owned-session-jobs.patch'),
        ('ish-workspace-policy','workspace-policy.patch'),
        ('ish-native-workspace','native-workspace.patch'),
    ]]
    destination=CACHE/'source'
    with tempfile.TemporaryDirectory(dir=CACHE,prefix='verify-') as temp:
        temp=Path(temp)
        with tarfile.open(archive) as source:source.extractall(temp,filter='data')
        source=temp/('litter-ish-'+PIN)
        env=dict(os.environ,GIT_CEILING_DIRECTORIES=str(temp))
        for patch in patches:
            subprocess.run(['git','apply','--check','--whitespace=error-all',str(patch)],cwd=source,env=env,check=True)
            subprocess.run(['git','apply',str(patch)],cwd=source,env=env,check=True)
        files={str(p.relative_to(source)):sha(p) for p in source.rglob('*') if p.is_file() and not p.is_symlink()}
        if destination.exists():
            if any(not (destination/name).is_file() or (destination/name).is_symlink() or sha(destination/name)!=value for name,value in files.items()):
                raise ValueError('Scratch source differs; preserving edits')
        else:shutil.copytree(source,destination,symlinks=True)
    (HERE/'reports').mkdir(exist_ok=True)
    (HERE/'reports/prepared.json').write_text(json.dumps({'commit':PIN,'sourceFiles':len(files),
        'patches':{str(p.relative_to(REPO)):sha(p) for p in patches}},indent=2)+'\n')
    if args.build:
        env=dict(os.environ)
        env['PATH']=str(REPO/'tools/alma-ios-lab/.cache/phone-build-bin')+os.pathsep+str(REPO/'tools/alma-ios-lab/.cache/ish-tools/bin')+os.pathsep+env['PATH']
        env.pop('IPHONEOS_DEPLOYMENT_TARGET',None)
        build=CACHE/'build'
        if not (build/'build.ninja').exists():
            subprocess.run(['meson','setup',str(build),str(destination),'-Dguest_arch=arm64','-Dkernel=ish','-Dno_crlf=true','--buildtype=release'],env=env,check=True)
        subprocess.run(['ninja','-C',str(build),'-j','2'],env=env,check=True)

if __name__=='__main__':main()
