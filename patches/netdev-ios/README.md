# netdev 0.45.0: iOS IPv6 flag-query boundary

## Decision

Backport the upstream macOS-only query gate to the selected netdev 0.45.0,
keeping libc 0.2.191 and all current features. Add an explicit fallible Apple
flag-query API so unsupported iOS querying is distinguishable from a successful
read. Preserve ordinary address enumeration and netwatch's parallel vectors.

The patch, scripts, review evidence, and validation artifacts are confined to
`patches/netdev-ios/`. No root Cargo files, Codex sources, prior nix patches,
shared registry source, SDK, or phone were changed. Source preparation below
root `.build/vendor/` is left to main after review; the identical preparation
was validated under this folder's `.cache/`.

## Upstream and caller review (2026-11-01)

The failure is recorded in `tools/alma-ios-lab/.cache/cargo-check-ios-6.log`:
netdev 0.45.0's Darwin flag query uses `libc::in6_ifreq`, which libc 0.2.191
exports only for macOS (`src/unix/bsd/apple/mod.rs:1835`).

Maintained upstream fix: [netdev PR #195](https://github.com/shellrow/netdev/pull/195),
merged October 25 and included in [0.47.0](https://github.com/shellrow/netdev/releases/tag/v0.47.0).
It gates the Darwin ioctl module to macOS and uses unknown default flags on iOS.
The official 0.47.0 archive was checksum-verified and inspected, but was not
substituted into the existing dependency line.

[Official netdev registry metadata](https://index.crates.io/ne/td/netdev) shows
0.45.1 is the newest compatible 0.45 release. Its verified archive still has
the broad Apple gate and reproduces the same iOS failure. The fixed 0.47 release
does not satisfy `^0.45.0`.

The frozen iOS dependency tree in `tree-features.txt` is:

```text
codex-mobile-client → iroh 1.0.3 → netwatch 0.19.1 → netdev 0.45.0
                               → portmapper 0.19.1 → netwatch 0.19.1
```

Netdev has its original default features: `gateway`,
`apple-system-configuration-extra`, and `android-extra`. No feature is disabled
to make validation pass. Netwatch 0.19.1 requires netdev `^0.45.0`.
[Netwatch's registry metadata](https://index.crates.io/ne/tw/netwatch) shows
0.19.3 uses `^0.46.1` on Apple and 0.20.0 uses `^0.46.3`; neither admits 0.47.0.
There is no published compatible dependency update that picks up this fix.
See `upstream-review.json` for release checksums and review details.

## Behavior and scope

The additive Apple API is:

```rust
netdev::interface::ipv6_addr_flags::query_ipv6_addr_flags(ifname, address)
    // -> std::io::Result<Ipv6AddrFlags>
```

- **iOS:** always returns `ErrorKind::Unsupported`. It opens no socket, issues
  no ioctl, and defines no private ABI structure or constant.
- **macOS:** keeps the existing real query. Socket and ioctl failures return
  their actual OS errors; errno is captured before closing the descriptor.
- **Legacy enumeration:** retains the existing `Vec<Ipv6AddrFlags>` shape.
  Query failure/unsupported status becomes an explicitly documented **unknown**
  default entry, never `Ok(default_flags)` from the new query. It does not
  remove an address or scope ID.

Netwatch 0.19.1 zips IPv6 addresses, scope IDs, and flags; its sorting code also
indexes all three with the same indices. Emptying the flags vector would either
discard IPv6 addresses or break that contract. Changing the public vector to
`Option`/`Result` would break its API. This patch preserves vector lengths and
struct layouts. Netwatch still cannot distinguish unknown metadata through its
legacy bool-only entries; callers needing explicit status must use the new query.
Default `false` values must not be interpreted as verified absence of the flags.

Only four files change: Darwin module dispatch, Darwin query error handling,
public flag dispatch/documentation, and field documentation. The Unix and iOS
interface enumeration implementations, prefixes, scopes, routes, gateways,
DNS, Cargo manifests, and crate version are byte-identical. Existing macOS
ioctl constants are retained; none are added or compiled into this iOS query.

The wider upstream 0.47 iOS fix also replaces unavailable SystemConfiguration
calls. Those changes are outside this bounded compiler fix and remain a separate
upgrade track. This patch does not establish full iOS public-API or distribution
acceptance. No claim is made that missing IPv6 state flags have become available.

## Preparation and exact manifest handoff

From the repository root, main can run after review:

```sh
python3 patches/netdev-ios/prepare.py
```

This creates `.build/vendor/netdev-0.45.0`. Add to the **existing**
`[patch.crates-io]` table in `shared/rust-bridge/Cargo.toml`:

```toml
netdev = { version = "=0.45.0", path = "../../.build/vendor/netdev-0.45.0" }
```

Then, using the existing stable 1.99 toolchain environment:

```sh
cargo update --manifest-path shared/rust-bridge/Cargo.toml --offline -p netdev@0.45.0
```

Main owns that integration, lock diff review, and the subsequent full iOS check.
These project mutations were not performed here. Do not change netwatch's
requirement or relabel the incompatible 0.47 archive as 0.45.

`prepare.py` requires Python 3.12+, `patch`, and curl only for a missing archive.
It defaults to reading archives from sibling ALMA's existing toolchain cache;
`--archive-cache` overrides that location. It never trusts or edits extracted
registry source. Before extraction, SHA-256 must match both the project lockfile
and the reviewed lock-derived hash in `patch.json`:

```text
netdev-0.45.0.crate
569dfbdd2efd771b24ec9bb57f956e04d4fbfc72f62b2f11961723f9b3f4b020
```

After a path override, Cargo removes the registry checksum for that package.
Preparation then uses the preserved original lock checksum and lock hash in
`patch.json`, requiring the same selected version. Changed registry hashes or
sources and missing versions are rejected. Patch hash, exact before/after file
hashes, and a complete source inventory are checked. Only regular archive files
and directories are accepted. Preparation stages in a temporary sibling directory,
then renames it into place. Repeated preparation accepts identical output and
refuses to overwrite a modified destination. `.alma-netdev-ios.json` records
provenance. `--destination` is restricted to root `.build/vendor/` or this
folder's `.cache/`.

## Bounded validation

```sh
python3 patches/netdev-ios/validate.py
```

Uses the existing stable Rust 1.99.0 toolchain with the iOS standard library;
`--toolchain` overrides its location. It installs nothing. The sibling Cargo
archive/index cache supplies the project-selected dependency metadata and active
archives. These are copied into an isolated Cargo home; every copied archive is
checksum-verified. Missing inactive-platform archives are not downloaded.
The official 0.45.1 archive is fetched locally if needed, with its reviewed
registry checksum checked.

Only the small consumer is built, with default netdev features and libc pinned
to exactly 0.2.191. Cargo runs offline/locked with two jobs and a 180-second
limit per case. Lock generation has a 30-second limit. All logs, generated probe
manifests/locks, extracted sources, and outputs stay under `.cache/`. Iroh,
netwatch, and Codex are not compiled; the consumer exercises netwatch's exact
parallel-vector iteration pattern.

Observed on 2026-11-01, Rust 1.99.0 (`b940084d7`, LLVM 23.1.1):

| Case | Result |
| --- | --- |
| Official 0.45.0, iOS library build | Expected E0425: `in6_ifreq` |
| Official 0.45.1, iOS library build | Same expected failure |
| Official 0.45.0, macOS consumer | Enumeration/alignment test passes |
| Patched 0.45.0, iOS library build | PASS |
| Patched 0.45.0, iOS test type-check | PASS, including explicit `Unsupported` assertion |
| Patched 0.45.0, macOS consumer | Enumeration/alignment and real-query/error tests pass |

Both macOS runs observed 31 interfaces and 21 IPv4/IPv6 addresses, including
IPv4 and IPv6 loopback. Counts reflect this machine at test time, not fixed
expected counts. The patched macOS query successfully read loopback flags and
returned an OS error for a nonexistent interface. The iOS tests were compiled,
not executed on a device. Preparation checks cover idempotence, dirty-source
refusal, corrupt archive rejection, and post-path-override checksum provenance.

See `validation-summary.json`; complete local evidence is under
`.cache/validation-4t4pelpk/`. This is compiler and host enumeration evidence,
not full mobile runtime acceptance. Advisory tracking in
`docs/REPOSITORY_AUDIT.md` remains unchanged, including plist/quick-xml. RustSec
was not rerun. No commits or pushes were made.
