"""Prepare the owned-session iSH source overlay from a verified immutable archive."""
from pathlib import Path
import hashlib, json, shutil, subprocess, tarfile, tempfile

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
CACHE=HERE/'.cache'
PIN='4f783cd957b83de3019d6a843408d5bb3ff902c7'
ARCHIVE_SHA='3df629379e1403821909f5e822b24b631f7e576f4fce6f8357e85423a3a46067'
DEST=REPO/'.build/vendor/litter-ish-owned'


def sha(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def main():
    archive=CACHE/'ish-4f783cd9.tar.gz'
    if sha(archive)!=ARCHIVE_SHA:raise ValueError('iSH archive checksum mismatch')
    patches=[REPO/'patches'/group/s.strip()
             for group in ['ish-lifecycle','ish-workspace-policy','ish-native-workspace','ish-ro-parent-candidate','ish-build-inputs']
             for s in (REPO/'patches'/group/'series').read_text().splitlines()
             if s.strip() and not s.lstrip().startswith('#')]
    with tempfile.TemporaryDirectory(prefix='owned-ish-',dir=CACHE) as tmp:
        tmp=Path(tmp)
        with tarfile.open(archive) as tar:tar.extractall(tmp,filter='data')
        source=tmp/('litter-ish-'+PIN)
        env=dict(__import__('os').environ,GIT_CEILING_DIRECTORIES=str(tmp))
        def tree(root):
            return {str(p.relative_to(root)):sha(p) for p in root.rglob('*') if p.is_file() and not p.is_symlink()}
        states=[tree(source)]
        for patch in patches:
            subprocess.run(['git','apply','--check','--whitespace=error-all',str(patch)],cwd=source,env=env,check=True)
            subprocess.run(['git','apply',str(patch)],cwd=source,env=env,check=True)
            states.append(tree(source))
        files=states[-1]
        if DEST.exists():
            actual={name:sha(DEST/name) if (DEST/name).is_file() and not (DEST/name).is_symlink() else None for name in files}
            matches=[i for i,state in enumerate(states) if all(actual[name]==state.get(name) for name in files)]
            if not matches:raise ValueError('Existing overlay differs from every reviewed patch-stack state; preserving it')
            dest_env=dict(env,GIT_CEILING_DIRECTORIES=str(DEST.parent))
            for patch in patches[max(matches):]:
                subprocess.run(['git','apply','--check','--whitespace=error-all',str(patch)],cwd=DEST,env=dest_env,check=True)
                subprocess.run(['git','apply',str(patch)],cwd=DEST,env=dest_env,check=True)
            if any(not (DEST/name).is_file() or (DEST/name).is_symlink() or sha(DEST/name)!=digest for name,digest in files.items()):
                raise ValueError('Final overlay verification failed')
            reused=True
        else:
            DEST.parent.mkdir(parents=True,exist_ok=True)
            shutil.move(str(source),DEST)
            reused=False
        record={'sourceCommit':PIN,'archiveSHA256':ARCHIVE_SHA,'sourceFilesChecked':len(files),
                'patches':[{'path':str(p.relative_to(REPO)),'sha256':sha(p)} for p in patches],
                'source':str(DEST),'reused':reused,'scope':'Prepared source, not host-wrapper/device validation'}
        (CACHE/'owned-ish-prepared.json').write_text(json.dumps(record,indent=2)+'\n')
        print(json.dumps(record,indent=2))


if __name__=='__main__':main()
