# Phone-owned TAH integration

The consolidated **0.4.1 (14)** candidate was built and signed on Mac on
2026-11-07 and has now passed phone foreground qualification, including full
NVIDIA V0/V1/V2 on both Kimi and ZCode. It contains the
ZCode Mac-long-qualified non-streaming runtime plus the subsequent native proxy
patch. Codex remains 0.166.0, Kimi Code 2.4.1 and ZCode 3.17.2. The retained
package is `.cache/candidates/0.4.1-14/AlmaTAHTauri.app`; its `verification.json`
checks signature, exact runtime manifests, expected app version/build and the
native archive/source identity at build time. Later source-only observer changes
are not installed in this candidate. The full build receipt is
[`results/2026-11-07-zcode-consolidated-build.json`](results/2026-11-07-zcode-consolidated-build.json).
Use explicit `ALMA_ZCODE_RUNTIME` from `ALMA-ZCode/ios/.cache/mac-long-candidate.json`
when rebuilding this candidate; the earlier short-task runtime pointer remains
unchanged. The selected signed rollback is `.cache/rollback-20261107/AlmaTAHTauri.app`.
See [release upgrade assessment](../../docs/ios/2026-11-07-provider-release-assessment.md)
for the separate Codex 0.167 / Kimi 2.5.2 evaluation; neither was upgraded.

Current foreground, unplugged-power and lifecycle evidence is tracked in
[the phone qualification report](../../docs/ios/2026-11-07-phone-requalification.md)
and [the lifecycle/power report](../../docs/ios/2026-11-07-lifecycle-power.md).
Power is approximate reference data, not a blocking precision measurement.
Recovery after foreground return does not establish sustained background execution.

This application integration lane composes the app-owned TAH framework with
the release-pinned provider sources in sibling `ALMA-codex` and
`ALMA-kimi-code` and `ALMA-ZCode` repositories. Build 0.3.6 (12) is the previous
Codex/Kimi long-task baseline. The earlier 0.4.0 (13) composition has Kimi cached
V0/V1/V2 and ZCode V0–V3 short-task phone evidence in `results/2026-11-05-*.json`;
see [current composition](../../docs/ios/2026-11-05-provider-composition.md).

## NVIDIA long-task and unplugged-energy qualification

Build with `prepare_tauri_app.py --long-fixture PATH/mobile-qualification-nvidia.json`.
The ignored fixture must contain the existing full 254-turn NVIDIA transcript
(end 02:05:24), the same three deltas for both providers, zh-CN and Web enabled.
Its raw UTF-8 identity is recorded in the composition spec. The committed source
does not contain the user's transcript. Use the regular provider runtimes, not
the SDK-load measurement overlay.

After installing, restore/select the intended provider through the ordinary UI,
stop Device Hub sharing, get the user's unplug confirmation, and verify a cool
idle baseline. Then run:

```sh
python3 tools/mobile-tah/supervise_long_phone.py --provider kimi --output tools/mobile-tah/.cache/LONG_RUN/kimi
```

Use a fresh directory for each run. The recorder launches the App with
`--mobile-tah-long-qualification`; Mac only reads progress. The phone runs Raw,
V0, Extra/V1 and Extra/V2, with a 30-second initial recorder wait and a 45-minute
observer deadline per phase. Native/provider timeouts are unchanged. The App
records battery, charging, thermal and brightness state once per minute and at
stage changes. Power Profiler plus Thermal State records device energy; CPU
profiling and screen sharing stay off. The collector stops when the phone report
ends, then exports the power data. The full trace includes initial/final idle;
clip it to the actual task intervals before comparing providers.

Repeat for ZCode after cooling. V0 alone is partial: validate all publications,
prior-file immutability, V1's append-only key points, V2's exact heading change,
unchanged ASR files and unplugged energy evidence. Treat rounded battery drop and
instrument-estimated percent/hour as different measurements. Preserve failed
reports; a driver timeout never means the Core was cancelled.

If Instruments blocks, prioritize function as the user requested:
`supervise_long_phone.py --provider zcode --no-power --output NEW_RUN_DIR`.
This uses ordinary devicectl launch, never starts Instruments, and retains the
phone's bounded battery/thermal samples. A malformed/incomplete trace is not
power acceptance and must not be used to quote an hourly power rate.

## Optional phone SDK-load measurement

Preserve the current signed App before this measurement. Run
`python3 tools/mobile-tah/profile_load_checks.py`, then
`python3 tools/mobile-tah/prepare_tauri_app.py --load-profile` and the usual
resource-only Xcode build with the verified native archive. The preparation
copies the immutable provider resources and changes only each guest entry;
SDK/cache hashes remain identical. Its generated receipts identify both copies.

Install that diagnostic App and launch with **both**
`--mobile-tah-qualification --mobile-tah-load-profile`. It uses the currently
authorized provider and runs two fresh synthetic Raw Guardian tasks. The phone
still owns the actual Framework/Adapter/backend flow. Read
`Documents/provider-load-profile.json` and
`Documents/mobile-tah-qualification.json` after completion. Save each provider's
reports before relaunching, because the collector bounds/reset its process-local
sample list. SDK import, validation/copy and native prepare/start timings are
separate; whole workflow time includes remote inference. `prepared` means
the cache passed validation and was enabled, not independent proof that V8
accepted every bytecode entry on the phone.

The dedicated actor removes diagnostic terminal metadata before the strict
Adapter sees it, including the repeated close receipt. It records only bounded
numeric values and known status labels, never prompts, content or credentials.
The build marker disables this path in a regular App. Restore the qualified
non-profile App afterwards, regenerate the ordinary project without
`--load-profile`, and delete the disposable profile package/resources.

The current source ownership, reproducible build commands and both providers'
NVIDIA V0/V1 acceptance are recorded in
[the release-fork integration report](../../docs/ios/2026-11-04-release-provider-integration.md).
The dated sections below retain the earlier prototype qualification history.

Before combining this test app with the full mobile app, read the [mobile frontend integration notes](../../docs/ios/frontend-integration-notes.md). That is the central record of reusable UI decisions, fixed pitfalls, code locations and integration checks.

The phone presentation is Tauri + React, styled after Alma Preview, with
Markdown rendering in the WebView. Earlier native Tauri packages were built,
installed and checked on the phone with the existing SAM v0 data. A prior chat
build also completed one Tauri-initiated synthetic revision v3 through the
original phone-owned framework. The dated acceptance records below identify
the qualified builds and workflows.

## Ownership

- `shared/tah-runtime/upstream`: hash-locked copy of the current Mac business core.
- `shared/tah-runtime/platform`: JSCore primitives, application composition and neutral attempt port. The bundler resolves provider-specific adapters from the sibling forks through `provider_sources.py`.
- `apps/ios/Sources/AlmaTAH`: presentation DTOs/controller, the original Swift SQLite journal, trusted JSCore host and native platform connection. The SwiftUI views remain available as a fallback.
- `apps/ios/tah-ui`: React/Markdown frontend and the Tauri Rust crate. `tah_ui(method,value)` calls the Swift gateway through C FFI; it does not expose Provider RPC to React.
- `Sources/TauriNativeHost.swift`: constructs one controller and delegates to `TAHWebPresentationBridge`. Bootstrap, sign-in and external links stay in this native host.
- `mobile_tah_host.rs` owns trusted material/auth composition. The native facade path-includes Codex lifecycle and shared execution modules from `ALMA-codex/ios/native`, and the Kimi transport and resource installer from `ALMA-kimi-code/ios/native`.

The Framework retains Raw/Extra Guardian ordering, prompts, ledgers, critic,
acceptance and publication. Swift does not implement a competing workflow.
Provider RPC, receipts and normalizers remain in the Adapter. Only typed native
Keychain calls carry tokens; trusted JavaScript receives an opaque native handle.

JavaScriptCore executes trusted business code only. Model-generated Code Mode
JavaScript runs in the separate existing native V8 engine with JIT disabled.
Changing the viewport does not change the boundary
`TAHFramework -> ProviderAdapter -> ProviderBackend`, the prompts, the journal,
or Guardian/critic/publication decisions.

## Kimi serial tools and current app (2026-11-04)

App **0.3.5 (11)** passed the full NVIDIA V0 on the iPhone with
`k3.1-pro / max`, Chinese output, and Web enabled. Generation took 26m 7.290s,
settled 86 tools, and published both files with Rule Critic `PASS`. All 171
pre-test journal events remained byte-identical. Unplugged power-only windows
at 51% brightness measured 17.3, 12.9, and 15.4%/hour during Actor, with
`Nominal` thermal state throughout. These are separate whole-device instrument
windows. The final window is clipped to publication time.
[Device acceptance evidence](../../docs/ios/2026-11-04-kimi-serial-tools.md#device-acceptance)

The trusted Kimi guest enables `ALMA_KIMI_SERIAL_TOOLS=1` before SDK load.
A locked SDK source patch serializes preparation, execution, finalization, and
result publication for each tool in the original model batch. The original
SDK model loop and hash-locked TAH Core retain their workflow responsibilities.
All three focused checks and the extended 105-check Kimi SDK suite passed.
The native Kimi and owned-executor suites passed 29 and 24 checks respectively. The 16-call
fixture peaks at one actual execution and one active tool lifecycle, and the
12-call cancellation fixture executes only its blocking search. A fresh-source
offline rebuild reproduced the exact locked SDK hash.
[Serial-tool implementation and evidence](../../docs/ios/2026-11-04-kimi-serial-tools.md)

## Kimi provider integration (2026-11-03)

Kimi Code is implemented in the combined Tauri prototype. The pinned release is
`@moonshot-ai/kimi-code@2.4.1`, SDK `0.22.0`, from source commit
`2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7`. The release lock preserves the reviewed
permission-rules and mobile serial-tools patches, build inputs, and SDK entry hash.

The implementation adds provider registration/configuration, native Kimi key
entry and Keychain storage, opaque credential handles, the mobile Kimi Adapter,
an iSH Node guest running the real SDK Harness, and a Rust HTTP/process broker.
The guest uses a placeholder credential. Rust admits the frozen model/Web routes
and supplies native authentication. The original Framework owns role ordering,
critic, acceptance, revisions, and publication.

Local exports verify a real-API Raw Guardian run on 2026-11-03 from
`09:37:27Z` to `09:38:17Z`, with a saved ALLOW assessment and completed
close/capture/release. Action `3a92da08-200d-4585-8b65-d7b18dd989af` completed
V0 and V1 using `kimi-for-coding / low`, interaction language `zh-CN`, action
language `en`, and `Web=false`. UI elapsed times were 78 seconds and 2m18s.

The exported `.cache/kimi-phone-v0-journal/tah.sqlite3` and
`.cache/kimi-phone-v1-journal/tah.sqlite3` contain both accepted publications,
completed operation states, and critic `PASS`. Read-only integrity checks passed
with zero pending writes. V1's published notes contain the corrected total of
12, and its ledger retains the exact submitted instruction. Diagnostics record
V1 Guardian start at `09:46:53Z` and completion at `09:47:42Z`, followed by Actor
start. V2 also published with critic `PASS` in 166.164 seconds from journal
timestamps. Its WebSearch passed, while two TensorFlow FetchURL attempts failed.
A separate official-service probe returned 403 `websearch_audit_failed` for that
URL. The SDK's local fallback then masked the rejection as a DNS safety error.
V3 subsequently completed the PyTorch FetchURL on the phone and published the
updated notes with critic `PASS` in 137.177 seconds. Its External Reference names
DeepLabV3, FCN and LRASPP and cites the fetched page. Text outside that section
is byte-identical to V2, including the corrected total of 12. The service-only
boundary remains active.

All 127 baseline event rows match byte-for-byte across V0/V1/V2/V3 exports, which
contain 147/151/159/163 rows with zero pending writes and clean integrity checks.
Codex cached authorization is valid in the exported metadata, and existing NVIDIA
V0/V1 records were opened in the UI at 18:22 Asia/Shanghai. Kimi cached reconnect
is valid in the export checked at `10:24:41.203Z`. V3 started at 18:32 local with
`kimi-for-coding / low` and Web enabled. The saved UI draft contains the full
PyTorch instruction, including its final period. V3 completed at
`10:34:25.129Z`, with Guardian 60.486 seconds and Actor 76.484 seconds. Core phone
integration passed. Cross-provider new generation, long transcripts, background
execution, and power consumption remain untested. The records dated
2026-11-01 and 2026-11-02 below describe the prior Codex lane.
[Sanitized phone results](results/2026-11-03-kimi-phone.json)

The Mac owned-policy probe has passed Raw Guardian Read/Glob/Grep and Actor
Write/Edit/read-back with synthetic HTTP, the actual Rust host crate, and the
qualified packaged resources. Each case reached `end_turn`, guest exit 0, owned
closure, and private-home cleanup. These runs exercise the original grants.

Two runtime compatibility fixes are included in packaging. The pinned ICU data
is embedded in `libicudata.so.74.2` for private ELF mappings, and the guest uses
Node's callback realpath through `promisify` before SDK import. The ICU transform
is locked by `kimi-tools/source-lock.json.icuEmbedding` and
`rootfsBuildVersion=2`. The evidence record explains the policy failures and
records input/output hashes, ABI checks, and the prepared toolchain versions.

The guest's session and harness close attempts are now independent and sequential.
The targeted injected-failure regression passes all six completion/cancellation
cases, with cleanup precedence and final-answer suppression. `adopt_kimi.py`
encodes the change in the generated adaptation. Retained final logs verify all
12 test groups passed and the cleanup-hardened Xcode package built, installed,
and launched. V2 and V3 publication are recorded on that build, with successful
phone FetchURL verified in V3.

The 2026-11-03 qualified Xcode project and built App use runtime manifest
`8440bebe8469d691df56ed989551cf3453dd72413c8dafb6667146e808c38ae0`,
with guest SHA-256 `2b68bc688d5536b47cff64fb5ee4aa12ed2226507d311dbc578117673fa15a4c`.
The built executable's SHA-256 is
`588b58872d847343489c86a63638c51b52d8b635b9b941a828a89c8a866ef675` and Mach-O UUID is
`44BE0F11-26C8-35CF-87DC-1CE97C209C61`. All 878 packaged runtime files were
verified against the built manifest. The original Mac owned-policy tool runs
remain qualified against manifest `aace22419d604cb313d36d8115c1ad96d71707edb83a13429db9ee8335f013f6`.
The result JSON separates these artifact sets.

Implementation, exact resource identities, completed acceptance, and qualification limits are
recorded in the dated integration report. [Kimi integration evidence](../../docs/ios/2026-11-03-kimi-integration.md)

### Kimi resources and focused checks

Use the prepared dependency lane described below. Resource generation consumes
the fixed SDK closure under `tools/kimi-mobile-probe/.cache/latest-release`.

```sh
python3 tools/kimi-mobile-probe/prepare_latest.py --verify-only
python3 tools/mobile-tah/adopt_kimi.py --check-only
python3 tools/mobile-tah/build_tauri.py --resources-only
python3 tools/mobile-tah/prepare_kimi_runtime.py --verify-only
python3 tools/mobile-tah/prepare_kimi_rootfs.py --verify-only
```

`--resources-only` prepares the Kimi runtime, rootfs, and configuration. The
normal `build_tauri.py` lane then builds the combined native archive. Use the
archive, bindings, and Xcode sequence below to build the installed package.

The focused checks use distinct execution boundaries.

```sh
node --test tools/mobile-tah/kimi_serial_checks.mjs
node --test tools/mobile-tah/kimi_checks.mjs
python3 tools/alma-ios-lab/kimi_backend_regression/run.py
python3 tools/mobile-tah/run_kimi_core_replay.py

python3 tools/alma-ios-lab/kimi_owned_probe/run.py build
python3 tools/alma-ios-lab/kimi_owned_probe/run.py tools-guardian-success
python3 tools/alma-ios-lab/kimi_owned_probe/run.py tools-actor-success
```

Core replay uses synthetic provider results in the real trusted JSCore/SQLite
composition. The backend regression harness compiles production lifecycle code
against isolated test boundaries.
The owned probe exercises the actual iSH Rust host and SDK tools with synthetic
HTTP. Its local `.cache/integrated-inputs.json` freezes the specific Tauri
resource paths listed in the evidence record, and reruns require those prepared
artifacts. Reports and fixtures live under `tools/alma-ios-lab/kimi_owned_probe`.
Phone workflow acceptance is backed by the exported journals and diagnostics
linked in the integration evidence record.

### Device Hub text entry for phone qualification

Use Device Hub **Edit → Send Clipboard** for reliable exact-text entry in these
phone qualification runs. Hardware-keyboard `typeText` passes through the active
Chinese IME and mangled the initial V1 draft. That draft was still unsubmitted.

1. Focus the intended phone field and select the draft to replace, if one exists.
2. Write the complete intended text to the Mac clipboard and wait for that operation to finish.
3. Invoke Device Hub **Edit → Send Clipboard** as the next sequential action.
4. Read back the actual field through the UI and compare it with the intended text, including digits and punctuation.
5. Submit only after the displayed field matches. If it differs, replace the draft and repeat the verification.

Keep clipboard writes and Send Clipboard serialized so another operation cannot
replace clipboard contents between them. Route exact fixture text through this
clipboard procedure instead of hardware `typeText` while the Chinese IME is active.

When the **user** needs to type on the phone (login, OTP, or feedback), first use
Device Hub → More Actions → Stop Screen Sharing and verify that View Screen is
shown. Capture Keyboard being off does not guarantee the phone software keyboard
is restored. Resume sharing after the user confirms completion. Device Hub stays
available for agent-driven testing; this is an input handoff rule.

This exact field content was verified before submission and is retained in the
V1 journal ledger. Native diagnostics record the Guardian start at
`2026-11-03T09:46:53Z` and completion at `2026-11-03T09:47:42Z`.

```text
Correct the total image count to 12. Keep all other facts unchanged.
```

The evidence record includes the exported publications and instruction.
[V0 publication and V1 input evidence](../../docs/ios/2026-11-03-kimi-integration.md#phone-v0-publication-and-v1-input-evidence)

## Tauri build and reproduction

Run these commands from the ALMA-litter repository root unless a block changes
directory. This recipe starts from the existing qualified phone dependency lane:
Xcode, xcodegen, the pinned Rust/iSH/Codex/native V8 inputs, cached Cargo dependencies,
and the fixed rootfs must already be prepared in the order documented in
[build-input preparation](../alma-ios-lab/BUILD_INPUTS.md), including the owned
iSH overlay and `prepare_ios_build.py` wrappers/targets. There is no dependency download
or device execution hidden in `build_tauri.py`.

The base rootfs is `tools/alma-ios-lab/.cache/runtime-rootfs/354d49ec25295e6c/fs`.
The combined Codex/Kimi package uses the verified extension generated under
`tools/mobile-tah/.cache/kimi-rootfs/<lock-sha256>/fs`, together with the sibling
`kimi-runtimes/<manifest-sha256>/kimi-runtime` resource. The generated Tauri project
records the exact selected paths.
`cargo_ios.sh` uses the existing toolchain under
`../ALMA/.build/tauri-toolchain` by default; set `ALMA_RUST_TOOLCHAIN_ROOT` to an
equivalent prepared toolchain if it is elsewhere. This is a development-tool
location, not a runtime dependency on the Mac App.

### Owned core and generated configuration

```sh
python3 tools/mobile-tah/prepare_sources.py --check-only
npm ci --ignore-scripts --prefix tools/mobile-tah
python3 tools/mobile-tah/adopt_adapter.py
python3 tools/mobile-tah/adopt_kimi.py --check-only
python3 tools/kimi-mobile-probe/prepare_latest.py --verify-only
node tools/mobile-tah/build_bundle.mjs
python3 tools/mobile-tah/prepare_app.py --config-only
```

`prepare_sources.py --check-only` verifies the committed owned source inventory
and hashes without needing the sibling Mac repository. Running it without the
flag is the separate, explicit adoption/audit operation against the Mac baseline;
that operation requires the sibling checkout and refuses source drift. Neither
mode silently replaces an existing owned snapshot. The shipping bundle uses only
this repository's owned sources and vendor inputs.

`prepare_app.py --config-only` generates
`tools/mobile-tah/.cache/app/mobile-config.json` directly from owned sources.
It requires no legacy standalone Rust archive, Swift bindings, rootfs, Xcode
project or private fixture, so the Tauri lane can bootstrap independently.
Without that flag, the script remains the original SwiftUI project/fixture
generator and requires that lane's `libcodex_mobile_client.a` and
`shared/rust-bridge/generated/swift` bindings. Those artifacts are **not**
additional link inputs for Tauri.

The optional `prepare_app.py --fixture /absolute/path/fixture.json` replaces the
generated qualification fixture. Its shape is
`{title, transcript, deltas:[v0Text,v1Text,v2Text]}`; `deltas` must contain three
entries. The Tauri package consumes `mobile-config.json`, not that qualification
fixture or the SwiftUI qualification entry point.

### React assets and Tauri CLI-generated Apple inputs

```sh
npm ci --ignore-scripts --prefix apps/ios/tah-ui
npm run build --prefix apps/ios/tah-ui

(
  export ALMA_RUST_TOOLCHAIN_ROOT="${ALMA_RUST_TOOLCHAIN_ROOT:-$(pwd)/../ALMA/.build/tauri-toolchain}"
  export CARGO_HOME="$ALMA_RUST_TOOLCHAIN_ROOT/cargo"
  export RUSTUP_HOME="$ALMA_RUST_TOOLCHAIN_ROOT/rustup"
  export RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin
  export PATH="$CARGO_HOME/bin:$PATH"
  cd apps/ios/tah-ui
  ./node_modules/.bin/tauri ios init --skip-targets-install
)
```

Use the locally pinned `@tauri-apps/cli` (currently 2.12.1). `--skip-targets-install`
assumes the iOS Rust target is already present in the prepared toolchain. Run this
initialization on a fresh checkout or when regenerating CLI inputs after an update.
It produces `src-tauri/gen/apple/Sources` (including the native Tauri launcher),
`Assets.xcassets`, and `LaunchScreen.storyboard`; these generated inputs are needed
by `prepare_tauri_app.py`. Keep the generated asset catalog/AppIcon inputs available.

The final target below is generated separately: do not substitute the CLI's generic
Xcode project or `tauri ios build` for this combined-backend packaging recipe.
The React release assets are embedded by Tauri from `apps/ios/tah-ui/dist`.
After a React change, rebuild both `dist` and the combined Rust archive; an Xcode-only
rebuild can otherwise keep the previous embedded frontend. A dev server is not
required to launch the installed package.

### One combined Rust library and its real UniFFI bindings

```sh
# Optional compiler check; this does not produce the archive.
python3 tools/mobile-tah/build_tauri.py --check
python3 tools/mobile-tah/build_tauri.py

python3 tools/alma-ios-lab/prepare_bindings.py \
  --library shared/rust-bridge/target/aarch64-apple-ios/ios-dev/libalma_tah_ui_lib.a \
  --output-dir shared/rust-bridge/generated/swift-tauri \
  --report tools/mobile-tah/.cache/tauri-bindings.json
```

`build_tauri.py` first prepares the locked Kimi rootfs and runtime resources and
regenerates configuration. It verifies the prepared native V8 environment, then invokes
`cargo_ios.sh rustc --lib --offline -p alma-tah-ui --target aarch64-apple-ios
--profile ios-dev -j 2 --crate-type staticlib`. The `--check` variant uses `cargo check`.
Both modes write `.cache/tauri-native-build.log` and `.cache/tauri-native-build.json`;
the wrapper enforces a 12 GiB start / 8 GiB stop disk-space floor, a 32 GiB
target-directory limit, and a 40-minute default deadline. A cold rebuild after
cache cleanup can use `--timeout-minutes 60`; completed dependencies are reused
after a stopped build. Incremental compilation is disabled to prevent stale
multi-GiB generations from accumulating. Keep the current useful dependency
generation and remove obsolete archives and per-run copies after qualification.

The application links **only** `libalma_tah_ui_lib.a` as its Rust archive. The Tauri
crate already depends on the real `codex-mobile-client` with `alma-code-mode-probe`,
so this archive contains Tauri, Codex, the Kimi native broker, iSH, and native V8 together.
Do not also link `libcodex_mobile_client.a`, a second Rust runtime archive, or a
metadata-only archive into the Tauri target.

`prepare_bindings.py` reads actual `codex_mobile_client-*.o` UniFFI metadata from the
specified archive. It generates the Swift wrapper, header and module maps in
`generated/swift-tauri`, and records hashes in the selected report. It does not
rebuild the phone library; it can build the host bindgen executable if no cached
generator exists. Run it after the native build finishes, not concurrently with it.

Its optional arguments and defaults are:

| Argument | Default when omitted |
| --- | --- |
| `--library` | `shared/rust-bridge/target/aarch64-apple-ios/ios-dev/libcodex_mobile_client.a` |
| `--output-dir` | `shared/rust-bridge/generated/swift` |
| `--report` | `tools/alma-ios-lab/results/2026-11-01-production-bindings.json` |

Use the explicit Tauri arguments above to avoid mixing the two binding lanes or
overwriting the standalone lane's report. No hand-written fixture API signatures
or substitute journal are used.

### Generate and build the native Tauri package

```sh
python3 tools/mobile-tah/prepare_tauri_app.py
xcodebuild \
  -project tools/mobile-tah/.cache/tauri-app/AlmaTAHTauri.xcodeproj \
  -scheme AlmaTAHTauri \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath tools/mobile-tah/.cache/TauriDerivedData \
  -jobs 2 -allowProvisioningUpdates build
```

`prepare_tauri_app.py` also accepts `--resources-only`. Its normal mode consumes the generated Apple inputs,
combined archive, `swift-tauri` bindings, extended rootfs, immutable `kimi-runtime`,
closed JSCore bundle and shared `mobile-config.json`. Its generated project selects Runtime/Persistence,
presentation DTOs, `TauriNativeHost.swift`, and the Tauri launcher; it excludes the
SwiftUI `@main` entry and SwiftUI view files. The target uses iOS 18+, Swift 5.9,
the configured signing team, and the existing extended-virtual-addressing entitlement.

The built product is
`tools/mobile-tah/.cache/TauriDerivedData/Build/Products/Release-iphoneos/AlmaTAHTauri.app`.
Install it as an **in-place update** of `com.alma.litter.agent-probe`, retaining the
same signing/Keychain identity and data container. The separately installed Alma
Preview app is not this target and must remain installed. None of these commands
installs or launches a phone app or runs a model.

### SwiftUI fallback

The previous native SwiftUI host remains in `Sources/MobileTAHApp.swift` with the
views under `apps/ios/Sources/AlmaTAH/Presentation`. Its existing generator is
`prepare_app.py`, producing `.cache/app/ALMAMobileTAH.xcodeproj` / scheme
`ALMAMobileTAH`; that lane uses the standalone Codex archive and `generated/swift`
bindings. It is a separate frontend package, not a second app entry linked into
Tauri. A normal launch uses UI actions; the SwiftUI host's explicit
`--mobile-tah-qualification` flag starts the phone-owned qualification runner.
The Tauri test entry now also implements `--mobile-tah-qualification` and uses
`fixtures/mobile-qualification-fixture.json`. Launching once runs the complete
phone-owned synthetic V0/V1/V2 fixture; read `Documents/mobile-tah-qualification.json`
through devicectl. Normal launches never run the fixture. This is the preferred
qualification lane when Device Hub interferes with the phone's software keyboard.

The dev Mac installs and observes only. It must not dispatch individual roles,
accept candidates, publish revisions, or restart the App between rounds.

## SwiftUI-to-Tauri scene restoration recovery

An in-place update can retain an old SwiftUI scene-restoration cache even though
the new bundle uses `TaoSceneDelegate`. The migration issue was traced to exactly
this app-container-relative directory:

```text
Library/Saved Application State/com.alma.litter.agent-probe.savedState
```

Recovery is **backup first, restoration cache only**, for the diagnosed stale-scene
case; it is not a general response to a TAH, sign-in or model failure:

1. Stop only the `com.alma.litter.agent-probe` app process. Back up its data container
   and copy the exact saved-state directory to a verified recovery location before
   removing anything. A container export does not itself back up Keychain items;
   preserve their existing app/signing identity.
2. After confirming the backup, remove only the directory named above from that
   app's container, then relaunch the updated Tauri package. Keep the backup for
   inspection or a deliberate rollback; do not restore the stale SwiftUI cache
   into the running Tauri package.
3. Verify the existing transcript library, published Notes/ASR materials and account
   availability through the real UI after the update. The confirmed migration and
   reader checks for this package are recorded below; repeat the preservation checks
   for a later update rather than treating cache removal as a routine reset.

**Never uninstall the app or delete AppSupport (`Library/Application Support`),
`mobile-tah-journal`, `mobile-ui.json`, transcript/source data, accepted outcomes,
Documents, or Keychain to fix scene restoration.** Do not delete the whole `Library`
or `Saved Application State` directory. The original Alma Preview installation is
also outside this recovery operation.

## Confirmed Tauri phone UI checks (2026-11-01)

Main confirmed the following against the actual installed frontend and existing
SAM v0 data, after the backed-up, cache-only scene recovery:

- Markdown headings, paragraphs, bold lists and links render in Notes.
- Notes and ASR terms open distinct native files. The real ASR table scrolls
  horizontally; the timestamped raw Transcript remains plain text.
- Language and model controls and the standard reasoning-effort IDs are present.
  Ink/Paper switching works.
- The same data container and Keychain were retained. All original journal event
  columns and chunk bytes are identical before and after the UI migration/checks:
  **7 publications, 0 pending writes, integrity check OK**.

These were reader/settings checks using existing accepted results, not a new
model-generation run. See the [frontend verification notes](../../apps/ios/tah-ui/README.md)
and [UI adoption record](../../docs/ios-tah-ui-adoption.json). Main owns the separate
machine-readable acceptance result under `results/`. No Android acceptance is implied.

## Earlier phone-core evidence and scope

These results establish the core workflow through the earlier phone host. They
are retained as core evidence, not relabeled as the Tauri reader/settings checks
above. No Android build, runtime or UI acceptance is claimed.

`results/2026-11-01-jscore-core-replay.json`: original AppActions/AuthService and
SQLite journal completed six replayed roles in one JSCore instance; all six
published files match prior accepted V0/V1/V2 bytes. This is a **model-free host
portability test**, not live phone acceptance. Reproduce with
`python3 tools/mobile-tah/run_core_replay.py`; its synthetic golden files are owned
by this repository and it requires no Mac ALMA checkout or model credentials.

Previously recorded live foreground phone-core acceptance:

| Input | Whole phone workflow | Verified result |
|---|---|---|
| Synthetic transcript | 106.87 s, Raw → V0 → Extra → V1 → Extra → V2 | Three publications; six files; V1 preserves attribution and corrects 14 to 12; V2 changes only the requested heading; ASR index unchanged |
| NIST, entire 27 turns / 8 min 35 s audio / 9,305 UTF-8 bytes | 155.10 s, Raw plus Extra/Actor for each of V0/V1/V2 | Chinese output and interaction; `gpt-5.6-luna/low` → `gpt-6.1-sol/default` → `gpt-6.1-sol/low`; Web enabled, two actual completed normalized Web calls; V2 only changes its requested heading |

The elapsed times start at the phone qualification runner and include multiple
revisions, Guardians, the remaining account-inspection wait and reading published
files. Build/install and preceding runtime preparation are excluded; these are
not single-inference or ASR latency numbers.
Evidence: `results/2026-11-01-phone-core-synthetic.json` and
`results/2026-11-01-phone-core-nist.json`. SQLite was read back independently;
both cases have zero pending journal writes. Each complete case used one phone
App process, without Mac role dispatch, acceptance or publication.

Two real phone integration defects were fixed: canonicalize the iOS container
path before entering the unchanged journal, and move large native provider
futures off Swift's cooperative stack onto owned Tokio workers (8 MiB stacks,
heap-boxed inner futures). Native auth refresh events are pumped independently
of JS polling, including during startup RPCs.

Known scope: Perl is absent from the fixed rootfs; the NIST actor recovered from
two failed Perl commands using existing tools and published successfully. Full
desktop tool-package parity is not claimed. Background/lock recovery, full
failure matrices, integration with ASR/Alma Preview, and release hardening remain
separate work. The native V8 feature remains opt-in, with no desktop memory-sandbox
parity claim. The app target retains the existing Swift 5.9 language mode because
generated UniFFI callbacks need a separate Swift 6 migration; the trusted JSCore,
original journal and presentation core pass isolated strict Swift 6 checks.

## Keyboard layout follow-up (2026-11-01, build 4)

Tracked in [`results/2026-11-01-keyboard-layout.json`](results/2026-11-01-keyboard-layout.json): first-focus obstruction, the Paper-theme dark band, and the redundant WebView form accessory bar. The frontend uses visual-viewport geometry, a floating rounded composer with reserved scroll space, and a compact dismissal button. Tauri's supported accessory callback removes the default bar; the native WKWebView background follows the selected theme. The frosted surface is CSS, not native Apple Liquid Glass.

Frontend 58 checks, production build, native check/library and signed Xcode build pass. On the connected iPhone 12 Pro (iOS 27.0.1), first focus, dismissal/reopen, Chinese nine-key/English QWERTY switching and typing/deleting a test character kept the composer visible, without the dark band or accessory bar. Test text was cleared without sending. The original journal events/chunks remain byte-identical: 8 publications, 0 pending, integrity OK. Other OS/IME combinations remain separate verification.

## Chat / Working Events acceptance (2026-11-01)

Build 0.2.0 (5) implements the chosen double bubbles with a persisted Lightweight setting, explicit native roles and revision metadata, live recent-three public event projection, completed direct full logs, and common swipe-down sheets. Original `AppActions.workingText` supplies hash-pinned multi-chunk logs through a thin native reader; no competing TAH workflow or provider path was introduced.

- [Phone chat acceptance](results/2026-11-01-chat-ui-acceptance.json): data preservation, physical UI checks, synthetic v3 completion and remaining visual live-preview limitation.
- [Original core working-log replay](results/2026-11-01-working-core-replay.json): three revisions, multi-chunk UTF-8 logs, wrong-hash rejection, historical stability and private Guardian filtering; no model calls.
- [Native log reader checks](../../apps/ios/Sources/AlmaTAH/Presentation/working-log-checks-result.json): 26 checks, including synchronous first-open admission and operation-bound refresh/close.
- [Frontend integration notes](../../docs/ios/frontend-integration-notes.md): reusable behavior, source locations and integration regression checklist.

## Main-thread responsiveness follow-up (2026-11-02)

This change moves trusted JavaScript execution and bulk JSON work away from the
UI actor and coalesces redundant presentation reads. The business boundary remains
`TAHFramework -> ProviderAdapter -> ProviderBackend`: prompts, Raw/Extra Guardian
ordering, consent, expiry/provider checks, critic, acceptance, publication and the
original SQLite journal contract are unchanged. Model-generated Code Mode still
runs in the separate native V8 engine; it never enters the trusted JSCore VM.

**Installed and live-tested on iPhone 12 Pro / iOS 27.0.1.** A separate full
NVIDIA v0 action (GPT-6-Astra, xhigh, zh-CN, Web on) completed and published both
required files; the UI displayed 13m3s. This is not a claim of model-inference
speedup. Three separate 30-second continuous-animation captures produced 90
samples at **58–60 FPS, median 59**, compared with the earlier 33 samples at
2–7 FPS, median 5. These are Core Animation display readings, not a whole-task
per-element frame trace.

Full-log load and navigation to earlier/middle events were observed. The first
scroll capture missed the gesture interval and is excluded; a later synchronized
capture mixed scrolling with sheet dismissal/main-page gestures, so it is not
reported as pure log-scroll FPS. Finger-scroll feel still warrants user feedback.
The temporary `noWindowsAvailable` input failure resolved when the user brought
Device Hub back to the foreground. All diagnostic processes exited. See the
[optimization record](results/2026-11-02-ui-thread-optimization.json) for final
source hashes, installed image UUID, samples and evidence limits.

### Execution, snapshots and lifecycle

- [`AlmaTAHJavaScriptHost.swift`](../../apps/ios/Sources/AlmaTAH/Runtime/AlmaTAHJavaScriptHost.swift)
  is an actor backed by a retained custom `SerialExecutor` and the serial Dispatch
  queue `com.alma.tah.javascript` (`userInitiated`, per-work-item autorelease).
  Initialization, evaluation, JS values, replies and timer callbacks stay on that
  executor, away from MainActor and Swift's cooperative executor. Serial queue
  ownership does not promise one fixed OS thread. Synchronous native callbacks
  use `assumeIsolated`; the executor's queue precondition checks that assumption.
  Apple's [JSVirtualMachine threading documentation](https://developer.apple.com/documentation/javascriptcore/jsvirtualmachine)
  describes serialization within one VM. [Swift SE-0392](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0392-custom-actor-executors.md)
  describes custom actor executors and their lifetime requirements.
- The platform boundary carries **immutable JSON `String` snapshots**, not
  `JSContext`, `JSValue` or mutable `[String: Any]` objects. The platform callback
  still enters MainActor for native routing/UI ownership; it is not a claim that
  every platform operation runs in the background.
  [`TAHJournalRPC.handleJSONRPC`](../../apps/ios/Sources/AlmaTAH/Persistence/TAHJournalRPC.swift)
  decodes and encodes store envelopes on the journal actor around the existing
  validated RPC methods. Controller response decoding transfers `Decodable &
  Sendable` values back to MainActor and checks cancellation before and after
  decoding. Its synchronous decoder remains available for local callers.
- [`TAHWebPresentationBridge.snapshot()`](../../apps/ios/Sources/AlmaTAH/Runtime/TAHWebPresentationBridge.swift)
  captures `presentation` and `draft` together on MainActor, then constructs and
  encodes the JSON payload off it. Text, roles, revision metadata and explicit
  JSON nulls are retained. Working-log SHA verification and payload decoding also
  leave MainActor; operation identity, public-event filtering and historical hash
  pinning remain enforced. Async decoding/encoding helpers use `@concurrent` on
  compilers 6.2+ where declared. The generated Tauri target remains Swift 5.9
  language mode, strict concurrency `complete`, default isolation `nonisolated`,
  and approachable concurrency `NO`; this is not a full Swift 6 migration.
- [`TAHMobileController.swift`](../../apps/ios/Sources/AlmaTAH/Runtime/TAHMobileController.swift)
  parses each immutable Raw expiry once using value-type ISO-8601 strategies,
  then compares the cached instant with the current clock on every permission
  check. It does not cache an allow decision; exact expiry, invalid dates and a
  different provider still deny. UI callbacks acknowledge before any JS read.
  `refreshPending`, one `refreshTask` and command admission serialize snapshot
  reads: a burst is coalesced, a command's final read consumes earlier requests,
  and requests arriving during an awaited read retain one latest-state follow-up.
  Admission and completion still publish their UI state immediately.
- **The earlier polling fix is superseded by event-driven presentation.** React
  [`UIController.start()`](../../apps/ios/tah-ui/src/controller.ts) subscribes to
  native `tah:changed` before its first snapshot. It coalesces invalidations and
  serializes reads with commands; healthy unchanged state has no periodic reads.
  Native ordinary progress applies the Core notification directly. Phase/terminal
  changes, committed storage, Raw invalidations and explicit/lifecycle refresh
  reconcile the canonical snapshot. Generation checks reject old callbacks and
  replies. Logs follow a changed hash; no additional sheet refresh timer exists.
  A one-shot Raw expiry timer and bounded transport-failure retries are distinct
  from normal state polling. See the event-driven follow-up below.
- Cancellation is owned explicitly: a cancelled host invocation removes/resumes
  its continuation; cancelled timers do not fire. Host shutdown stops admission,
  cancels tracked timers/platform operations, resolves pending calls and clears
  the context. A platform task checks cancellation before entering its callback
  on MainActor, and late results cannot re-enter a stopped VM. Controller shutdown
  cancels expiry and queued refresh, closes the log reader, attempts checkpoint
  and `runtime.shutdown`, awaits host shutdown, then closes the journal. Bounds
  remain 32 host calls, 64 platform operations, 256 timers and 16 MiB per platform
  request. Cancelling an invocation releases its Swift waiter; it does **not**
  preempt synchronous JS or automatically roll back its business operation.
  Shutdown also has to wait for an executing synchronous JS job to yield.

The implementation follows Apple's [responsiveness guidance](https://developer.apple.com/documentation/xcode/improving-app-responsiveness):
keep non-UI work off the main thread and assess hangs/hitches on a real device.
Adding `async` or a MainActor `Task` alone does not move synchronous work off it.

### Existing check/build records and their limits

The following are local `.cache` records. Final native checks were rerun after
the last implementation changes; their identities are recorded in the optimization
record. Cache files may be regenerated and are not durable release evidence.

| Record under `tools/mobile-tah/.cache/` | Recorded result and scope |
| --- | --- |
| `jscore-worker-checks.json` | 9 checks passed: UTF-8/platform callback, timers, rejection, exact output, heartbeat, cancellation capacity and shutdown. Maximum MainActor heartbeat gap was 12.571792 ms during a synthetic 240 ms JS job on the Mac host. This is not phone FPS or a frame-time benchmark. |
| `ui-perf-current-pressure.log` | 40 checks passed in each of three compiler configurations; iOS 18 typecheck passed, with 0 provider calls and 0 device operations. Covers expiry boundaries, 500-request bursts, command/read races, failure recovery, shutdown and exact off-main decoding of 20,000 Unicode rows. |
| `ui-perf-current-controller-smoke.log` | 19 checks passed against the original core/native journal, with 0 provider calls; host and iOS simulator compilation recorded no diagnostics. No simulator or phone launch. |
| `ui-perf-current-working.log` | 26 working-log checks passed; host and simulator compilation recorded no diagnostics. |
| `ui-perf-current-core-replay.log` | Model-free replay passed: 3 published revisions, 6 checked output files and 3 verified multi-chunk working logs. |
| `ui-perf-rust-check.log`, `ui-perf-rust-build.log`, `ui-perf-final-rust-build.log` | Native check/build exit code 0. Existing Rust warnings remain; these are not warning-free builds. |
| `ui-perf-prepare.log`, `ui-perf-final-prepare.log`, `ui-perf-xcode.log`, `ui-perf-final-xcode.log` | Project generation and both Release device-target builds succeeded. Xcode warnings remain. |
| `ui-perf-install.log` | Records installation success only; it establishes neither responsiveness nor workflow acceptance. |

Final controller and host source hashes match the rerun records; the worker
result is paired with `ui-perf-final-source-hashes.json`. Installation preserved
all 61 pre-existing journal event rows byte-for-byte. After the new task, the
journal contains 66 events and 11 publications (previously 10); SQLite integrity
is `ok`. The 59,462-byte notes and 5,550-byte ASR index match their saved SHA-256
hashes. No uninstall or credential reset was performed.

### Model-free checks and build reproduction

Use the prepared dependencies and source/configuration setup described in
**Tauri build and reproduction** above. Run from the ALMA-litter repository root
with the selected full Xcode toolchain. These are reproduction commands, not
commands executed by this documentation pass. The checks below run local host
fixtures and compilation only; they do not launch a simulator/phone or call a
model. Keep source edits stable while capturing a final run.

```sh
(
  set -eu
  tah_perf_dir=$(mktemp -d "${TMPDIR:-/tmp}/alma-ui-perf.XXXXXX")
  xcrun swiftc --version
  shasum -a 256 \
    apps/ios/Sources/AlmaTAH/Runtime/AlmaTAHJavaScriptHost.swift \
    apps/ios/Sources/AlmaTAH/Runtime/TAHJavaScriptBytePrimitives.swift \
    apps/ios/Sources/AlmaTAH/Runtime/TAHMobileController.swift \
    apps/ios/Sources/AlmaTAH/Runtime/TAHWebPresentationBridge.swift \
    apps/ios/Sources/AlmaTAH/Persistence/TAHJournalRPC.swift \
    tools/mobile-tah/jscore_worker_checks.swift > "$tah_perf_dir/source-sha256.txt"

  xcrun swiftc -swift-version 6 -strict-concurrency=complete \
    -warnings-as-errors -parse-as-library \
    -module-cache-path "$tah_perf_dir/module-cache" \
    apps/ios/Sources/AlmaTAH/Runtime/AlmaTAHJavaScriptHost.swift \
    apps/ios/Sources/AlmaTAH/Runtime/TAHJavaScriptBytePrimitives.swift \
    tools/mobile-tah/jscore_worker_checks.swift \
    -framework JavaScriptCore -o "$tah_perf_dir/jscore-worker-checks"
  "$tah_perf_dir/jscore-worker-checks" > "$tah_perf_dir/jscore-worker-checks.json"

  python3 apps/ios/Sources/AlmaTAH/Runtime/controller-pressure-checks.py \
    > "$tah_perf_dir/controller-pressure-checks.log" 2>&1
  python3 tools/mobile-tah/run_core_replay.py \
    > "$tah_perf_dir/core-replay.log" 2>&1
  python3 apps/ios/Sources/AlmaTAH/Presentation/controller-smoke.py \
    > "$tah_perf_dir/controller-smoke.log" 2>&1
  python3 apps/ios/Sources/AlmaTAH/Presentation/working-log-checks.py \
    > "$tah_perf_dir/working-log-checks.log" 2>&1
  echo "Check records: $tah_perf_dir"
)

npm test --prefix apps/ios/tah-ui
npm run build --prefix apps/ios/tah-ui
```

`controller-pressure-checks.py` snapshots only the controller and extracts the
production methods into deterministic seams in a fresh temporary directory. It
checks Swift 5 and Swift 6 with complete concurrency checking/warnings as errors,
adds `NonisolatedNonsendingByDefault` on compilers 6.2+, and typechecks for iOS 18.
It does not exercise the actual provider or JS host. The separate worker check
uses the production JS host with test-owned JavaScript.

These reproduction scripts have file outputs: `run_core_replay.py` rebuilds the
owned JS bundle and writes `.cache/latest-core-replay.json`; the controller and
working-log scripts also overwrite their adjacent `*-result.json` reports.
`controller-smoke.py` currently requires the read-only prompt directory
`/Users/dashidhy/Public/projects/agent/ALMA/app/TAH/prompts`. That hard-coded test
dependency is separate from the portable replay and shipping bundle; it must
exist for this command to work. Coordinate runs that write shared generated
inputs/reports with Main even when independent checks are allowed in parallel.

After frontend assets are built, use the existing single-archive packaging lane
in this order; binding extraction must follow the completed native build:

```sh
python3 tools/mobile-tah/build_tauri.py --check
python3 tools/mobile-tah/build_tauri.py
python3 tools/alma-ios-lab/prepare_bindings.py \
  --library shared/rust-bridge/target/aarch64-apple-ios/ios-dev/libalma_tah_ui_lib.a \
  --output-dir shared/rust-bridge/generated/swift-tauri \
  --report tools/mobile-tah/.cache/tauri-bindings.json
python3 tools/mobile-tah/prepare_tauri_app.py
xcodebuild \
  -project tools/mobile-tah/.cache/tauri-app/AlmaTAHTauri.xcodeproj \
  -scheme AlmaTAHTauri -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath tools/mobile-tah/.cache/TauriDerivedData \
  -jobs 2 -allowProvisioningUpdates build
```

This builds the device product; it does not install or launch it. Preserve the
existing signing identity/container and follow the earlier in-place update
instructions when Main proceeds with phone verification.

### Physical-device measurement owned by Main

For Main's separate measurement, with the intended app already foregrounded and
the prepared `pymobiledevice3` environment available:

```sh
python3 tools/mobile-tah/profile_ui.py \
  --label ui-perf-after-scroll --seconds 30 --udid '<device-udid>'
```

[`profile_ui.py`](profile_ui.py) accepts 5–60 seconds and a simple label containing
letters/digits, hyphens or underscores. It observes Core Animation display FPS
using `developer dvt fps --userspace`; it does not launch/stop the app, generate
scroll gestures or run a model. It writes `.cache/<label>-fps.jsonl`,
`<label>-fps.err` and `<label>-metrics.json`, including sample count and
min/max/median/mean. Use distinct labels for baseline/after and idle/scroll/live
workloads. Zero samples (`fps: null`) or collector errors are not a successful
performance measurement.

Record the actual app/build and source hashes, device/iOS, foreground screen,
content size, gesture/workload, run duration and thermal conditions. Compare the
same scenario and repeat it; idle display FPS is not a scrolling benchmark.
The collector does not filter to an app PID, measure CPU use or identify a main
thread bottleneck. Use app-scoped Instruments Time Profiler and Animation Hitches
traces to assess those questions. **Do not interpret stack-frame occurrence or
stack-sample counts as CPU percentages**: nested/inclusive frames can overlap,
and a count without thread, sampling interval, time weighting and total-duration
context is not CPU utilization. Keep stack observations, CPU time, heartbeat gaps
and display FPS as separate evidence. Main's final device report remains pending.

## Actor energy investigation (2026-11-02)

Moving JSCore off MainActor restored UI responsiveness but did not remove its
total computation. An unplugged iPhone 12 Pro with Device Hub sharing stopped
reported 35.5%/hour system power during Actor, versus 8.8–9.7%/hour after completion.
These are approximately one-minute **whole-device Power Profiler indicators**,
not actual one-hour battery-drain tests or application-only energy. Brightness
was 51%; baseline idle was Nominal and the Actor sample was Fair. Mirror-on idle
was 11.4%/hour. See [baseline evidence](results/2026-11-02-tah-power-baseline.json).

A separate Time Profiler run attributed 70.05% of sampled application CPU to
the JSCore host workers, 25.92% to JSC heap helpers/collection, 3.04% to Node
threads and 0.75% to the main thread. Keep this attribution trace separate from
power-only measurements: extra profiling changes the workload.

The original browser Buffer polyfill processed bytes in interpreted JavaScript.
Public JSCore typed-array APIs, Foundation and CryptoKit now accelerate normal
UTF-8, canonical base64 and SHA-256, including bulk zeroing. Uncommon overloads,
malformed encodings, oversized data and unsupported buffer types retain their
original behavior through fallback. Integrity checks and byte zeroing remain.
The native helpers stay on the existing JSCore actor and add no JIT/private API.

The first installed byte-only iteration reduced host no-JIT `action.list` median
882→144 ms with identical replies and journal traffic, but its phone power sample
was still 27.9%/hour at **Serious** thermal pressure. It is not accepted; the
different thermal conditions also prevent treating 35.5→27.9 as a controlled
improvement percentage. That test task was stopped to cool the phone. Detailed
source/build identities are in [first-iteration evidence](results/2026-11-02-native-byte-optimization.json).

The second iteration also reuses the display-only action list and loaded
conversation during a stable running operation. Auth, Raw status and the live
Action snapshot still refresh. Store writes (including failed ACKs), identity,
phase/publication/reedit changes and explicit Refresh invalidate the baseline.
Full reads replace Core's visible history over the previously loaded depth;
they do not union hidden revisions back in. This is an iOS presentation
optimization, not a new permission/business-state cache. Direct database edits
that bypass the observed Controller store entry point are outside this guarantee.

The second device package (UUID `EAF45329-7F22-366D-B949-85A1B6FF83D8`) completed
the full NVIDIA v0 task, GPT-6-Astra/xhigh/zh-CN/Web enabled, in 657.72 seconds.
The Rule Critic passed, both output files and the full working log passed length
and SHA-256 checks, and all 85 pre-install events remained byte-identical.
Publication count increased 15→16. Duration is not a model-speed claim: cloud
generation and tool choices vary between runs.

| Power-only window, sharing off and unplugged | System power | Thermal | Brightness |
| --- | ---: | --- | ---: |
| Earlier Actor baseline, run 4 | 35.5%/hr | Fair | 51% |
| Second iteration, early Actor, run 7 | 12.8%/hr | Nominal | 51% |
| Second iteration, late Actor, run 8 | 12.1%/hr | Nominal | 51% |

Run 7 has 60 seconds of power observations; run 8 has about 74 seconds and
includes roughly one second after completion. These repeated observations
support a substantial improvement, but differing backend work and baseline
thermal conditions do not support an exact controlled reduction percentage.
They also do not establish actual one-hour drain, app-only energy or every future
workload. Phone UI showed completion and both artifact links; sharing and the
measurement document were then closed. Evidence, source hashes and 91 Controller
checks in three compiler configurations: [second-iteration result](results/2026-11-02-display-read-optimization.json).

### Model-free byte and read-cost checks

```sh
node tools/mobile-tah/build_bundle.mjs
xcrun swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors \
  -O -parse-as-library \
  apps/ios/Sources/AlmaTAH/Runtime/AlmaTAHJavaScriptHost.swift \
  apps/ios/Sources/AlmaTAH/Runtime/TAHJavaScriptBytePrimitives.swift \
  tools/mobile-tah/jscore_codec_integration.swift \
  -framework JavaScriptCore -o tools/mobile-tah/.cache/jscore-codec-integration
JSC_useJIT=false tools/mobile-tah/.cache/jscore-codec-integration \
  shared/tah-runtime/generated/alma-tah.js
JSC_useJIT=false python3 tools/mobile-tah/run_jscore_rpc_bench.py \
  --database /absolute/path/to/copied/tah.sqlite3 --native-bytes both --no-instrument
```

The RPC benchmark copies the database before opening it, uses synthetic auth,
and rejects unexpected platform calls. It does not send transcript text to a
provider. Results include fingerprints, traffic, source hashes and the effective
JIT state. A host speedup is not a measured phone power improvement. Instrumented
function totals have gaps (including deferred GC); they are not exhaustive CPU
attribution. A separate bounded test found Zod schema factories/clones accounted
for only about 5.5 ms, so no speculative business-core schema rewrite was made.

For the next phone comparison: close screen sharing, keep the app foregrounded,
confirm unplugged state and comparable starting thermal conditions, record only
Power Profiler, then separately profile CPU if attribution is needed. Preserve
the existing app container and compare prior journal events byte-for-byte after
installation. Do not use native/RSD tunnel takeover to work around diagnostics;
it can disrupt Apple's device connection.

Saved Power Profiler XML can be summarized without accessing a device:

```sh
xcrun xctrace export --input /path/to/saved.trace --toc --output /path/to/exports/toc.xml
# Repeat for each selected run and each schema: SystemPowerLevel,
# SystemThermalState, DeviceChargingState. Use a saved copy if the GUI is open.
xcrun xctrace export --input /path/to/saved.trace \
  --xpath '/trace-toc/run[@number="7"]/data/table[@schema="SystemPowerLevel"]' \
  --output /path/to/exports/power-run7-SystemPowerLevel.xml
python3 tools/mobile-tah/summarize_power_exports.py \
  --toc /path/to/exports/toc.xml --data-dir /path/to/exports --runs 7 8
```

The summary weights power by the recorded interval duration, resolves xctrace
references, reports observed coverage and refuses missing samples. An empty
charger table must be corroborated with unplug confirmation/UI; absence alone
is not proof. The script does not extrapolate task energy from rounded status-bar
battery percentages.

## Event-driven refresh follow-up (2026-11-02)

The user identified the remaining unnecessary work: even a cheaper native
snapshot should not run every 750ms while the provider has nothing new to report.
Normal Core progress now updates the native display from `ui.actionChanged`;
native Observation emits an empty Tauri `tah:changed` invalidation and React reads
the presentation only on changes. Both healthy-state polling loops are removed.
Animations and local elapsed-time labels are unaffected.

Phase/operation/terminal boundaries still reconcile editor/publication authority.
Raw start, completion and pending-save changes have their own invalidation
notification, emitted after the existing Core state-change callbacks. This fixes
the important gap where the last store ACK occurs **before** Raw clears its
active operation. An optional hash-checked bundle adaptation records its exact
source replacements in `generated/bundle-manifest.json`; the owned upstream
snapshot and source lock stay unchanged. Observer exceptions cannot break the
workflow, and a failed notification channel becomes visibly unavailable.

Other fixes include reusing the Raw status already included in action.snapshot,
not refreshing history after every successful upload chunk, stale-progress/read
ordering, same-value presentation assignments, and coalesced encoding of identical
immutable display snapshots. Real Raw expiry uses a one-shot deadline; app
activation and significant clock changes trigger a single reconciliation.

Mac was audited **read-only**, with no Mac App build/test/launch or source edits.
Findings, proposed fixes, invariants and handoff are in the
[cross-platform integration notes](../../docs/ios/frontend-integration-notes.md#事件驱动更新与跨端审查2026-11-02).
This round is plugged-in functional validation, **not a power measurement**.

Model-free reproduction (from the repository root):

```sh
node tools/mobile-tah/build_bundle.mjs
python3 apps/ios/Sources/AlmaTAH/Runtime/controller-pressure-checks.py
python3 apps/ios/Sources/AlmaTAH/Runtime/bridge-snapshot-checks.py
python3 tools/mobile-tah/native-host-event-checks.py
python3 tools/mobile-tah/raw_notification_checks.py --bundle shared/tah-runtime/generated/alma-tah.js
python3 tools/mobile-tah/run_core_replay.py
python3 apps/ios/Sources/AlmaTAH/Presentation/working-log-checks.py
python3 apps/ios/Sources/AlmaTAH/Presentation/controller-smoke.py
npm test --prefix apps/ios/tah-ui
npm run build --prefix apps/ios/tah-ui
```

Controller checks use independent canonical-response fixtures and real production
method bodies: 500 ordinary events must produce zero additional Core reads, while
phase changes, Raw finally, uncertain writes, expiry and old RPC replies remain
correct. Raw checks run the actual bundled Core with synthetic provider results,
not a second implementation of its lifecycle. The snapshot checks cover repeated
and concurrent requests plus A→B→A encoding races. The iOS package must also be
fully linked, because the event transport adds a Swift C callback to the combined
Rust archive; a frontend build or isolated Swift typecheck alone is insufficient.

Build identities and validation: [event-driven result](results/2026-11-02-event-driven-refresh.json).

## Live working-log version alignment (2026-11-02)

Progress notifications advertise a digest but do not pin that log version. The
iOS reader now reads the digest returned by its same-operation `action.snapshot`,
which pins the corresponding immutable log, and records the **effective** loaded
digest. Pending notifications for already loaded content do not re-fetch chunks.
Historical position/digest pairs remain fixed.

A source read failure can retry once only when a fresh same-operation snapshot
has a different digest. Corrupt bytes, bounds, SHA or schema errors are not
treated as version changes. The reader retains verified events during updates,
keeps before/after operation checks and never introduces periodic polling.

```sh
python3 apps/ios/Sources/AlmaTAH/Presentation/working-log-checks.py
python3 apps/ios/Sources/AlmaTAH/Presentation/working-log-version-checks.py
```

The version regression checks observe intermediate UI states and read counts,
not just the final successful state. See the
[cause and invariants](../../docs/ios/frontend-integration-notes.md#运行中-full-working-events-短暂红字2026-11-02)
and [validation record](results/2026-11-02-working-log-version-fix.json).

## Memory deltas through the official Tauri Channel (2026-11-02)

Running Working Events now use a scoped in-memory read session instead of
repeated whole-log hash/chunk reads. The first frame resets the view; subsequent
frames contain event-ID upserts, removals, ordering and metadata. Source-locked
Core files stay unchanged: `runtime_notifications.mjs` records reviewed build
adaptations for the memory accessor. The Framework/Adapter/Backend contract and
publication/durability decisions are unchanged.

Swift holds one unacknowledged frame and one latest display value. Rust copies
the borrowed C callback bytes into a capacity-one queue and parses/sends on a
background worker via `tauri::ipc::Channel`. The Web consumer applies a frame,
yields one animation frame, then acknowledges its subscription and sequence.
Only this consumer ACK releases the next live read. Ordinary UI snapshots omit
the log body while the channel is active. No healthy idle polling is added.

Historical/completed reads retain the existing SHA/chunk validation. The existing
512-event/2 MiB-text/4 MiB-log retention remains, with an 8 MiB transport envelope
limit. This is not unbounded historical storage or virtual-list pagination.

```sh
python3 tools/mobile-tah/working_stream_checks.py
python3 apps/ios/Sources/AlmaTAH/Presentation/working-channel-checks.py
python3 apps/ios/Sources/AlmaTAH/Presentation/working-log-checks.py
python3 apps/ios/Sources/AlmaTAH/Runtime/controller-pressure-checks.py
python3 apps/ios/Sources/AlmaTAH/Runtime/bridge-snapshot-checks.py
python3 tools/mobile-tah/native-host-event-checks.py
python3 tools/mobile-tah/run_core_replay.py
npm test --prefix apps/ios/tah-ui
npm run build --prefix apps/ios/tah-ui
```

Stress checks withhold consumer ACK while 10,000 changes arrive, verify bounded
state and exact next-frame deltas, reject stale scopes/sequences and preserve
terminal status. Build the single Tauri+Codex archive after the frontend build,
then regenerate bindings/project and perform the full device link; isolated
Swift checks cannot validate the C callback ABI or embedded web assets.

Validation and current device acceptance status:
[2026-11-02 Channel result](results/2026-11-02-working-channel.json).

## Foreground qualification lifecycle classification

The optional phone-owned qualification driver requires an active app. An inactive
app with readable protected data (for example, Control Center) reports
`needs_foreground`, not `needs_user_unlocked`. Reports include the observed app
state and protected-data availability. A stopped observer does not cancel, retry,
or prove the outcome of the underlying Core task. This driver is not a background
execution qualification harness.

Run its platform-independent regression without installing or linking an app:

```sh
python3 tools/mobile-tah/qualification_lifecycle_checks.py
```

The classification change is source-only after 0.4.1 (14); that retained device
candidate and its original reports are unchanged. See the
[2026-11-07 phone qualification](../../docs/ios/2026-11-07-phone-requalification.md).
