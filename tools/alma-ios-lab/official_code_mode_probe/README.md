# Official Code Mode iOS functional probe

**Handoff status: Rust static library compiled; stopped at the cache ceiling.**
Cargo finished in 2m 47s. The 509,078,984-byte archive exists with its SHA-256 in
`build-evidence.json`. Final cache growth reached 3,550,218,563 bytes (3.31 GiB),
exceeding the 3 GiB limit. No subsequent symbol, final-link, or runtime checks
were performed. Only redundant private git/index metadata was removed, leaving
2,940,375,277 bytes (2.74 GiB) and about 21.3 GiB free. The limit breach is retained
as a failure; cleanup does not turn it into a bounded-build pass.

The build driver was then corrected to retain resource-failure reports and avoid
copying unrelated git metadata. That driver revision has not been rerun. The
compiled Rust runner itself was not changed after compilation. Main owns the
remaining app link, UI, entitlement/signing and physical-device execution.

This is an isolated **no-auth functional probe**, not ALMA integration. The entry
point is declared in `include/alma_official_code_mode_probe.h`:

```c
void alma_official_code_mode_probe_run(
    const char *resources, const char *documents,
    void (*callback)(const char *json));
```

Call it once from the background thread of a disposable probe app. Paths are
unused. The callback receives the existing ObjC probe's `phase`, `case`, `fatal`
and `finished` JSON format; copy the string synchronously. No actual tool, model,
network, auth, workspace, or account delegate is installed. No deployment is
performed by this directory's build script.

## Deliberate security difference

All files other than the manifest in the private `code-mode-runtime` copy are
byte-for-byte identical to the inspected Codex 0.166 source. Its
`linked_v8_has_sandbox_enabled` test is preserved unchanged and is **not run**.
The upstream runtime normally requires V8 memory sandboxing. This probe alone
omits `v8_enable_sandbox` to use the verified **plain** iOS V8 152 archive/bindings
and exact fork. It does not meet or claim the upstream sandbox invariant.
Passing the functional fixtures cannot establish security parity or production
suitability. No Rust/JS runtime source or native C++ source is patched.

The generated manifests expand workspace values to the actual upstream paths,
versions and features. Dependency crates remain the actual upstream libraries,
including the protocol and plugin-host crates; no DTO or callback stubs replace
them. `source-evidence.json` records copied-source hashes. The private Cargo lock
records the resolved graph; it is separate from all production locks.

## Fixed functional cases

`src/lib.rs` uses `Arc<dyn CodeModeSession>` backed by the actual
`InProcessCodeModeSession`, and calls `initialize_v8(V8JitMode::Disabled)` first.
Nine case groups cover:

1. Text/UTF-8 and JSON output.
2. Fresh realms, committed session stores, and isolation between sessions.
3. Two synthetic nested tool calls using `Promise.all`.
4. Notification completion before final cell delivery.
5. Explicit yield followed by wait, with incremental output and no duplication.
6. Uncatchable `exit()`, suppression of catch/finally/microtasks, and preservation
   of the prior stored value.
7. CPU-loop termination after an observed readiness notification; the terminated
   cell's write set must not commit.
8. Pending synthetic callback cancellation before termination returns.
9. Shutdown cancellation and rejection of new cell admission.

Each async operation has a five-second deadline. Phase events request a
15-second UI deadline. An independent 60-second thread watchdog emits a fatal
event and calls `_exit(124)` if the entire disposable probe sticks, including V8
initialization. Timeout does not report successful cleanup. Ordinary completion
waits for session shutdown. The runner is one-shot per process; global V8
initialization is not undone. This is not the whole upstream test suite.

## Build and handoff

```sh
python3 tools/alma-ios-lab/official_code_mode_probe/build.py
```

The script uses the existing stable 1.99 toolchain, target `aarch64-apple-ios`,
two jobs, no debug info or incremental compilation, a 600-second Cargo build
watchdog, a 3 GiB private-cache ceiling and a 12 GiB free-disk floor. Cargo is
offline. Existing registry sources are referenced read-only through private
cache entries; index metadata and build artifacts are private. Unneeded git
metadata is no longer copied by the driver.

The V8 source archive, bindings and native archive must already exist and match
`source-lock.json`; there is no V8 download, source build or submodule checkout.
One missing ICU data crate, `deno_core_icudata 0.78.0`, was fetched with a
40 MiB/45-second limit and verified against its locked registry checksum. Its
4.6 MB artifact is recorded in `icu-artifact.json`; a fresh replay may fetch only
that pinned artifact. The standalone ICU initialization is the official runtime's
implementation, not a replacement.

Expected static library location:
`.cache/target/aarch64-apple-ios/debug/libalma_official_code_mode_probe.a`.
Consult `build-evidence.json` and `link-evidence.json` for actual completed checks;
file existence or compilation alone is not a runtime pass.

Main owns the app/UI build, signing, and device test. Reuse the existing ObjC
probe format with `ALMA_PROBE_FUNCTION` set to
`alma_official_code_mode_probe_run`. Retain the verified plain-probe app's
`com.apple.developer.kernel.extended-virtual-addressing` entitlement. This probe
does not request JIT permissions. The C ABI is synchronous, so keep it off the UI
thread. The final emitted `finished` event reports only cases that really passed
on that device invocation. Physical-device timing and memory remain unmeasured
until main runs it.
