"""Ordinary files in the host-selected private /workspace fixture only."""
import errno
import json
import os
from pathlib import Path
import subprocess
import sys

role = sys.argv[1]
assert role in ('guardian', 'actor')
view = Path('/workspace/view')
candidate = view / 'outbox/revision_v1'
inbox = view / 'inbox/source.txt'
prior = view / 'outbox/revision_v0/accepted.txt'
cases = []


def passed(name):
    cases.append(name)


def denied(name, action):
    try:
        action()
    except OSError as error:
        assert error.errno in (errno.EACCES, errno.EPERM, errno.EROFS, errno.ENOTSUP, errno.EXDEV), (name, error)
    else:
        raise AssertionError(name + ' unexpectedly succeeded')
    passed(name)


assert inbox.read_text() == 'readonly input\n'
assert prior.read_text() == 'accepted independent copy\n'
assert (candidate / 'seed.txt').read_text() == 'candidate seed\n'
passed('read_whole_attempt_view')
listing = subprocess.run(['/bin/bash', '-c', 'ls -1 .; find . -type f'],
                         cwd=view, capture_output=True, timeout=8, check=True)
for expected in [b'inbox', b'outbox', b'./inbox/source.txt',
                 b'./outbox/revision_v0/accepted.txt', b'./outbox/revision_v1/seed.txt']:
    assert expected in listing.stdout, expected
passed('bash_ls_find_from_view_root')
denied('write_inbox_denied', lambda: inbox.write_text('changed'))
denied('write_prior_revision_denied', lambda: prior.write_text('changed'))
denied('unlink_inbox_denied', lambda: inbox.unlink())
denied('create_in_readonly_parent_denied', lambda: (view / 'new.txt').write_text('changed'))
Path('/workspace/scratch/scratch.txt').write_text(role + '\n')
assert Path('/workspace/scratch/scratch.txt').read_text() == role + '\n'
passed('scratch_write_read')

if role == 'guardian':
    denied('write_candidate_denied', lambda: (candidate / 'seed.txt').write_text('changed'))
    denied('create_candidate_denied', lambda: (candidate / 'created.txt').write_text('changed'))
else:
    (candidate / 'nested').mkdir(exist_ok=True)
    data = candidate / 'nested/result.tmp'
    data.write_text('Actor 中文\n')
    with data.open('r+') as stream:
        stream.write('Actor')
        stream.flush()
        os.fsync(stream.fileno())
    renamed = candidate / 'nested/result.txt'
    data.rename(renamed)
    assert renamed.read_text() == 'Actor 中文\n'
    passed('candidate_mkdir_write_fsync_regular_rename_read')
    denied('rename_candidate_into_inbox_denied', lambda: renamed.rename(inbox))
    denied('rename_candidate_into_prior_denied', lambda: renamed.rename(prior))
    denied('rename_candidate_root_denied', lambda: candidate.rename(view / 'outbox/replaced'))
    denied('directory_rename_still_unsupported', lambda: (candidate / 'nested').rename(candidate / 'renamed-dir'))
    denied('symlink_creation_still_denied', lambda: os.symlink('seed.txt', candidate / 'symbolic'))
    denied('hardlink_creation_still_denied', lambda: os.link(candidate / 'seed.txt', candidate / 'hard'))

assert inbox.read_text() == 'readonly input\n'
assert prior.read_text() == 'accepted independent copy\n'
assert (candidate / 'seed.txt').read_text() == 'candidate seed\n'
print(json.dumps({'role': role, 'passed': True, 'cases': cases}), flush=True)
