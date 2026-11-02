# P0 decision: exclude the unused remote transport (Option B)

Recommend **Option B** for ALMA P0: local Codex + official Web/native HTTP.
Make the mobile client's direct Iroh dependency optional behind a default-on
`remote-alleycat` feature. Keep proximity pairing behind a separate default-on
`remote-pairing` feature. Select neither for the ALMA local build. Default
upstream/desktop/Android selections retain both features and the real transport.

This cuts the unused capability at its application boundary. It does not port
Darwin private routing ABIs, downgrade libc, return an empty successful inventory,
or create an endpoint/healthy session substitute.

**Deliverable:** `proposal.patch`, with complete before/after files and
`source-hashes.json`. It is a review proposal, not an applied or fully compiled
client change. All writes are under `patches/ios-network-scope/`. The actual
shared Rust/Cargo, Codex submodule, other agents' files, prior patch directories,
registry sources, and phone were not edited. No commits or pushes were made.

## Why stop dependency-level porting here

The actual failure in `cargo-check-ios-7.log` is netwatch 0.19.1's BSD route
monitor/parser being selected for iOS, while libc 0.2.191 deliberately limits the
required routing constants/types to supported platforms. This is a missing
platform implementation, not 21 unrelated definitions to recreate.

The complete relevant caller chain is:

```text
codex-mobile-client (unconditional direct iroh dependency today)
└─ iroh 1.0.3 [default, fast-apple-datapath, metrics, portmapper, tls-ring]
   ├─ netwatch 0.19.1
   │  └─ netdev 0.45.0 [default/gateway/Apple-extra/Android-extra]
   ├─ portmapper 0.19.1 → netwatch 0.19.1
   └─ iroh-relay 1.0.3
```

No other active route to Iroh/netwatch/netdev/portmapper remains in the proposed
local iOS tree. All literal `iroh::` uses in the mobile crate are in the Alleycat
transport, its shared endpoint owner, the remote terminal backend, and the
Android context probe. Local Codex's in-process connection and the official Web
extension do not use these APIs. Alleycat bridge-core/adapters are **not** removed:
local Studio, SSH bootstrap, and local Codex executable resolution still share
those helpers. Removing every dependency with “Alleycat” in its name is not the
correct cut.

### Option A: genuine networking port / coordinated upstream upgrade

The maintained [netdev iOS fix, PR #195](https://github.com/shellrow/netdev/pull/195)
is in 0.47.0 and also replaces iOS-unavailable SystemConfiguration calls.
Netwatch 0.19.1 requires netdev ^0.45.0; newer netwatch 0.19.3 uses ^0.46.1 on
Apple, and the checked upstream 0.20.0 manifest still uses 0.46.3. A direct
netdev 0.47 pin cannot satisfy those requirements.

Current upstream netwatch still selects iOS in its
[BSD cfg](https://github.com/n0-computer/net-tools/blob/main/netwatch/build.rs)
and its [BSD monitor](https://github.com/n0-computer/net-tools/blob/main/netwatch/src/netmon/bsd.rs)
still imports `RTAX_*` from libc for iOS and opens an `AF_ROUTE` raw socket.
The checked [manifest](https://github.com/n0-computer/net-tools/blob/main/netwatch/Cargo.toml)
is 0.20.0. No complete maintained public-API iOS replacement was established by
this review (2026-11-01).

A genuine Option A needs an iOS public-API backend for interface/path changes
and routing information, coordinated netdev/netwatch/Iroh versions, explicit
unknown/unavailable metadata, and verified subscribe/update/suspend/resume
behavior. Public Network.framework path monitoring plus supported address
enumeration may be building blocks; they are not a drop-in proof of netwatch's
route-monitor and default-gateway contracts. A no-op monitor, permanently healthy
state, or guessed routing ABI would invalidate Iroh's path repair behavior.
That is deferred remote networking work and exceeds the local text/Web P0.

## Concrete proposal files

Paths below are repository-relative; all proposed copies are in `after/`.

| File | Change |
| --- | --- |
| `shared/rust-bridge/codex-mobile-client/Cargo.toml` | Optional Iroh; default `remote-alleycat` and `remote-pairing` features |
| `…/src/alleycat.rs` | Move transport-independent records/runtime-name mapping/error type into a shared module; actual transport unchanged |
| `…/src/alleycat_types.rs` (new) | Same pure records/mapping/error definitions for both builds |
| `…/src/alleycat_disabled.rs` (new) | Pair payload entry point returns explicit unsupported error |
| `…/src/network_scope.rs` (new) | Compile-time capability accessors and stable unsupported messages |
| `…/src/lib.rs` | Select real or disabled Alleycat module |
| `…/src/mobile_client/mod.rs` | Gate real endpoint ownership, inventory/connect/restart operations; preserve local connection code |
| `…/src/ffi/client.rs` | Expose capabilities; endpoint warm-up returns `None` with an unsupported diagnostic when absent |
| `…/src/terminal/mod.rs`, `…/src/terminal/backend.rs` | Exclude remote backend and return existing `TerminalError::Unsupported` |
| `…/src/pair/mod.rs` | Gate listener/client constructors; disabled calls return errors before binding or connecting |
| `…/src/android_context.rs` | Keep real Iroh probe with default feature; an explicitly disabled probe returns an error |
| `…/src/reconnect.rs` | Skip saved Alleycat records in the local build instead of retrying or falling through to another transport |
| `apps/ios/scripts/build-rust.sh` | Opt-in `--alma-local`; pass `--no-default-features` to every Rust archive build |
| `shared/rust-bridge/generate-bindings.sh` | Same local profile for the host metadata dylib; default remains unchanged |
| `tools/scripts/uniffi-bindings-input-hash.sh` | Include local/default profile in binding cache hash |

The feature declarations are:

```toml
[dependencies]
iroh = { version = "1.0.3", optional = true }

[features]
default = ["remote-alleycat", "remote-pairing"]
remote-alleycat = ["dep:iroh"]
remote-pairing = []
rpc-trace = []
```

These are ordinary application dependency features, not `[patch.crates-io]`
substitutes. Defaults preserve the existing transport. ALMA uses
`--no-default-features`, optionally `--features rpc-trace`.

No edits are proposed to Popper's `perf_profile.rs`, `thread_projection.rs`, or
`types/server_requests.rs`, to Averroes's auth/scoped-file implementations, or to
Dewey's iSH lifecycle code. `ffi/client.rs` and `mobile_client/mod.rs` are shared
files: the proposal changes only remote/capability/endpoint regions. Main should
review hunk overlap before applying; hashes record the actual source snapshot.

## Disabled behavior is explicit

| Operation in local build | Result |
| --- | --- |
| Alleycat payload parsing, inventory, connect | Error containing `unsupported: remote Alleycat/Iroh is not included in this local build` |
| Connect side effects | Error before a server/session/health update, endpoint bind, or inventory publication |
| Remote terminal | Existing typed `TerminalError::Unsupported` |
| Pair host / pair client | Error before listener binding, WebSocket connection, or handle creation |
| Endpoint warm-up / key readback | No endpoint or generated key; `None`, with capability false and warm-up diagnostic |
| Endpoint shutdown | Idempotent cleanup with no resource to close; no health result |
| Saved Alleycat reconnect | No automatic attempt and no fallback to a different transport |
| Local Codex, native HTTP, Web | Existing implementation retained |

FFI records and existing entry-point signatures remain present in both builds.
The two additive `AppClient` capability methods return build availability, not
network reachability. P0 native UI should hide/disable Alleycat and nearby pairing
using these methods; a persisted/direct call still gets the explicit failure.
Existing `ClientError`/`PairError` transport variants carry the unsupported
message, avoiding a new exhaustive FFI error enum. No API returns `Ok([])` or an
invented successful/connected state to conceal the missing capability.

Native entry points for main's P0 UI review are
`apps/ios/Sources/Litter/Views/DiscoveryView.swift` (presents the Alleycat sheet),
`AlleycatAddServerSheet.swift` (inventory/connect), and `TerminalScreen.swift`
(remote terminal choices). `Models/AppRuntimeController.swift` already avoids
persisting a generated Alleycat key when Rust returns `None`; optionally skip
its remote key preload when the new capability is false. These Swift files are
not included in the proposal. Keep their P0 entry points hidden/disabled or show
the explicit unsupported result; do not convert an error into a connected UI.

This proposal is specifically the Alleycat/Iroh and proximity-pairing boundary.
It does not redesign SSH/Slingshot or remove their APIs. P0 navigation should
expose only the authorized local Codex/Web flow; broad remote-API cleanup is not
needed to remove the failing graph.

## Dependency and bounded validation evidence

`inspect_tree.py` copies the small bridge workspace beneath this folder's
`.cache/`, overlays proposed files, and uses read-only links to upstream sources.
It resolves trees offline, without compiling the client. Only the owned copied
lockfile may change. `tree-summary.json` and `tree-*.txt` record outcomes:

- **iOS local:** Iroh, iroh-relay, netwatch, netdev, and portmapper absent.
- **iOS default and macOS default:** Iroh 1.0.3 and the current remote graph remain.
- **iOS local:** codex-core, codex-app-server, codex-web-search-extension, Tokio,
  Hyper, and reqwest 0.12 with JSON/stream/native TLS features remain.
- **Android default:** offline tree resolution stopped because
  `android_system_properties 0.1.5` is not cached. No fetch/install or Android
  build was performed. The default features and original Android probe body are
  retained; full Android validation remains main's gate.

A real feature-unification change is recorded: reqwest 0.13 (used by RMCP) loses
Iroh's incidental TLS activation in the local graph. Codex's workspace/native
HTTP and official Web use reqwest **0.12**, whose TLS remains enabled. If P0 later
requires arbitrary remote MCP HTTPS, declare its TLS requirement directly and
validate it; do not keep Iroh solely to enable another dependency's TLS feature.

`validate.py` checks patch applicability, source hashes, all proposed Rust file
syntax with `syn`, shell parsing, Bash 3.2 default/local/rpc-trace argument
combinations, and isolated early-error contracts. The harness uses real proposed
pure types/disabled parser and exact disabled method bodies, with inert signature
placeholder types **only in the test harness**. It validates immediate error
behavior, not the full MobileClient's type correctness or integration. Host tests
pass with default and local flags, and the local contract library builds for
`aarch64-apple-ios` on existing stable Rust 1.99, with at most two jobs.

No complete mobile-client build, UniFFI generation, Xcode link, or phone test was
performed. These results do not establish a successful app build. See
`validation-summary.json` for the precise scope and local logs.

## Main-owned application, linking, and runtime acceptance

1. Review `proposal.patch` against concurrent work, then apply it. The report's
   `before/` / `after/` copies and hashes make each hunk reviewable. Do not blindly
   regenerate the proposal after a semantic source change.
2. Resolve the updated lockfile and verify the **actual** local iOS tree. Then
   consider `optional-remove-netdev-override.patch`: the local tree no longer
   needs that source override. Keep earlier netdev/nix evidence folders. Do not
   revert unrelated age, Starlark, rustix, auth, or iSH fixes or suppress advisories.
3. In the existing stable toolchain environment, continue the real check with
   the feature selection carried explicitly:

   ```sh
   tools/alma-ios-lab/cargo_ios.sh check -p codex-mobile-client \
     --target aarch64-apple-ios --no-default-features --jobs 2
   ```

4. Build the **real static library**, not merely metadata, with the same local
   selection. Use main's current approved build environment and sync/patch policy:

   ```sh
   tools/alma-ios-lab/cargo_ios.sh rustc -p codex-mobile-client \
     --target aarch64-apple-ios --profile ios-dev \
     --no-default-features --jobs 2 --crate-type staticlib
   ```

   Regenerate Swift/headers from a host metadata dylib built with the same
   `--no-default-features`. The proposed script route is
   `build-rust.sh --fast-device --alma-local --force-bindings`; it propagates
   `LITTER_ALMA_LOCAL=1` into `generate-bindings.sh`. Review that script's existing
   submodule/iSH/Ghostty steps against main's 0.166 lane before executing it.
   Direct Cargo commands bypass those orchestration steps, so main must still
   stage the resulting archive and matching headers for Xcode.
5. Use a fresh build output selection or force the relevant build/copy steps.
   A Make stamp does not automatically notice an environment-only feature change.
   The binding hash now includes profile, but Rust/Swift generated artifact paths
   are still shared with the default build: avoid concurrent local/default
   generation into those paths, and never reuse a default metadata dylib with a
   local archive merely because the filenames match.
6. Link the arm64 device app with the freshly staged static library, matching
   UniFFI header/modulemap/Swift, iSH and Ghostty native objects, deployment target,
   and required Apple/C++/TLS frameworks. Inspect the final link and unresolved
   symbol output. No netwatch/netdev/Iroh objects should be selected; specifically
   inspect for their iOS-unavailable SystemConfiguration references (e.g.
   `SCNetworkInterfaceCopyAll`, `SCNetworkServiceCopyAll`, `SCPreferencesCreate`,
   `SCDynamicStoreCreate`, `SCDynamicStoreCopyValue`). Do not remove all
   SystemConfiguration/Network framework links blindly: unrelated native code may
   legitimately use public APIs there.
7. Run the signed app through main's permitted device workflow: local Codex
   startup → authenticated official API request → streamed text response → official
   Web/search request, verifying native HTTP/TLS rather than an iSH networking
   workaround. Check foreground/background recovery and iSH lifecycle with Dewey.
   Exercise a stale saved Alleycat record and explicit pair/remote calls: capability
   false, explicit unsupported behavior, no endpoint bind, phantom connected state,
   or listener. Confirm keychain/auth/scoped-file behavior with Averroes.
8. Before merging/releasing shared feature changes, verify the ordinary default
   macOS/Android builds and remote regression tests in the appropriate environment.
   Full local type integration belongs with main/Popper. Existing advisories and
   physical-device acceptance requirements remain in force; RustSec was not rerun.

## Reproduce this review without applying it

From the repository root:

```sh
python3 patches/ios-network-scope/inspect_tree.py
python3 patches/ios-network-scope/validate.py
```

`propose.py` regenerates the **proposal copies only** from current source, with
exact-match guards and new hashes. It never applies the patch. Use regeneration
only intentionally after reconciling concurrent edits. Scripts use existing
standard tools and the existing stable toolchain; they install nothing.
