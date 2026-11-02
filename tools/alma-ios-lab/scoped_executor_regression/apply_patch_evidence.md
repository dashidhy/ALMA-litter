# Actual apply-patch consumer regression (2026-11-01)

The previous adapter-only evidence did not test the full apply-patch consumer.
This follow-up compiles and calls the actual 0.166
`codex_apply_patch::apply_patch`, including the real `codex-exec-server`, official
parser, protocol, filesystem trait, and native `LOCAL_FS` implementation.

| Configuration | Result |
| --- | --- |
| Actual current upstream + actual production scoped adapter | 4 passed, 8 failed zero-mutation requirements |
| Isolated complete source snapshot + final two-part proposal | 12 passed, 0 failed |

The baseline correctly reports per-operation denial but has already committed
earlier RW changes. RO-source moves also write the new destination before the
source deletion is denied. A valid first add can leave parent directories.

The [review proposal](../../../patches/codex-fs-preflight/README.md) supplies
the source proof, API details, limits, and parent application instructions.
Neither the actual submodule nor either production scoped-files module was
changed by this follow-up. Main's existing iOS type-check evidence remains for
the base adapter; the proposed upstream/adapter hook has host consumer evidence.

## Reproduce without modifying actual source

Run the current API first; exit 101 is expected until the proposal is applied:

```sh
python3 tools/alma-ios-lab/scoped_executor_regression/run_apply_patch.py
```

Create an isolated copy of the complete actual source and review patch files:

```sh
python3 tools/alma-ios-lab/scoped_executor_regression/prepare_preflight_proposal.py
```

Run the same real consumer test against that complete patched snapshot:

```sh
python3 tools/alma-ios-lab/scoped_executor_regression/run_apply_patch.py \
  --upstream tools/alma-ios-lab/scoped_executor_regression/.build/preflight-proposal/source/codex-rs \
  --adapter tools/alma-ios-lab/scoped_executor_regression/.build/preflight-proposal/shared/rust-bridge/codex-mobile-client/src/scoped_executor_fs.rs \
  --label apply-patch-proposal
```

Both builds use two jobs, the explicit shared stable Rust toolchain, cached
dependencies offline, and a 900-second per-run cap. Build products are reused
under `.build/target`; no full mobile build or device operation is invoked.
Current reviewed dependency patch sections are copied into the isolated test
manifest; no actual manifests or locks are edited.

Raw output and exact source hashes are retained separately:

- `.build/apply-patch-baseline/{test-output.txt,evidence.json}`.
- `.build/apply-patch-proposal/{test-output.txt,evidence.json}`.
- `.build/apply-patch-parent-control/`: a deliberately retained failed
  intermediate compatibility check, fixed in the final proposal.

The fixture comparison checks bytes, entry paths, inode identity, modes, and
mtime, including directories. Tests use only dummy files inside their declared
RO-input/RW-output temporary workspaces, plus a native-FS control inside its own
temporary workspace. No adversarial host access or mount probes are used.
