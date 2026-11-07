# Phone-owned TAH integration

This is the current entry point for the **Alma TAH 0.4.2 (15)** phone prototype:
**Codex 0.167.0, Kimi Code 2.4.1, ZCode 3.17.2**. It covers the Tauri app,
its sibling-fork build inputs, qualification and retained evidence. For the
main Litter application, use the [iOS Quickstart](../../docs/ios/quickstart.md).

This guide targets the integrated `dev/ios` workflow. The accepted 0.167 source
checkpoints, signed candidate and integration provenance are recorded in the
[upgrade report](../../docs/ios/2026-11-07-codex-0167-upgrade.md). Verify the
actual source locks and resource identities when reproducing a build; a branch
name alone does not establish equivalence to the accepted package.
The [milestone cleanup record](../../docs/ios/2026-11-07-mobile-tah-milestone.md)
identifies the integrated provider commits, retired copies and retained builds.

## Acceptance and boundaries

- Codex foreground short and NVIDIA long V0/V1/V2 qualification passed.
  Shared-provider outcomes, including the retained Kimi first-run failure and
  ZCode semantic deviations, remain separate in the
  [upgrade results](results/2026-11-07-codex-0167-phone.json).
- Codex ordinary-background and physical-lock-screen tests passed **same-task
  recovery after returning to the foreground**. This does not establish
  sustained background/locked execution or recovery after process termination.
  See the [lifecycle report](../../docs/ios/2026-11-07-codex-0167-lifecycle.md)
  and [structured results](results/2026-11-07-codex-0167-lifecycle.json).
- Current 0.4.2 qualification does not establish power consumption. Earlier
  power measurements belong to their recorded app versions and conditions.
- Publication integrity, driver completion, readbacks and factual quality are
  distinct checks. Critic PASS is not an exhaustive factual audit.

Before integrating recording, transcription or the rest of Alma, read the
[frontend integration notes](../../docs/ios/frontend-integration-notes.md).
They preserve the UI decisions, native counterparts and known pitfalls; the
standalone TAH prototype is not acceptance of the entire combined application.

## Ownership

The boundary remains **TAH Framework → Provider Adapter → Provider Backend**.

| Owner | Responsibility |
| --- | --- |
| `shared/tah-runtime/upstream` | Locked app-owned Core: Raw/Extra Guardians, instructions, ledgers, Critic, acceptance and publication |
| `shared/tah-runtime/platform` | Trusted JSCore composition, native primitives and provider loading |
| Sibling `ALMA-codex`, `ALMA-kimi-code`, `ALMA-ZCode` | Locked provider adapters, SDK/runtime resources and native execution modules |
| `apps/ios/Sources/AlmaTAH` | Swift controller/presentation contracts, native integration and canonical SQLite persistence |
| `apps/ios/tah-ui` and `Sources/TauriNativeHost.swift` | Tauri/React presentation and native gateway; no competing workflow or direct Provider RPC from React |

Provider imports are resolved by [provider_sources.py](provider_sources.py).
The app composes fork-owned native code behind its existing UniFFI facade.
Trusted business JavaScript runs in JSCore; model-generated Code Mode runs in
the separate native V8 engine with JIT disabled. Native credential handling and
opaque handles retain the existing boundary.

## Tauri build and reproduction

Run app commands from the **ALMA-litter repository root**. Keep the three provider
forks alongside it; Cargo path dependencies also rely on this sibling layout.
The app's build does not consume the main Litter Codex submodule as its provider
source.

Prerequisites are full Xcode, xcodegen, Python 3.11+, Node/npm, an existing
Rustup toolchain with the iOS and AArch64 Linux-musl targets, and the locked
Cargo/native inputs. Native builds run serially with two jobs and disabled
Cargo incremental compilation. Preserve the 12 GiB start / 8 GiB stop disk
guards and the 32 GiB target limit.

### Prepare and verify inputs

Select the toolchain/cache environment below, then prepare missing
provider-owned inputs using their maintained instructions:

- [Codex native inputs](../../../ALMA-codex/ios/build/README.md): pinned iSH,
  V8, host tools and base rootfs.
- [Kimi SDK](../../../ALMA-kimi-code/ios/sdk/README.md) and
  [Kimi adapter/runtime](../../../ALMA-kimi-code/ios/tah-adapter/README.md):
  the locked SDK, qualified compile-cache and runtime/rootfs preparation.
- [ZCode integration](../../../ALMA-ZCode/ios/README.md): prepare a qualified
  runtime generation and retain its receipt.

Run the ZCode workspace dependency/package preparation before the App TypeScript
check. Its adapter's type-only imports still require `@zcode/contracts` and
`@zcode/provider`; installing only `tools/mobile-tah/node_modules` does not
prepare those sibling workspace dependencies. Use the ZCode guide's frozen-lock
installation and package build steps, or a verified dependency cache for that
same checkout/version.

Use the existing toolchain and a deliberate shared input-cache location:

```sh
export ALMA_RUST_TOOLCHAIN_ROOT="${ALMA_RUST_TOOLCHAIN_ROOT:-$(pwd)/../ALMA/.build/tauri-toolchain}"
export ALMA_IOS_BUILD_CACHE="${ALMA_IOS_BUILD_CACHE:-$(pwd)/tools/alma-ios-lab/.cache}"
export KIMI_ICU_LINKER="$ALMA_IOS_BUILD_CACHE/phone-build-bin/ld.lld"
export RUSTUP_AUTO_INSTALL=0
export CARGO_INCREMENTAL=0
```

The app defaults to sibling forks and its own `shared/tah-runtime`.
`ALMA_CODEX_REPO`, `ALMA_KIMI_REPO`, `ALMA_ZCODE_REPO` and `TAH_RUNTIME`
can select matching isolated sources; these variables do not rewrite Cargo's
sibling path dependencies.

Kimi preparation uses the passing
`ALMA-kimi-code/ios/tests/.cache/tah-sdk/latest.json` receipt and verifies its
runtime manifest. `ALMA_KIMI_COMPILE_CACHE` is an explicit override for a
recorded, qualified generation, not permission to use an arbitrary cache.
The runtime cache's Node identity must match the packaged rootfs.

For the current ZCode baseline, select the **Mac-long-qualified** runtime.
The older default `prephone-runtime.json` is not the accepted generation:

```sh
export ALMA_ZCODE_RUNTIME="$(python3 -c 'import json; from pathlib import Path; print(json.loads(Path("../ALMA-ZCode/ios/.cache/mac-long-candidate.json").read_text())["runtime"])')"
```

If a cleanup relocates that generation, use its retained equivalent and verify
the recorded manifest identity. Do not restore obsolete directories merely to
satisfy old documentation.

Verify the app-owned Core and provider source locks, then prepare the app's
local linker wrappers using the existing toolchain:

```sh
python3 -B tools/mobile-tah/prepare_sources.py --check-only
python3 -B tools/mobile-tah/provider_sources.py --sources
python3 -B tools/alma-ios-lab/prepare_ios_build.py
python3 -B tools/alma-ios-lab/prepare_ios_build.py --check-only
```

The source checks do not adopt or replace source. The wrapper preparer does not
build the app or implicitly install missing targets. Provider rootfs assembly
and initial dependency preparation can require explicit downloads/host builds;
follow the provider instructions above. The normal app resource path invokes
the **sibling fork builders**, not the historical local Kimi builder/probe lane.

### Frontend and app resources

```sh
npm ci --ignore-scripts --prefix tools/mobile-tah
npm ci --ignore-scripts --prefix apps/ios/tah-ui
npm run build --prefix apps/ios/tah-ui
python3 -B tools/mobile-tah/build_tauri.py --resources-only
```

Resource preparation verifies provider inputs, builds the closed trusted JS
bundle and generates `mobile-config.json` plus provenance. It does not invoke
Cargo. `prepare_app.py --config-only` is an internal dependency of this path;
the standalone SwiftUI project generator is not part of this recipe.

On a fresh checkout, or after removing generated Apple inputs, initialize them
with the locally pinned Tauri CLI:

```sh
(
  export CARGO_HOME="$ALMA_RUST_TOOLCHAIN_ROOT/cargo"
  export RUSTUP_HOME="$ALMA_RUST_TOOLCHAIN_ROOT/rustup"
  export RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin
  export PATH="$CARGO_HOME/bin:$PATH"
  cd apps/ios/tah-ui
  ./node_modules/.bin/tauri ios init --skip-targets-install
)
```

Keep `src-tauri/gen/apple/Sources`, `Assets.xcassets` (including AppIcon) and
`LaunchScreen.storyboard`. The final app project is generated separately below.
The React release assets are embedded in the combined Rust library; after
changing them, rebuild that library as well as the Xcode package.

### Combined native library, bindings and package

```sh
python3 -B tools/mobile-tah/build_tauri.py

python3 -B tools/alma-ios-lab/prepare_bindings.py \
  --library shared/rust-bridge/target/aarch64-apple-ios/ios-dev/libalma_tah_ui_lib.a \
  --output-dir shared/rust-bridge/generated/swift-tauri \
  --report tools/mobile-tah/.cache/tauri-bindings.json

python3 -B tools/mobile-tah/prepare_tauri_app.py

xcodebuild \
  -project tools/mobile-tah/.cache/tauri-app/AlmaTAHTauri.xcodeproj \
  -scheme AlmaTAHTauri \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath tools/mobile-tah/.cache/TauriDerivedData \
  -jobs 2 -allowProvisioningUpdates build
```

`build_tauri.py` runs offline Cargo against package `alma-tah-ui`,
target `aarch64-apple-ios`, profile `ios-dev`. Its `--check` option is a
compiler check, not an archive build; `--timeout-minutes 60` can accommodate
a cold build. `--artifact-report PATH` records Cargo artifact JSON for cleanup.

The app links **only `libalma_tah_ui_lib.a`**. Generate bindings from that exact
archive after its build completes; do not additionally link the standalone
`libcodex_mobile_client.a` or a metadata-only archive. Binding generation may
build the host bindgen utility when no retained generator is available.

Packaging verifies the native archive and its source provenance. A retained
archive can be reused only when those checks match. Changes limited to external
JS/runtime resources need no Rust rebuild when the native and embedded-frontend
inputs remain identical.

Verify the resulting signed package:

```sh
python3 -B tools/mobile-tah/verify_app.py \
  --app tools/mobile-tah/.cache/TauriDerivedData/Build/Products/Release-iphoneos/AlmaTAHTauri.app \
  --report tools/mobile-tah/.cache/current-app-verification.json \
  --expect-app-version 0.4.2 --expect-app-build 15 \
  --verify-native-inputs --phone-candidate
```

For exact resource reproduction, also pass `--expect-kimi-manifest` and
`--expect-zcode-manifest` from the selected qualification receipts.
`--phone-candidate` records Mac package readiness, not a phone PASS.
These build/verification commands do not install an app or start a model task.

## Phone qualification and evidence

The Tauri package includes
[the synthetic short fixture](fixtures/mobile-qualification-fixture.json).
The explicit `--mobile-tah-qualification` launch runs phone-owned Raw and
V0/V1/V2 with six material readbacks. A normal launch does not run the fixture.
For an account-reuse-only run, `--mobile-tah-reuse-auth-only` prevents interactive
login fallback; `--mobile-tah-expected-provider=ID` checks the selected provider
before inspection/model work.

The private NVIDIA fixture is added with
`prepare_tauri_app.py --long-fixture PATH/mobile-qualification-nvidia.json`.
It contains the full 254-turn transcript and the agreed three deltas; its
identity and explicit model/language/Web settings must match the evidence.
Use [supervise_long_phone.py](supervise_long_phone.py) only for an explicitly
authorized run; `--no-power` omits Instruments. Power collection is separate
from functional qualification.

The phone Framework owns Guardian ordering, model calls, acceptance and
publication. The Mac may launch the authorized app and observe progress; it
must not dispatch roles or publish results independently. An observer timeout
does not cancel the Core task or establish its final outcome. An inactive app
with readable protected data is a foreground interruption, not proof that the
user must unlock the phone.

Validate published file bytes/hashes and complete working logs from the copied
SQLite database **with its WAL**. Compare every baseline event. Driver readbacks
contain rendered text and have a different hash domain from canonical Markdown.
Short-fixture acceptance preserves facts; the NVIDIA append/retitle fixture has
its own stricter byte-preservation rules. Keep machine checks and factual review
separate, and retain failures, retries and quality deviations.

### Device Hub text entry for phone qualification

Use Device Hub **Edit → Send Clipboard** for exact fixture text, then confirm
the complete field before submitting. Before the user types on the phone,
stop Screen Sharing and verify **View Screen**; disabling Capture Keyboard alone
is insufficient. Update the installed app in place, preserving signing/Keychain
identity and its data container. Historical scene-restoration recovery is
documented in the retained evidence and is not a general reset procedure.

Keep source, locks, qualification reports, required reproducible inputs, the
current signed candidate and one selected rollback. Remove only obsolete
task-owned outputs after checking consumers. Do not bulk-delete caches referenced
by provider receipts, active worktrees or retained package provenance.
The retained current package is
`.cache/codex-0167-upgrade-20261107/candidate/AlmaTAHTauri.app`; the selected
rollback is `.cache/candidates/0.4.1-14/AlmaTAHTauri.app`. Its frozen native/source
provenance stays with the qualified experiment. A cleaned checkout may need a
fresh native build if its input inventory differs; do not bypass that check or
relabel the old package as rebuilt from the cleanup commit.

<a id="kimi-provider-integration-2026-11-03"></a>
<a id="main-thread-responsiveness-follow-up-2026-11-02"></a>

## Historical evidence

These dated records describe their original versions and conditions. They are
not alternative current build instructions; failed attempts and superseded
decisions remain part of the evidence.

| Record | Preserved purpose |
| --- | --- |
| [2026-11-02 milestone](../../docs/ios/2026-11-02-milestone.md) | Original phone-owned Codex/TAH milestone |
| [Frontend integration notes](../../docs/ios/frontend-integration-notes.md) | UI decisions, migration pitfalls and dated frontend evidence |
| [2026-11-03 Kimi integration](../../docs/ios/2026-11-03-kimi-integration.md) | Initial Kimi integration, compatibility fixes and Web outcomes |
| [2026-11-04 Kimi serial tools](../../docs/ios/2026-11-04-kimi-serial-tools.md) | Serial/cancellation behavior and original long-task measurements |
| [2026-11-04 provider-fork integration](../../docs/ios/2026-11-04-release-provider-integration.md) | Source relocation and 0.3.6 acceptance |
| [2026-11-05 composition](../../docs/ios/2026-11-05-provider-composition.md) | Three-provider composition and resource ownership |
| [2026-11-07 0.4.1 requalification](../../docs/ios/2026-11-07-phone-requalification.md) | Original driver interruption, publications and content deviations |
| [2026-11-07 0.4.1 lifecycle/power](../../docs/ios/2026-11-07-lifecycle-power.md) | Earlier package's foreground, background, lock and power scope |
| [2026-11-07 release assessment](../../docs/ios/2026-11-07-provider-release-assessment.md) | Upgrade decision before the separate 0.167 experiment |
| [2026-11-07 Codex 0.167 upgrade](../../docs/ios/2026-11-07-codex-0167-upgrade.md) | Current candidate provenance and provider qualification |
| [2026-11-07 Codex 0.167 lifecycle](../../docs/ios/2026-11-07-codex-0167-lifecycle.md) | Current package's same-task foreground-return recovery |

Each report links its structured results. Earlier UI and native check records
remain in [results/](results/); their scope is the dated run, not a fresh PASS.
