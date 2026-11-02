"""Materialize the verified experimental patch under our own ignored cache."""
from pathlib import Path
import json
import shutil
import sys

HERE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(HERE))
from verify import LAB_CACHE, TARGET_ARCHIVE_SHA, digest, git_apply, require, tree_hashes, verify_archive


def prepare_source():
    patch=HERE/'embedded-exec-backend.patch'
    report=json.loads((HERE/'reports/embedded-verification.json').read_text())
    require(report['patch_sha256']==digest(patch), 'rerun verify_embedded.py for this patch first')
    source=LAB_CACHE/'codex-rust-v0.166.0'
    _, expected=verify_archive(LAB_CACHE/'codex-0.166.0.tar.gz',source,TARGET_ARCHIVE_SHA)
    expected.update(report['checks'][0]['after_sha256'])
    work=HERE/'.cache'/('harness-source-'+digest(patch)[:16])
    if not work.exists():
        shutil.copytree(source,work,symlinks=True)
        require(git_apply(work,patch,'--check')['ok'],'strict check failed')
        require(git_apply(work,patch)['ok'],'apply failed')
    require(tree_hashes(work)==expected,'harness source differs from verified patch')
    return work
