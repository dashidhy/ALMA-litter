# rustix iOS compatibility: use official 1.1.6

**Decision, 2026-11-01:** update the selected rustix from 1.1.4 to the official,
non-yanked **1.1.6**, retaining libc **0.2.191**. The unmodified release passes
the isolated iOS `net` consumer. No local patch, `prepare.py`, application vendor
directory, or `[patch.crates-io]` entry is needed. This follows the requested
official-release alternative to vendoring.

Only files under `patches/rustix-ios/` were written. Existing manifests,
lockfiles, registry sources, Codex sources, SDKs, and devices were not changed.

## Diagnosis and upstream review

The existing `tools/alma-ios-lab/.cache/cargo-check-ios.log` fails in rustix
1.1.4's `src/net/types.rs` on `AF_SYS_CONTROL`, `SYSPROTO_EVENT`, and
`SYSPROTO_CONTROL`. Its `#[cfg(apple)]` is broader than libc 0.2.191's
`#[cfg(target_os = "macos")]` in `src/unix/bsd/apple/mod.rs:3077`.

Primary sources checked:

- [Official crates.io index](https://index.crates.io/ru/st/rustix): 1.1.6 was
  published 2026-10-27T00:49:03Z, is not yanked, and requires Rust 1.65.
- [Upstream PR #1676](https://github.com/bytecodealliance/rustix/pull/1676):
  merged 2026-09-16, including the macOS constant gates following libc's iOS fix.
- [Official 1.1.6 net source](https://github.com/bytecodealliance/rustix/blob/v1.1.6/src/net/types.rs):
  `AddressFamily::SYS_CONTROL` and the entire `sysproto` module use exactly
  `#[cfg(target_os = "macos")]`; `AddressFamily::SYSTEM` stays available on Apple.
  Constants still come from libc; there are no invented numeric definitions.
- [Upstream issue #1689](https://github.com/bytecodealliance/rustix/issues/1689)
  and [official 1.1.6 library source](https://github.com/bytecodealliance/rustix/blob/v1.1.6/src/lib.rs):
  1.1.5 fixes the constant gates but fails with only `net` enabled because
  `timespec` is gated out. 1.1.6 includes `net` in that module's gate.

The downloaded official archives were inspected and compiled as well as the
tagged sources. Do not substitute 1.1.5 or downgrade libc. No feature is disabled
and no extra feature is enabled to conceal the 1.1.5 regression.

## Main-agent integration, after review

The existing upstream requirement is `rustix = { version = "1.1.4", features =
["net"] }`, a caret requirement which already permits 1.1.6. The smallest change
is therefore a targeted lockfile update, using the existing stable 1.99 environment
from the repository root:

```sh
cargo update --manifest-path shared/rust-bridge/Cargo.toml \
  -p rustix@1.1.4 --precise 1.1.6
```

This command is for the main agent; it was **not executed** against the project.
Review its lockfile diff to ensure unrelated dependencies remain unchanged.

If a durable exact manifest pin is wanted, the exact entry to add to the existing
`[dependencies]` table in `shared/rust-bridge/codex-mobile-client/Cargo.toml` is:

```toml
rustix = { version = "=1.1.6", features = ["net"] }
```

That is an ordinary dependency pin, not a `[patch.crates-io]` entry. Cargo cannot
use a crates.io-to-the-same-crates.io patch as a version selector. Do not add a
path to `.build/vendor/rustix-1.1.4`: this alternative creates no such directory.
No changes to the upstream Codex manifest are required.

## Reproduce the bounded validation

From the repository root:

```sh
python3 patches/rustix-ios/validate.py
```

Requirements: Python 3.12+, curl, and the already installed stable Rust 1.99.0
toolchain with the `aarch64-apple-ios` standard library. Defaults are read-only
inputs under sibling `../ALMA/.build/tauri-toolchain/`. Use `--toolchain` and
`--archive-cache` to override their locations; nothing is installed.

The script:

1. Reads `shared/rust-bridge/Cargo.lock` and verifies each existing dependency's
   `.crate` archive SHA-256 against its registry checksum, including rustix
   1.1.4 and libc 0.2.191. It rejects missing or changed version selections.
2. Fetches official 1.1.5 and 1.1.6 archives if absent, verifying the fixed hashes
   below against the bytes before extraction. The hashes came from the official
   crates.io index, since these releases are not in the current project lockfile.
3. Creates a unique isolated test directory under `.cache/`, including standalone
   probe manifests/locks, an isolated Cargo home, and temporary directory sources
   containing unmodified archive files plus Cargo checksum metadata. The shared
   registry is read only. This is test input, not an application vendor override.
4. Builds only `consumer.rs` as a library, with default rustix features plus
   `net`, libc exactly 0.2.191, `--offline --locked --jobs 2`, and a 120-second
   timeout per build. Lock generation is offline and limited to 30 seconds;
   missing-archive downloads have a 45-second curl limit.
5. Requires both negative controls to fail for their expected symbols and both
   1.1.6 builds to succeed. It saves complete logs, commands, resolved packages,
   archive checksums, compiler identity, and input lock hash in `results.json`.

No parent workspace or Codex package is compiled. The consumer compiles a TCP
socket call and `AddressFamily::SYSTEM`; its macOS build also checks all three
macOS-only constants against the actual libc values at compile time.

| Official archive | SHA-256 |
| --- | --- |
| rustix 1.1.4 (Cargo.lock) | `b6fe4565b9518b83ef4f91bb47ce29620ca828bd32cb7e408f0062e9930ba190` |
| rustix 1.1.5 (registry index) | `891efababe418670775f199f0d233d84843c227a0949a883ce15b37c78d6629d` |
| rustix 1.1.6 (registry index) | `e5e76742e5294153d4dde1207dbec5bdd81eef6fabdc0d2118babadabfd858aa` |
| libc 0.2.191 (Cargo.lock) | `65cd87c9a6d60536580b316ad985726104730a5151c99845f2490428ef91240a` |

## Observed validation

Run on 2026-11-01 with `rustc 1.99.0 (b940084d7 2026-09-28)`, LLVM 23.1.1.
All four builds used at most two jobs, and libc stayed at 0.2.191.

| rustix | Target | Result | Build time |
| --- | --- | --- | --- |
| 1.1.4 | aarch64-apple-ios | Expected E0425 for all three original constants | 1.92 s |
| 1.1.5 | aarch64-apple-ios | Expected E0433 for `crate::timespec` | 0.87 s |
| 1.1.6 | aarch64-apple-ios | PASS; consumer `.rlib` compiled | 0.99 s |
| 1.1.6 | aarch64-apple-darwin | PASS; macOS constant assertions compiled | 1.03 s |

Local evidence from this run:
`.cache/validation-i5kcpqps/results.json` and each case's `build.log`.
Input project lock SHA-256:
`184513e78d6b907b51795fb78a5a039b0dc508eb46dca420aaf8e7f98dfa3c5c`.
Resolved supporting versions were unchanged: bitflags 2.13.2, errno 0.3.14,
libc 0.2.191, linux-raw-sys 0.12.1, windows-sys 0.61.2, windows-link 0.2.1.
Only libc, bitflags, errno, rustix, and the consumer were compiled for Apple.

This proves the bounded dependency fix, not full mobile build or device
acceptance. RustSec was not rerun in this isolated comparison. Keep all advisory
tracking in `docs/REPOSITORY_AUDIT.md`, including the Hickory, quick-xml, and RSA
items; no advisory suppression or libc downgrade is proposed. Main owns the
project lock update, subsequent real iOS check, RustSec rerun, and broader
acceptance. No commits or pushes were made.
