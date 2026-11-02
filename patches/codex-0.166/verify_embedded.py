#!/usr/bin/env python3
"""Strict offline checks of the experimental embedded patch, alone and stacked."""
import argparse
import json
from pathlib import Path
import re
import shutil
import tempfile
from verify import HERE, REPO, LAB_CACHE, TARGET_ARCHIVE_SHA, TARGET_COMMIT
from verify import digest, git_apply, require, tree_hashes, verify_archive

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', default='reports/embedded-verification.json')
a=parser.parse_args()
output=(HERE/a.output).resolve()
require(output.is_relative_to(HERE) and not output.exists(), 'report must be new and inside patch directory')
source=LAB_CACHE/'codex-rust-v0.166.0'
info,baseline=verify_archive(LAB_CACHE/'codex-0.166.0.tar.gz',source,TARGET_ARCHIVE_SHA)
patch=HERE/'embedded-exec-backend.patch'
expected=json.loads((HERE/'tests/embedded-targets.json').read_text())
require(sorted(re.findall(r'^\+\+\+ b/(.+)$',patch.read_text(),re.M))==expected,'patch scope mismatch')
protected=['codex-rs/core/src/unified_exec/'+n+'.rs' for n in ['oneshot','process','async_watcher','output']]
protected+=['codex-rs/core/src/tools/sandboxing.rs','codex-rs/app-server/src/in_process.rs',
            'codex-rs/app-server/src/external_auth.rs','codex-rs/exec-server-protocol/src/protocol.rs']
originals=tree_hashes(REPO/'patches/codex')
sync=digest(REPO/'apps/ios/scripts/sync-codex.sh')
report={'target_commit':TARGET_COMMIT,'baseline':info,'patch_sha256':digest(patch),
        'scope':'experimental upstream integration, not an iSH adapter or full build',
        'expected_source_paths':expected,'checks':[]}
with tempfile.TemporaryDirectory(prefix='verify-embedded-',dir=HERE/'.cache') as temp:
    root=Path(temp)
    for stacked in [False,True]:
        work=root/('stacked' if stacked else 'standalone')
        shutil.copytree(source,work,symlinks=True)
        if stacked:
            for name in ['mobile-crypto-compat.patch','thread-read-permissions.patch','ios-shell-snapshot-timeout.patch']:
                require(git_apply(work,HERE/name,'--check')['ok'],name)
                require(git_apply(work,HERE/name)['ok'],name)
        before=tree_hashes(work)
        check=git_apply(work,patch,'--check')
        require(check['ok'],str(check))
        require(git_apply(work,patch)['ok'],'application failed')
        after=tree_hashes(work)
        changed=sorted(p for p in set(before)|set(after) if before.get(p)!=after.get(p))
        require(changed==expected,'unexpected changed paths')
        for path in protected:require(after[path]==baseline[path],f'protected upstream contract changed: {path}')
        require(git_apply(work,patch,'--reverse','--check')['ok'],'reverse check failed')
        require(not git_apply(work,patch,'--check')['ok'],'duplicate accepted')
        report['checks'].append({'stacked_on_prerequisites_and_optional':stacked,
            'strict_apply_check':check,'actual_apply':True,'duplicate_rejected':True,
            'reverse_check':True,'protected_files_identical':protected,
            'after_sha256':{p:after[p] for p in expected}})
        require(git_apply(work,patch,'--reverse')['ok'],'reverse failed')
        require(tree_hashes(work)==before,'reverse did not restore exact preceding state')
require(tree_hashes(source)==baseline,'baseline changed')
require(tree_hashes(REPO/'patches/codex')==originals,'original patches changed')
require(digest(REPO/'apps/ios/scripts/sync-codex.sh')==sync,'sync changed')
report['inputs_unchanged']=True
report['full_codex_build_verified']=False
report['device_or_ish_adapter_verified']=False
output.parent.mkdir(exist_ok=True)
output.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'report':str(output),'strict_apply_standalone_and_stacked':'passed','changed_files':len(expected)},indent=2))
