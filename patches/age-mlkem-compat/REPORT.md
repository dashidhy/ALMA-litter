# age / ML-KEM compatibility diagnosis

2026-11-01 · `ALMA-litter`, branch `dev/ios` · dependency-only investigation

## Recommended integration

Add this single entry to the **existing** `[patch.crates-io]` table in
`shared/rust-bridge/Cargo.toml`:

```toml
age = { git = "https://github.com/str4d/rage", rev = "b5b68c4f4f7ea5c368bc060f6fe0237549c3a13f" }
```

[`age-upstream-pin.patch`](age-upstream-pin.patch) contains exactly that proposed
change and its explanatory comment. `git apply --check` passes. **It has not been
applied.** Main owns manifest/lock integration.

This is the maintained upstream source, pinned to an immutable commit, including
the upstream crypto-stack migration
[`f7c95f4c067049085944e914ef4e7321fe03e7b9`](https://github.com/str4d/rage/commit/f7c95f4c067049085944e914ef4e7321fe03e7b9).
The selected commit also contains the 0.12.1 armor fixes. Its package version is
still **age 0.12.1**, but its source and dependencies differ from the published
registry crate. Do not substitute the `v0.12.1` tag or just pin registry age to
`=0.12.1`: the published version still has the old ML-KEM dependency.

No age/ML-KEM algorithm code needs a local patch. No security feature is disabled,
and the existing Russh and Clatter upgrades are retained. The upstream migration
does change age's internal crypto dependency stack; this is not merely a
lockfile correction.

## Actual failing graph and cause

Read `AGENTS.md`, `docs/REPOSITORY_AUDIT.md`, the shared lockfile, Codex's workspace
and secrets manifests, the existing mobile crypto patch, and cached package
sources. [`evidence/workspace-graph.json`](evidence/workspace-graph.json) records
the original lockfile hash and relevant package entries.

```text
codex-secrets 0.166.0
└── age 0.12.1 (registry; ml-kem requirement "0.2", deterministic feature)
    └── ml-kem 0.2.1
        └── kem 0.3.0 (resolved from requirement "0.3.0-pre.0")

clatter 3.0.0 @ 9a8d15c4f80d5911ca0403aa22e0de99ea59df08
└── ml-kem 0.3.2 ── kem 0.3.0
russh 0.62.6
└── ml-kem 0.3.2 ── kem 0.3.0
```

The old ML-KEM implementation expects generic `Encapsulate` / `Decapsulate`
traits, `Error` associated types, and rand_core 0.6. KEM 0.3 final has a different
trait/API and rand_core 0.10. The old caret prerelease requirement accepts final
0.3.0; Cargo consequently resolves a graph that cannot compile.

The isolated baseline reproduces `E0437`, `E0407`, `E0107`, and related errors
inside **unmodified ml-kem 0.2.1**, in 5.11 seconds. See
[`baseline-compile.log`](evidence/baseline-compile.log).

### Why a smaller version-only fix fails

RustCrypto fixed the loose requirement in ml-kem 0.2.2, retained by 0.2.3:
`kem = "=0.3.0-pre.0"`. Its
[published manifest](https://docs.rs/crate/ml-kem/0.2.3/source/Cargo.toml) and
[upstream change #194](https://github.com/RustCrypto/KEMs/pull/194) establish the
intent. Live official registry-index results are retained under `evidence/`;
0.2.3 is the newest available 0.2 release in that snapshot.

An isolated age + ml-kem 0.2.3 + ml-kem 0.3.2 graph fails **resolution**: the exact
KEM prerelease conflicts with modern ML-KEM's `kem = "0.3"` requirement. See
[`pin-resolve.log`](evidence/pin-resolve.log). Cargo does not resolve these two
versions from the same package/source as independent compatible selections.
Renaming a dependency does not change package identity. A global KEM prerelease
pin would also break the modern stack. Therefore updating only the legacy
ML-KEM lock entry cannot fix this mixed graph.

## Verified replacement graph

```text
age 0.12.1 @ b5b68c4f4f7ea5c368bc060f6fe0237549c3a13f
├── age-core 0.12.0 @ the same revision (its upstream path dependency)
├── hpke 0.14.1
└── ml-kem 0.3.2 ── kem 0.3.0
clatter 3.0.0 @ existing 9a8d15c revision ── ml-kem 0.3.2
russh 0.62.6 ── ml-kem 0.3.2
```

Only **one** ML-KEM and KEM version remains in the replacement probe. There is
no `ml-kem 0.2.x` or KEM prerelease. The age-core Git dependency follows age
automatically; a separate age-core override is unnecessary for this edge.
The resolved stack also uses ChaCha20-Poly1305 0.11.0, scrypt 0.12.0,
X25519-Dalek 3.0.0, and rand 0.10.1. The report does not recommend changing
the existing ML-KEM 0.3.2 or Russh 0.62.6 pins.

[`russh-graph.log`](evidence/russh-graph.log) proves resolution of the **actual
Git override**, with Russh's default features and the exact Clatter feature list
from Codex: `alloc`, `getrandom`, `use-25519`, `use-aes-gcm`,
`use-rust-crypto-ml-kem`, `use-sha`. Clatter is read from the existing immutable
checkout. [`proof-summary.json`](evidence/proof-summary.json) records package
sources and versions. This graph was resolved, not compiled in full.

## Bounded compile and behavior proof

All compilation used the existing sibling toolchain: Rust **1.99.0**, host
`aarch64-apple-darwin`. Builds are sequential, at **two jobs**, with a **175-second
process-group timeout per dependency build/test invocation**. No Codex build
was started. Observed compilation and test runs were well below three minutes.

| Check | Result | Evidence |
|---|---|---|
| Original mixed ML-KEM graph | Expected compiler failure | `baseline-compile.log` |
| Legacy ML-KEM 0.2.3 pin with modern ML-KEM | Expected resolver conflict | `pin-resolve.log` |
| Upstream age + existing Clatter + ML-KEM 0.3.2 host build/test | Pass; first run 27.13 s | `upstream-test.log` |
| Same dependency consumer, `aarch64-apple-ios` | Pass, 10.51 s | `upstream-ios-check.log` |
| Current secrets API encryption/decryption and tamper rejection | Pass | `upstream-interop-test.log` |
| Published age 0.12.1 ciphertext decrypted by upstream age | Pass | `upstream-interop-test.log` |
| Upstream age ciphertext decrypted by published age 0.12.1 | Pass | `released-decrypt.log` |
| Upstream `age1tagpq` recipient encryption | Pass; emits `mlkem768p256tag` | `upstream-interop-test.log` |
| Exact Git override + Russh 0.62.6 + existing Clatter resolution | Pass, 4.79 s | `russh-graph.log` |

The secrets tests use the same `SecretString::from`, `scrypt::Recipient::new`,
`scrypt::Identity::new`, `age::encrypt`, and `age::decrypt` calls present in
`codex-rs/secrets/src/local.rs`. No work factor is lowered. Fixtures contain only
an artificial plaintext/passphrase. The old release's interoperability fixture
is built separately with ml-kem 0.2.3 / KEM prerelease, without the modern graph;
this is only a reference test, not the proposed production dependency selection.

The first Cargo/libgit2 fetch stalled and was stopped at 90 seconds. Compile
tests therefore used an unmodified, checksummed archive of the pinned commit.
The subsequent Git-CLI fetch succeeded; all **181** compared root-manifest and
age/age-core files are byte-identical between the archive and Git checkout.
See `rage-source.json`, `rage-ls-remote.log`, and `proof-summary.json`.

The host toolchain emitted a nonfatal `rust-objcopy` missing-`libLLVM.dylib`
debug-stripping warning. Test binaries still ran and exited successfully.
The toolchain was not modified.

## Reproduce and integrate

Run from the repository root:

```sh
python3 patches/age-mlkem-compat/repro.py baseline
python3 patches/age-mlkem-compat/repro.py pin
python3 patches/age-mlkem-compat/repro.py upstream
python3 patches/age-mlkem-compat/repro.py ios
python3 patches/age-mlkem-compat/repro.py interop
python3 patches/age-mlkem-compat/repro.py graph
```

The script writes only within this directory, uses a private `.work/cargo-home`
and target directory, and copies registry index/archive caches with independent
APFS copy-on-write files. It never links a writable shared registry. Saved probe
lockfiles make resolved versions reviewable and seed fresh probes. Existing
Clatter sources and the Rust toolchain are read only.

For main: review/apply the patch, then resolve the shared lock with
`CARGO_NET_GIT_FETCH_WITH_CLI=true cargo update -p age` in `shared/rust-bridge`
using the established project toolchain/cache setup. Inspect the resulting diff
and reverse tree: age/age-core should have the exact Git source above, the
legacy ML-KEM edge should disappear, and Russh/Clatter should remain unchanged.
The actual shared manifest/lock update and full workspace resolution were not
performed by this investigation.

Read the risk register's required follow-up gates: rerun RustSec without
suppressions and complete the owner's full workspace/mobile validation. These
dependency-only results do **not** establish full Codex compatibility, Android
build acceptance, device networking, or a new security audit. Existing advisory
tracks are unchanged. No root manifests/locks, existing patches, phone files,
shared registry, commits, pushes, or global installs were modified here.

Primary upstream evidence: [pinned age workspace](https://github.com/str4d/rage/blob/b5b68c4f4f7ea5c368bc060f6fe0237549c3a13f/Cargo.toml),
[maintainer crypto migration](https://github.com/str4d/rage/commit/f7c95f4c067049085944e914ef4e7321fe03e7b9),
[age release history](https://github.com/str4d/rage/releases),
[official age registry index](https://index.crates.io/3/a/age),
[official ML-KEM registry index](https://index.crates.io/ml/-k/ml-kem),
[official KEM registry index](https://index.crates.io/3/k/kem).
