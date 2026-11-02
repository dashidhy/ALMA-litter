# Experimental integration validation — 2026-11-01

Target: pinned `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`, from the cached archive.
No submodule checkout, bridge edits, phone actions, commits or pushes by this task.
Other agents' simultaneous changes are outside this patch directory.

| Check | Status |
|---|---|
| Pristine cached source | All 9,732 entries matched the pinned archive. |
| Experimental patch alone | Strict `git apply --check --whitespace=error-all`, actual application, duplicate rejection and reverse check passed. |
| Experimental patch after prerequisite + optional series | Same checks passed; reverse application restored the exact preceding tree. |
| Upstream scope | 17 declared Rust files; protected unified lifecycle/collector, sandbox request preparation, in-process bootstrap, auth and executor protocol files verified identical. |
| Bounded event-log isolated harness | 4 tests passed using actual patched producer/receiver code and cached Tokio 1.52.3. Includes 2 new bounded-producer tests and 2 existing upstream tests. The existing empty-receiver test is not an embedded implementation. |
| Direct-capture isolated harness | 11 tests passed using the unchanged implementation and its tests with boundary fixtures: stream separation/paged drain/Unicode, timeout, cancellation, drop cleanup, network-context rejection, output cap/denial, expiration after exit, stalled consumer, process failure, pre-cancelled startup and non-native-width exit codes. |
| Actual environment constructor and unified routing tests | Added to upstream patch; **not run in the actual crates**. |
| Full Codex Rust type checking / upstream tests | **Not run.** Harness fixtures do not verify API/trait compatibility across the full dependency graph. |
| Formatting | **Unverified.** Existing cached 1.95 rustfmt remains unusable without its driver library; no download/repair. |
| iSH enforcement and real process cleanup | **Not implemented or tested.** No fake iSH handles or substitute backend shipped. |
| Lockfile, schemas, iOS/device, real auth/Web/TAH/background | **Not verified.** |

Machine-readable apply results: [embedded-verification.json](embedded-verification.json).
Focused test commands/results and source hashes: [embedded-tests.json](embedded-tests.json).

The first capture harness attempt failed because its test error fixture lacked
`Display`; adding that fixture implementation resolved the harness error. It was
not an upstream code fix. The verifier's first attempt also caught a target-list
sorting discrepancy; the final report uses sorted path strings. No failed attempt
is counted as a passing check.

The focused harnesses use source links to the existing package cache, with their
own local directory-source metadata, Cargo home, lockfiles and build outputs.
Only small test dependency graphs were built (10 and 30 resolved packages); no
network fetch or full Codex dependency build was attempted. Their dependency
versions beyond explicitly pinned Tokio/tokio-util are local harness resolutions,
not a claim that the full upstream Cargo.lock was reproduced.
