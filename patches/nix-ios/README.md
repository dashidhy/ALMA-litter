# nix / libc 0.2.191 iOS compatibility

Main integration update: the broader build showed that this active iOS edge
came solely from the desktop-only MXC SDK. `mxc-desktop-platform.patch` now
excludes that SDK on iOS, preserving its existing unavailable implementation.
**No Nix override is currently selected.** The following patch/validation is
retained as contingency evidence, not an active application dependency change.

## Recommendation

For the current iOS text TAH build, apply **only nix 0.29.0**. Keep libc 0.2.191
and all existing dependency features. The other three versioned patches are
verified contingencies for future socket feature unification, not required
overrides for this build.

All delivered files and validation output are under `patches/nix-ios/`. No
project manifest, lockfile, submodule, shared registry source, SDK, or phone was
modified. The root `.build/vendor` destination is prepared by main after review;
validation exercised identical preparation in this directory's `.cache/`.

## Resolved tree and official release review (2026-11-01)

`tree-features.txt` captures frozen Cargo dependency trees for
`codex-mobile-client` on iOS and macOS, including inverse callers. The iOS graph
contains no zbus edge to nix, despite that edge appearing in the workspace lock.

| Selected nix | Current callers | Resolved features beyond empty `default` | iOS action |
| --- | --- | --- | --- |
| 0.28.0 | portable-pty, rustyline → Starlark | fs, ioctl, poll, process, signal, term | None; socket is disabled |
| 0.29.0 | mxc-sdk → codex-mxc-sandbox | feature, fs, memoffset, mount, net, process, sched, signal, socket, term, uio, user | Patch; socket/net is active |
| 0.30.1 | os_info (macOS tree only) | feature | None; absent on iOS, no socket on macOS |
| 0.31.2 | process-wrap → RMCP; russh-cryptovec → Russh | fs, mman, poll, process, signal | None; socket is disabled |

The actual feature sets of the other selected versions compile unchanged for
their relevant Apple targets. Merely having `ioctl` in 0.28.0 does not activate
its socket module. All four versions have the latent socket issue if `net` is
enabled; adding `ioctl` also exposes the kernel-control address mismatch.

Primary sources:

- [Official crates.io index](https://index.crates.io/3/n/nix): latest compatible
  releases in the selected lines are 0.28.0, 0.29.0, 0.30.1, and 0.31.3. There
  are no newer patch releases in the first three lines.
- [Official 0.31.3 socket source](https://github.com/nix-rust/nix/blob/v0.31.3/src/sys/socket/mod.rs)
  and [socket options](https://github.com/nix-rust/nix/blob/v0.31.3/src/sys/socket/sockopt.rs)
  still use the broad Apple gates. Its checksum-verified official archive also
  fails the iOS net/ioctl consumer. Updating 0.31.2 to 0.31.3 does not solve this.
- [libc 0.2.191 Apple declarations](https://github.com/rust-lang/libc/blob/0.2.191/src/unix/bsd/apple/mod.rs)
  restrict `SYSPROTO_CONTROL`, `AF_SYS_CONTROL`, `UTUN_OPT_IFNAME`, `sockaddr_ctl`,
  and `ctl_info` to macOS. The local verified archive was inspected too.

`upstream-review.json` records this review and the official 0.31.3 checksum.
The fixed rustix 1.1.6 and age changes already integrated by main are untouched.

## Patch boundary

Each patch preserves version, crate manifest, lockfile, features, and all numeric
constant definitions. The only public API gates narrowed to `target_os = "macos"`
are `SockProtocol::KextControl`, `sockopt::UtunIfname` where present (0.29+), and
the `ioctl`-dependent `SysControlAddr` module, re-export, and storage accessors.
Storage conversion, display, hash, and equality branches follow that same gate.
`AddressFamily::System`, IPv4/IPv6, normal TCP/Unix sockets, and unrelated ioctl
APIs remain available as before.

Private `CString` helpers follow `UtunIfname`'s macOS/net gate. The two older
releases additionally need gates for private `GetOsString`/`SetOsString` helpers
and their imports: only Linux/Android `BindToDevice` or FreeBSD/net
`TcpCongestion` constructs them. Path overrides expose the crates' existing
`deny(unused)` errors on Apple, which registry builds normally cap. These helper
gates address the actual callers; no lint suppression or broad cleanup is added.
The hundreds of old 0.28 cfg warnings and the 0.29 lifetime warnings remain in
the logs. This is not a warning-free build claim.

This removes unavailable macOS-only APIs from iOS. It does not add a VPN/utun
capability, supply fake constants, weaken an advisory, downgrade libc, or attempt
a universal platform port.

## Reproducible preparation and main-agent integration

From the repository root, main can run after review:

```sh
python3 patches/nix-ios/prepare.py
```

This prepares `.build/vendor/nix-0.29.0`. Add the following entry to the existing
`[patch.crates-io]` table in **shared/rust-bridge/Cargo.toml**:

```toml
nix_029 = { package = "nix", version = "=0.29.0", path = "../../.build/vendor/nix-0.29.0" }
```

Main then updates that lock selection with the existing stable 1.99 environment:

```sh
cargo update --manifest-path shared/rust-bridge/Cargo.toml --offline -p nix@0.29.0
```

Review the lock diff and continue the real iOS check. These integration actions
were not run here. Do not create a second `[patch.crates-io]` table.

If a later tree inspection shows sockets on another selected line, prepare that
version explicitly, e.g. `python3 patches/nix-ios/prepare.py --version 0.28.0`.
The optional entries are:

```toml
nix_028 = { package = "nix", version = "=0.28.0", path = "../../.build/vendor/nix-0.28.0" }
nix_030 = { package = "nix", version = "=0.30.1", path = "../../.build/vendor/nix-0.30.1" }
nix_031 = { package = "nix", version = "=0.31.2", path = "../../.build/vendor/nix-0.31.2" }
```

Preparation requires Python 3.12+, `patch`, and curl only if an archive is
missing. `--archive-cache` defaults to sibling ALMA's existing toolchain cache.
It reads archive bytes rather than trusting extracted registry source files.
Before extraction it verifies SHA-256 against `shared/rust-bridge/Cargo.lock`
and the reviewed lock-derived checksum in `patches.json`. The original lock's
SHA-256 is recorded there. After main selects a local path, Cargo removes that
package's registry checksum; preparation then uses the preserved reviewed
checksum, requiring the same selected nix version. A missing selection, changed
registry checksum, or different source fails closed.

Only safe regular archive entries are extracted. The patch hash and before/after
hashes of every touched file are checked; a complete inventory proves that no
other crate files changed. Preparation uses a temporary sibling directory and
an atomic rename. Repeated preparation accepts byte-identical output and refuses
to overwrite modified output. `.alma-nix-ios.json` records provenance and the
full file inventory. Existing root files and shared caches are never patched.
`--destination` is restricted to root `.build/vendor/` or this patch's `.cache/`.

## Bounded validation

```sh
python3 patches/nix-ios/validate.py
```

The default existing toolchain is sibling ALMA's
`.build/tauri-toolchain/rustup/toolchains/stable-aarch64-apple-darwin`.
`--toolchain` can override it; validation requires Rust 1.99.0 and an already
installed `aarch64-apple-ios` standard library. It installs nothing.

The script verifies all archive checksums, prepares isolated copies, and creates
standalone consumers with their own manifests/locks, Cargo home, directory
sources, and target directory under `.cache/`. Cargo builds are offline and
locked, with `--jobs 2`, a 120-second limit per case, and no inherited rustflags
or lint suppression. No Codex package is built. It checks:

- Five unchanged actual-feature consumers for the other selected versions.
- The original 0.29.0 failure with the exact project feature set.
- The still-broken official 0.31.3 release, with its registry checksum pinned.
- All four originals failing with `net` + `ioctl`, then all four patched versions
  compiling on iOS and passing a macOS TCP/Unix socket test.
- Compile-fail consumers proving kernel-control APIs remain absent on iOS.
- Patched 0.29.0 on both targets with the exact project features, including the
  current no-ioctl combination.
- Idempotent preparation, refusal of dirty destinations/corrupt archives, and
  preservation of original checksum provenance after a local-path lock update.

The consumer creates and binds a loopback TCP socket, checks TCP_NODELAY, and
creates a Unix socket pair on macOS. iOS is compiled only. macOS also compiles
the retained utun option type and checks kernel-control addresses/constants
against libc; it never opens a kernel-control socket or invokes a VPN ioctl.

All 25 compile/test cases passed with their expected outcomes on 2026-11-01,
using Rust 1.99.0 and libc 0.2.191. Supporting versions remain bitflags 2.13.2,
cfg-if 1.0.4, cfg_aliases 0.1.1/0.2.2, memoffset 0.9.1, and autocfg 1.5.1.
See `validation-summary.json` for portable results and the corresponding local
`.cache/validation-*/results.json` and `build.log` files for exact commands and
diagnostics.

This demonstrates the dependency compatibility fix, not a complete TAH build or
physical-device acceptance. Main owns final Cargo integration and subsequent
iOS validation. RustSec was not rerun; preserve every advisory and follow-up in
`docs/REPOSITORY_AUDIT.md`. No commits or pushes were made.
