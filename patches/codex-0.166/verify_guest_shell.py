#!/usr/bin/env python3
"""Check guest-shell follow-up after embedded integration, alone or with prerequisites."""
import argparse,json,re,shutil,tempfile
from pathlib import Path
from verify import HERE,LAB_CACHE,TARGET_ARCHIVE_SHA,TARGET_COMMIT,digest,git_apply,require,tree_hashes,verify_archive
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',default='reports/guest-shell-verification.json');a=p.parse_args()
output=(HERE/a.output).resolve();require(output.is_relative_to(HERE) and not output.exists(),'report must be new and inside patch directory')
source=LAB_CACHE/'codex-rust-v0.166.0';info,baseline=verify_archive(LAB_CACHE/'codex-0.166.0.tar.gz',source,TARGET_ARCHIVE_SHA)
patch=HERE/'embedded-guest-shell.patch';paths=json.loads((HERE/'tests/guest-shell-targets.json').read_text())
require(sorted(re.findall(r'^\+\+\+ b/(.+)$',patch.read_text(),re.M))==paths,'scope mismatch')
report={'target_commit':TARGET_COMMIT,'baseline':info,'prerequisite_patch_sha256':digest(HERE/'embedded-exec-backend.patch'),'patch_sha256':digest(patch),'changed_paths':paths,'checks':[]}
with tempfile.TemporaryDirectory(prefix='verify-guest-shell-',dir=HERE/'.cache') as tmp:
 for with_prerequisites in [False,True]:
  work=Path(tmp)/str(with_prerequisites);shutil.copytree(source,work,symlinks=True)
  preceding=['mobile-crypto-compat.patch','thread-read-permissions.patch','ios-shell-snapshot-timeout.patch'] if with_prerequisites else []
  preceding+=['embedded-exec-backend.patch']
  for name in preceding:
   require(git_apply(work,HERE/name,'--check')['ok'],name);require(git_apply(work,HERE/name)['ok'],name)
  before=tree_hashes(work);check=git_apply(work,patch,'--check');require(check['ok'],str(check));require(git_apply(work,patch)['ok'],'apply failed')
  after=tree_hashes(work);require(sorted(k for k in after if after[k]!=before.get(k))==paths,'unexpected changes')
  require(git_apply(work,patch,'--reverse','--check')['ok'],'reverse check failed');require(not git_apply(work,patch,'--check')['ok'],'duplicate accepted')
  report['checks'].append({'with_prerequisites':with_prerequisites,'strict_check':check,'reverse_check':True,'duplicate_rejected':True,'after_sha256':{k:after[k] for k in paths}})
  require(git_apply(work,patch,'--reverse')['ok'],'reverse failed');require(tree_hashes(work)==before,'reverse changed predecessor')
require(tree_hashes(source)==baseline,'pristine source changed');report['baseline_unchanged']=True
report['full_codex_build_verified']=False
output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'strict_apply_and_reverse':'passed','report':str(output)},indent=2))
