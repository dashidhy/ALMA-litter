# Validation record — 2026-11-01

Target is pinned Codex 0.166.0, not a moving latest release. See
[verification.json](verification.json) for exact patch/baseline hashes and command
outcomes.

| Check | Result |
|---|---|
| Both source archives and all extracted files/symlinks | Verified against fixed SHA-256 archives. |
| Four relevant original patches on pristine 0.155.1 | Strict independent apply checks passed (crypto, exec hook, thread-read, snapshot timeout). |
| All 14 original patches independently on pristine 0.166 | 5 pass, 9 fail; errors retained in JSON. This is not the candidate series. |
| New required series then optional patch | All 3 passed `git apply --check --whitespace=error-all` and actual application in private temporary copy. |
| Duplicate forward application | Rejected for each candidate patch, as expected. |
| Reverse check with complete candidate stack | Passed for each patch; no content-heuristic fallback. |
| Reverse application in reverse order | Restored byte-identical pristine source. |
| Scope | Exactly 5 declared upstream files differ in the fully applied temporary tree; every other file is identical, including all exec/cancel/output/backend code. |
| Original patch directory, sync script, both baselines | Hashes unchanged after verification. |
| Cache ignore | `git check-ignore patches/codex-0.166/.cache/port/codex-rs/Cargo.toml` reports the path ignored. |
| Rust formatting | Attempted, could not run: cached 1.95.0 rustfmt exits 134 because `librustc_driver-eea6b8737cd03a8e.dylib` is absent. No installation/repair attempted. |
| Rust type checking / integration tests | Not run. Added assertions are source only, not passing test evidence. |
| Dependency resolution / updated Cargo.lock / schemas | Not run or generated. Existing lockfiles do not prove 0.166 compatibility. |
| iOS compile/link/start, exec hook, phone, auth, Web, background, TAH | Not run by this task. Exec-hook port remains blocked as documented. |

The private development copy is `.cache/port`; verification uses fresh temporary
copies below the same ignored directory and deletes only those copies when done.
No Git init/config/index/commit operation is used. The existing sync script was
read but never executed: it targets the shared submodule and the original stack.

Formatter attempt (paths relative to the private Codex copy):

```sh
/Users/dashidhy/Public/projects/agent/ALMA/.build/tauri-toolchain/rustup/toolchains/1.95.0-aarch64-apple-darwin/bin/rustfmt \
  --check --edition 2024 --config skip_children=true \
  codex-rs/app-server-protocol/src/protocol/v2/thread.rs \
  codex-rs/app-server/src/request_processors/thread_processor.rs \
  codex-rs/app-server/tests/suite/v2/thread_read.rs \
  codex-rs/core/src/shell_snapshot.rs
```

The repo-local stable `rustc --version` reports 1.99.0. No dependency build was
started; a compiler version check is not compilation evidence. The formatter
attempt preceded a small manual line-layout correction in the test hunks; no
successful formatter run is claimed for either version.
