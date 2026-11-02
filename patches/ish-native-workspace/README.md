# Host-selected native workspace

This patch follows the pinned iSH source, `ish-lifecycle`, and
`ish-workspace-policy`, in that order. It adds one immutable native directory at
`/workspace`, so the guest shell and native `ScopedExecutorFileSystem` can use
the same ordinary files. It does not expose arbitrary iOS paths to the model.

The trusted host calls
`IshInstance::boot_workspace_policy_with_workspace(rootfs_data, cwd, workspace)`.
Registration occurs before policy sealing or child execution. The source tree is
audited for ordinary directories/files, with no host symlinks or hardlinks.
Only that registered realfs mount is permitted; unknown mounts remain denied.
Guest mount changes remain frozen. Policy roots retain actual device/inode
ancestry from their selected mount, while path and descriptor authorization
continue at the existing operation boundaries. Regular-file rename is checked
again inside realfs; directory/link renames remain unsupported.

The native controller owns directory topology and must not replace roots or
change authority concurrently with an active job. Native tools must use the
matching scoped descriptors and policy. This is not protection against bugs in
the interpreter or against malicious native code in the same App process.

## Evidence

`reports/native-workspace.json`: actual Mac iSH kernel, owned granted job,
Bash/Python/Node, one private native fixture. Read-only input rejected a write;
the three tools produced and renamed candidate text; native host readback matched
the final UTF-8 bytes. The reproducible helper rerun passed in 8.83 seconds.
This is a synthetic tool test, not a model/transcript performance measurement.

The production Rust wrapper and Codex iOS library compile with this patch.
After the user unlocked the phone, the sealed native-workspace phone probe
passed **10/10** in 9.315 seconds, peak footprint 46.19 MiB. It includes the
actual native `apply_patch` consumer and shell readback, plus Python/Node work.
See `tools/alma-ios-lab/results/2026-11-01-sealed-backend-phone.json` from the
repository root. The earlier rejected launch and pre-policy 7/7 result are
retained separately. No full TAH/model/background acceptance is implied.

From the repo root, with the lab's pinned archive/tools/rootfs prepared:

```sh
python3 patches/ish-native-workspace/prepare.py --build
python3 patches/ish-native-workspace/tests/run_native.py
python3 tools/alma-ios-lab/prepare_owned_ish.py
```

`prepare.py` reconstructs source from the immutable archive and patch series,
verifies existing scratch source, and refuses to overwrite unknown edits.
The test-only CLI entry mounts exactly its private fixture; the phone uses the
typed host API. No auth, model requests, remote connections, or attempts to reach
unexposed host directories are part of these tests.
