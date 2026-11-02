# Bounded iOS TAH patch port — Codex 0.166.0

Target: `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` (`rust-v0.166.0`).
Original patch base: `be2951ea34f0d295ed0becf97079f92fa5f6950e` (`rust-v0.155.1`).

Main integration update, 2026-11-01: `series` additionally contains
`mxc-desktop-platform.patch`. The desktop-only MXC SDK is excluded from iOS/
Android compilation; its existing non-Windows unavailable behavior is retained.
This eliminates the active iOS dependency on the problematic Nix0.29 socket
branch, so the Nix vendor override is not selected. The experimental embedded
backend and guest-shell patches are in `series.experimental`; they are now
applied to the local0.166 submodule, but a complete iSH adapter/policy remains
under implementation. `tools/alma-ios-lab/prepare_codex.py --check-only` checks
the complete selected source state without resetting unknown edits.

**Experimental upstream integration, not a runnable iOS upgrade.** The separately
authorized follow-up adds `embedded-exec-backend.patch` in `series.experimental`.
See [EMBEDDED_API.md](EMBEDDED_API.md) for supported APIs, ownership limits and
verification. A real iSH backend/filesystem adapter is still required. The original
[blocker analysis](EXEC_HOOK_BLOCKERS.md) records why the old hook cannot be rebased.
There is deliberately no
`ios-exec-hook.patch`, legacy callback shim, or pretend-success implementation.
The old bridge still cannot compile/run unchanged against this set.

Only this new directory was written by this task. The original patches, sync
script, both cached baselines, submodule, bridge, and phone were not modified by
this task. Parallel bridge edits belong to the other agent. No commits, pushes,
Git configuration changes, dependency downloads, or system changes were made.

## Apply order

`series` contains the two safe prerequisites for retaining the existing Litter
bridge's dependency and thread-read projection contracts:

1. `mobile-crypto-compat.patch`: retain the exact existing clatter 3.0 Git pin
   `9a8d15c4f80d5911ca0403aa22e0de99ea59df08`. Upstream 0.166 still specifies
   clatter 2.2 / ML-KEM 0.2.3 / KEM 0.3.0-pre.0; the current bridge lock uses
   clatter 3.0 / ML-KEM 0.3.2 / KEM 0.3.0 with russh 0.62.6. This is compatibility
   for the existing dependency graph, not enabling remote SSH. If the later TAH
   bridge removes those dependencies, reassess whether this patch is needed.
2. `thread-read-permissions.patch`: expose the live thread's optional
   `approvalPolicy` and legacy `sandbox` projection for
   `mobile_client/thread_projection.rs::thread_snapshot_from_app_server_read_response`. Preserve
   the new `read_state` field, experimental annotation, snapshot calculation,
   and all upstream thread-loading/resume/fork behavior. Unloaded threads return
   null for both added fields; missing fields deserialize as `None`.

The `sandbox` value uses 0.166's own `ThreadConfigSnapshot::sandbox_policy()`.
It is a **legacy display projection**, not the full permission profile and not
proof of iSH filesystem/network enforcement. Do not use it to authorize tools.
The optional live lookup can race unloading; `None` must remain unknown rather
than imply full access. This preserves the original patch's advisory semantics.

`series.optional` contains `ios-shell-snapshot-timeout.patch`, applied last only
if the host enables shell snapshots. It ports the original 2-second cap for iOS
only; every other platform keeps the upstream 10-second timeout. The ALMA TAH
native profile explicitly disables `shell_snapshot`, so this is **not** in the
minimal series. It does not change command execution deadlines.

`series.experimental` applies `embedded-exec-backend.patch` followed by
`embedded-guest-shell.patch`, after either `series` alone or `series` plus
`series.optional`. The backend patch also applies independently to pristine 0.166;
the shell follow-up requires it. The follow-up preserves explicit guest shell
paths and selects the reported default without host probes. The original backend
patch remains unchanged from the earlier handoff. This series supplies upstream
integration points, not an iSH implementation, and remains experimental until
full Codex type checking and runtime integration.

Do not append these patches to the 0.155 patch stack. Apply to a pristine checkout
of the exact target revision. No production sync/build script selects this
directory yet. Once bridge/backend migration is complete, the integration owner
can wire the new series into a separate build lane. Use strict
`git apply --check --whitespace=error-all` before each apply; do not use the old
sync script's added-line content heuristic to certify a migration.

## Selection of all 14 original patches

| Original patch | Decision for local iOS text TAH |
|---|---|
| mobile-crypto-compat | Ported unchanged in intent; bridge dependency prerequisite. Lock resolution remains unverified. |
| ios-exec-hook | Not rebased. New architecture is in the experimental embedded patch; the real iSH adapter remains separate. |
| thread-read-permissions | Ported, retaining `read_state` and current permission-profile projection. |
| thread-list-fork-lineage | Deferred: cold fork-list metadata is not needed by ephemeral, independent TAH attempts. Upstream fork/read behavior remains unchanged. |
| mobile-shell-snapshot-timeout | Ported as optional iOS-only patch; TAH disables snapshots. |
| remote-app-server-websocket-cap | Excluded: remote SSH/custom transport, outside this local path. |
| absolute-path-cross-platform | Excluded: foreign Windows/remote metadata paths, outside this local path. |
| android-installation-id-lock | Excluded: Android only. |
| dynamic-tool-call-arguments-delta | Excluded: UI streaming for client dynamic tools; native shell/apply_patch/Web do not require this extension. Existing bridge references need later removal or gating for the TAH lane. |
| approval-timestamps-serde-default | Excluded: tolerates missing fields from older peers; local server/client are pinned together. Preserve the 0.166 timestamp contract. |
| realtime-webrtc-env-apikey | Excluded: voice. |
| realtime-handoff-server-hint | Excluded: voice/multi-server. |
| realtime-dynamic-tools | Excluded: voice/client tools. |
| realtime-client-controlled-handoff | Excluded: voice/handoff. |

Selection follows `tools/alma-ios-lab/README.md` and `IMPLEMENTATION_PLAN.md`,
and the existing ALMA `app/TAH/providers/codex/adapter/src/native-profile.ts`
(ephemeral threads; shell/unified exec enabled; snapshots, hooks, realtime,
plugins, MCP and multi-agent features disabled). This is intentionally not a
replacement for the full Litter feature stack. Omitted patches can leave compile
references in the current bridge; the later bridge task must prune/gate those
features rather than assume this patch set makes that crate compatible.

## Verification

From the ALMA-litter repository root:

```sh
python3 patches/codex-0.166/verify.py --output reports/verification-new.json
```

Choose a new report filename. The standard-library-only verifier checks the
archive hashes, every file/symlink in both cached baselines, original patch
applicability, and strict sequential application in its own temporary tree under
`.cache/`. It then checks duplicate-forward rejection, reverse detection with
the entire stack present, and reverse application back to byte-identical
pristine contents. It asserts that only the five declared upstream paths changed
and that both baselines, original patch directory, and sync script stayed
unchanged. It creates no Git repository, index, commit, or configuration.

The original required two-patch state is checked before the optional third patch. No
execution, cancellation, output, filesystem, network, auth, or Web implementation
is changed by those three patches. The experimental patch has its own verifier
and [validation record](reports/embedded-validation.md).

Results and limits: [validation](reports/validation.md),
[machine-readable verification](reports/verification.json).

The thread-read patch extends two upstream integration tests:
`thread_read_returns_summary_without_turns` (unloaded/absent field behavior) and
`thread_read_loaded_thread_returns_precomputed_path_before_materialization`
(live permissions agree with thread/start). **These Rust tests were not run.**
No Rust type checking, generated-schema refresh, dependency resolution, full
build, or phone/TAH validation is claimed.

The crypto patch changes `Cargo.toml`, just like its predecessor. The upstream
0.166 `Cargo.lock` still selects clatter 2.2.0; it is not a valid locked resolution
for that manifest after this patch. The old mobile lock also is not evidence of
0.166 resolution. Generate/review the appropriate lockfile in the later isolated
bridge lane before any `--locked` build. Do not copy the old lock or fabricate
new checksum/dependency entries here.
