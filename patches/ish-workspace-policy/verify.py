#!/usr/bin/env python3
"""Strict patch check against pinned iSH + owned lifecycle; private scratch only."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,tarfile,tempfile
HERE=Path(__file__).resolve().parent;REPO=HERE.parent.parent;CACHE=HERE/'.cache'
PIN='4f783cd957b83de3019d6a843408d5bb3ff902c7'
BASE=REPO/'tools/alma-ios-lab/.cache'/('litter-ish-'+PIN)
OWNED=REPO/'patches/ish-lifecycle/owned-session-jobs.patch'
OWNED_SHA='1892642f9c916969a19944fb5780f5e98aa5b821bcfb6e7f5c652bf786846bb7'
ARCHIVE=REPO/'tools/alma-ios-lab/.cache/ish-4f783cd9.tar.gz'
ARCHIVE_SHA='3df629379e1403821909f5e822b24b631f7e576f4fce6f8357e85423a3a46067'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def tree(root):return {str(p.relative_to(root)):('link:'+os.readlink(p) if p.is_symlink() else sha(p)) for p in sorted(root.rglob('*')) if p.is_file() or p.is_symlink()}
def apply(root,patch,*flags):
 env=dict(os.environ,GIT_CEILING_DIRECTORIES=str(root.parent))
 for k in ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR']:env.pop(k,None)
 r=subprocess.run(['git','apply','--whitespace=error-all',*flags,str(patch)],cwd=root,env=env,capture_output=True,text=True,timeout=30)
 return {'returncode':r.returncode,'detail':r.stdout+r.stderr}
def verify_base():
 assert sha(ARCHIVE)==ARCHIVE_SHA and sha(OWNED)==OWNED_SHA
 expected={}
 with tarfile.open(ARCHIVE) as t:
  for m in t:
   rel=str(Path(*Path(m.name).parts[1:]))
   if m.isfile():expected[rel]=hashlib.sha256(t.extractfile(m).read()).hexdigest()
   elif m.issym():expected[rel]='link:'+m.linkname
 assert tree(BASE)==expected
 return expected
def main():
 original=verify_base();patch=HERE/'workspace-policy.patch';paths=json.loads((HERE/'tests/targets.json').read_text())
 with tempfile.TemporaryDirectory(prefix='verify-',dir=CACHE) as tmp:
  work=Path(tmp)/'source';shutil.copytree(BASE,work,symlinks=True)
  assert apply(work,OWNED,'--check')['returncode']==0;assert apply(work,OWNED)['returncode']==0
  before=tree(work);forward=apply(work,patch,'--check');assert forward['returncode']==0,forward
  assert apply(work,patch)['returncode']==0;after=tree(work)
  assert sorted(k for k in after if after[k]!=before.get(k))==paths
  reverse=apply(work,patch,'--reverse','--check');assert reverse['returncode']==0,reverse
  assert apply(work,patch,'--check')['returncode']!=0
  assert apply(work,patch,'--reverse')['returncode']==0;assert tree(work)==before
 assert tree(BASE)==original and sha(OWNED)==OWNED_SHA
 report={'pinned_ish_commit':PIN,'prerequisite_owned_patch_sha256':OWNED_SHA,'patch_sha256':sha(patch),'strict_forward_check':forward,'strict_reverse_check':reverse,'duplicate_rejected':True,'reverse_restores_owned_baseline':True,'shared_inputs_unchanged':True,'changed_paths':paths,'after_sha256':{p:after[p] for p in paths}}
 (HERE/'reports/verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'strict_checks':'passed','changed_paths':len(paths),'patch_sha256':sha(patch)},indent=2))
if __name__=='__main__':main()
