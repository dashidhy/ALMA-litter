# Proposed scoped apply-patch batch authorization

**Integrated 2026-11-01.** Both patches were reviewed and applied to the actual
Codex submodule and production adapter. The integrated actual consumer passes
12/12 tests; `prepare_codex.py` now includes the upstream patch. The evidence
below retains the original baseline and proposal runs for comparison.

## Actual failure and proof

The real 0.166 `codex_apply_patch::apply_patch` consumer was compiled and called
with `ScopedExecutorFileSystem` and owned RO-input/RW-output fixtures. The final
baseline suite has **4 passes and 8 failures**. The failures are assertions of
the required zero-mutation behavior, not compiler failures:

| Later denied operation after a valid RW update | Baseline committed delta |
| --- | --- |
| RO add, update, or delete | 1 change each |
| Move into RO input | 1 change |
| Move from RO input into RW output | 2 changes, including the new destination |
| Sandbox-policy-denied target in a host RW root | 1 change |
| Policy forbids creating a missing parent | 1 change |
| First hunk adds nested output, later hunk deletes RO input | 1 change; new parents remain |

Source locations in the tested base:

- `codex-rs/apply-patch/src/lib.rs:338`: the actual API uses official `parse_patch`.
- `lib.rs:400`: the operation starts with an empty committed delta.
- `lib.rs:469`: hunks are applied sequentially, with no whole-batch scope check.
- `lib.rs:583`: a move writes its destination before removing its source.
- `codex-rs/apply-patch/src/parser.rs:85`: `Hunk::resolve_path` resolves the
  update's **source**. `Hunk::path` at line 94 instead returns the move destination.
  Using only `Hunk::path` would therefore miss source authorization.

The raw baseline log and source hashes are under
`tools/alma-ios-lab/scoped_executor_regression/.build/apply-patch-baseline/`.
`base.json` pins the proposal's actual base file hashes and upstream commit.

## Two-part fix

1. `codex-batch-preflight.patch` targets three upstream files:
   - `file-system/src/lib.rs`: add `FileSystemMutation`,
     `FileSystemMutationPreflight`, and the optional
     `ExecutorFileSystem::mutation_preflight()` capability.
   - `exec-server/src/lib.rs`: re-export the two new public types.
   - `apply-patch/src/lib.rs`: before the hunk loop and any filesystem reads,
     collect the complete mutation plan from the **official parsed hunks**.
     Include add/update/delete paths, both move endpoints, and whether writes
     may need parent creation; authorize the whole plan through the capability.
     Both `apply_patch` and the typed `apply_hunks` path use this common function.
2. `scoped-adapter-preflight.patch` opts `ScopedExecutorFileSystem` into that
   capability. It reuses its actual fixed-root `resolve` and upstream policy
   checks. All file sources/destinations are authorized before descriptor I/O.
   Possible parent creation is checked before any mutations. If creation is
   denied but the immediate parent is an existing, read-authorized directory,
   descriptor metadata permits the normal file write without granting directory
   creation. No file contents are read by this preflight.

All per-operation checks remain in place. No manifest or dependency changes
are needed by these patches; main already wired the relevant modules/types.

The default capability is explicitly **None**, not fabricated authorization
success and not a blanket `Unsupported` error. Native filesystems without an
extra batch policy keep their existing behavior. The actual native `LOCAL_FS`
normal add/move/update/delete test passes. Whole-batch authorization is promised
only for implementations providing the capability, such as this scoped adapter.
Any wrapper around the scoped adapter must forward the capability; it is not
automatically transported over executor RPCs.

## Validation

The final proposal passes **12/12 actual consumer tests**. Eight denied batches
return empty deltas and preserve the entire fixture tree: paths, bytes, inode
identity, modes, and modification times. Access times are excluded because the
test snapshot itself reads files. Controls cover:

- Real scoped add/update/delete/move, missing-parent creation, and UTF-8 names/content.
- Real native `LOCAL_FS` normal operations.
- Writing an explicitly permitted file inside an existing read-only parent.
- An authorized patch with a later content mismatch: its committed prefix is
  still reported, proving this change does not claim general transactionality.

An initial conservative parent check rejected the valid existing-parent control
(11 passed, 1 failed). The final proposal corrects that case through read-authorized
descriptor metadata. This intermediate evidence is retained separately in
`.build/apply-patch-parent-control/`.

Builds used the actual complete 0.166 crates and their real dependencies, offline,
with two Cargo jobs and `stable-aarch64-apple-darwin` (rustc 1.99.0). The proposal
was tested against a complete source snapshot with these patches; no trait,
parser, exec-server, or filesystem stubs were substituted. The current main
workspace's reviewed dependency patches were reused. Both proposal patches pass
`git apply --check` against the actual working trees. This proposal has not been
iOS-checked; main's already-passing mobile iOS check applies to the base adapter.

## Limits and parent handoff

- This rejects scope/policy-denied batches before any filesystem mutation.
  It does not precompute all content replacements or roll back later I/O,
  missing-file, type, or content-matching failures.
- Directory topology and authority must remain under the trusted controller
  for the patch duration. Guest enforcement, hostile concurrent namespace
  changes, mount controls, and VM equivalence are outside this proposal.
- When proving that a denied-creation parent already exists, the parent must
  be readable under the sandbox policy. The adapter fails closed if it cannot
  authorize that metadata query.
- Both patches must be reviewed/applied together. The production scoped route
  should retain/provide `mutation_preflight() == Some(...)`; default None is
  legacy behavior, not protection for that route.

From the repository root, read-only applicability checks are:

```sh
git -C shared/third_party/codex apply --check "$PWD/patches/codex-fs-preflight/codex-batch-preflight.patch"
git apply --check patches/codex-fs-preflight/scoped-adapter-preflight.patch
```

Parent can apply the first patch from the Codex submodule root and the second
from the ALMA-litter root after review. Then run the actual consumer test with a
new label to retain the failure evidence:

```sh
python3 tools/alma-ios-lab/scoped_executor_regression/run_apply_patch.py --label apply-patch-integrated
```

Only ordinary owned temporary workspaces were exercised. No phone, auth, real
user files, network calls, unexposed-host access, mounting, or adversarial
namespace probes were involved. No commits or pushes were made.
