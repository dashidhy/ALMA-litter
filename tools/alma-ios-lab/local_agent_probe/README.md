# Standalone local-agent phone qualification UI

This is a minimal native SwiftUI host, not the full Litter application. All
authored files are confined to this directory. Production OAuth, logger, Rust,
generated bindings, manifests, and device state are not modified.

Initial qualification uses **synthetic tool fixtures only** in the fixed test
workspace. The screen labels that scope and `/workspace/output` explicitly.
Main's host-authorized realfs workspace extension (`patches/ish-native-workspace`)
owns the native/guest views. There is no arbitrary mount UI and no real recording,
TAH, revision, or publication workflow in this probe. The user must personally
complete sign-in after main installs a ready build.

- Bundle: **com.alma.litter.agent-probe**.
- Development team: **C6635V7W82**.
- iOS 18 minimum; Swift 5 mode / targeted concurrency, explicit MainActor UI.
- No network, login, credential load, model request, runtime bootstrap, or Rust
  client construction runs at app launch. There is no `onAppear`/`.task` startup
  flow, reconnect loop, or automatic task polling.

The UI presents explicit preparation, sign-in, account/model checks, session
creation, one fixed dummy task, manual status, and interrupt buttons. It never
renders message bodies, account IDs/emails, token bundles, or arbitrary errors.
There are no free-form prompts, raw protocol JSON, transcript logs, or copied
desktop authentication files. Status is bounded; a submitted request or an idle
thread is not labelled a completed/passing model test.

## Current readiness and evidence

The **shell** XcodeGen project was generated and the complete shell UI plus the
unchanged production `ChatGPTOAuth.swift` and `LLog.swift` **type-checked against
the actual iOS 27.2 SDK**, targeting arm64 iOS 18, with warnings treated as errors.
A host test compiles the actual `ProbeModel`/disabled bootstrap and confirms that
all eight live actions leave readiness/submission state unchanged when unready.
No generated API types or methods are stubbed in either check.

The production generated Swift was not present at either standard path when
checked. Consequently the bound client/session/bootstrap code and production
refresh-provider conformance have **not yet been type-checked against production
bindings or linked**. The bound source calls are grounded in the actual Rust
exports and existing production Swift call sites, documented below. Shell mode
excludes those code paths instead of fabricating AppClient/UniFFI substitutes.

Artifacts live under `.build/shell/`:

- `AlmaLocalAgentProbe.xcodeproj`: concrete review project.
- `compile-manifest.json`: exact source references/hashes, framework and binding
  input paths, readiness gates, and fixed workspace contract.
- `check-evidence.json`, `ios-typecheck.txt`, `gates-output.txt`: actual validation.

Only type-checking and the disabled host gate test were run. No app link, giant
Rust build, codegen invocation, signing, install, phone interaction, real login,
account RPC, or model task was performed.

## Production source reuse and authentication gate

The bound project references these **actual files directly**, without copies,
rewrites, alternate auth implementations, or logger replacements:

| Production source | Compile dependencies |
| --- | --- |
| `apps/ios/Sources/Litter/Models/ChatGPTOAuth.swift` | Foundation, AuthenticationServices, CryptoKit, Network, Security, UIKit; actual LLog |
| `apps/ios/Sources/Litter/Models/ChatGPTAuthRefreshProvider.swift` | Foundation; actual OAuth owner and generated `ChatgptAuthRefreshProvider`, request/tokens/error types |
| `apps/ios/Sources/Litter/Models/LLog.swift` | Foundation and the SDK's OSLog module |

Shell mode compiles OAuth and LLog, but excludes the refresh provider because its
real generated protocol is not available. The compile manifest explicitly records
`provider_included: false`; this is not callback-conformance evidence. Bound mode
includes all three production files and the real production generated Swift.

**The refreshed OAuth logging check now passes with zero findings.** Main removed
the previous five body/request-line/query/raw-error logging findings in production.
The probe references that updated source unchanged; it does not replace LLog or
rewrite authentication code. The readiness check remains enabled to catch a
regression before login. It scans the complete OAuth file, including helper flows
not invoked by this probe; it is not a general privacy proof. No bypass flag is
provided. Bindings and trusted bootstrap readiness remain independent gates.

`ChatGPTOAuth.login()` is called only by the explicit sign-in button after local
preparation/connection. Its returned bundle remains a local variable and is
passed directly to the actual `AppClient.loginAccount(.chatgptAuthTokens(...))`.
The real production store saves credentials in this application's default
Keychain access group. No shared Keychain entitlement or desktop credential
import is configured. `authStatus` requests `includeToken: false` and
`refreshToken: false`; token response fields are not read or displayed.

## Trusted bootstrap contract — main owns registration

`TrustedProbeBootstrap.prepare() async throws -> PreparedProbeEnvironment` is a
**probe-owned integration interface**, not a pretend generated Rust method.
By default its implementation is disabled and throws `bootstrapUnavailable`.

The optional `ProductionIshBootstrap` invokes the **existing actual export**:

```swift
try ishBootstrap(
    bundleFsPath: rootfs,
    applicationSupportDir: support,
    documentsDir: documents
)
```

Only main should enable this wrapper, after the policy vendor, ALMA-local archive,
and bundled `fs` are ready. The heavy synchronous FFI call is inside a nonisolated
async worker under the project's Swift 5/nonisolated-default settings. No Swift
mounting, scope registration, environment-policy recreation, or native fallback
is implemented. Main's Rust bootstrap must establish the following before it
returns successfully and before any AppClient object/local connection is made:

| Guest path | Authority/use |
| --- | --- |
| `/workspace/input` | Read-only input, matching native scoped view |
| `/workspace/output` | Read-write output, matching native scoped view |
| `/workspace/tmp` | Read-write temporary area, matching native scoped view |
| `/workspace/tmp/home` | Guest home |

`AppClient.startThread` always passes **`cwd: /workspace/output`** explicitly.
The UI cannot change roots, cwd, policies, or server parameters. Swift passes nil
approval/sandbox overrides so main's trusted Rust profile remains authoritative.
Main also owns private native CODEX_HOME configuration before client construction;
the probe does not invoke `LLog.bootstrap()` or import a desktop home/auth tree.

Native login is possible only after `ishBootstrap` succeeds and the real
`ServerBridge.connectLocalServer` returns a connected local typed snapshot.
The new Rust requirement for an already-registered `embedded_runtime` is relied
on; no failure path reconnects via a native/remote executor. A partial bootstrap
failure or `AlreadyBootstrapped` is not treated as readiness. Restart the probe
after main corrects preparation rather than assuming that an existing kernel is
fully registered.

## Actual exposed API mapping

`api_contract.json` records Rust definitions and generated symbol names. Main's
production Swift output must contain all of them before bound preparation succeeds.
The existing production Swift calls corroborate their spelling; full bound
type-checking is still required for exact generated signatures.

| Probe operation | Actual API / ownership |
| --- | --- |
| Bootstrap | `ishBootstrap`; Rust `src/lib.rs::ish_bootstrap` |
| Connect | `ServerBridge.connectLocalServer`; `ffi/server.rs::connect_local_server` (there is no invented `AppClient.connect`) |
| Refresh callback | `AppClient.setChatgptAuthRefreshProvider`, using unchanged production provider |
| Login | `AppClient.loginAccount` with `.chatgptAuthTokens` |
| Account | `AppClient.refreshAccount` + `authStatus`, typed `AppStore.snapshot` |
| Model list | `AppClient.refreshModels`, then typed `availableModels` from the store (no invented `listModels` response) |
| Session | `AppClient.startThread`, Codex runtime, ephemeral true, fixed cwd |
| Task | `AppStore.startTurn` with typed `AppStartTurnRequest` / `AppUserInput.text` |
| Status | `AppClient.readThread(includeTurns: false)` + `AppStore.threadSnapshot` |
| Interrupt | `AppClient.interruptTurn` with the actual active turn ID |

Source evidence: `ffi/client.rs`, `ffi/server.rs`, `ffi/app_store.rs`,
`types/server_requests.rs`, `store/boundary.rs`, and production Swift
`Models/AppModel.swift`, `AppRpcParams.swift`, `AppRuntimeController.swift`.
The refresh provider is installed before the local connection. AppStore remains
the state owner; Swift projects only typed status and counts and never decodes
upstream protocol JSON.

The fixed task asks for “ALMA local agent probe OK” without tools/files. It is
sent directly by the explicit Run button, once per created session. Ambiguous send
failure does not enable automatic retry. No response-body match or terminal-turn
success proof is claimed; manual status is intentionally limited to the real
typed thread state. Approval UI, retries/reconnect, transcript rendering, polling,
background execution, file-artifact verification, and full TAH are not included.

## Prepare, validate, and hand off

The checked-in `project.yml` is JSON-compatible YAML. `prepare.py` resolves its
sources into a per-mode XcodeGen spec, writes only this directory's `.build/`,
and records compile inputs. It never generates Rust bindings or builds Rust.

UI review and the disabled-gate validation:

```sh
python3 tools/alma-ios-lab/local_agent_probe/prepare.py --mode shell
python3 tools/alma-ios-lab/local_agent_probe/check.py --mode shell
```

Once main has actual production bindings and headers (paths may be overridden):

```sh
python3 tools/alma-ios-lab/local_agent_probe/prepare.py --mode bound \
  --bindings /absolute/path/to/codex_mobile_client.swift \
  --headers /absolute/path/to/generated-headers \
  --library /absolute/path/to/libcodex_mobile_client.a
python3 tools/alma-ios-lab/local_agent_probe/check.py --mode bound
```

The known actual UniFFI 0.31 generator is
`tools/alma-ios-lab/auth_refresh_regression/.build/rust/target/debug/auth-refresh-bindgen-evidence`.
Main owns invoking it for the production archive. **Do not use its small callback
fixture bindings in this app.** Default discovery checks the production
`apps/ios/Sources/Litter/Bridge/UniFFICodexClient.generated.swift` and
`shared/rust-bridge/generated/swift/codex_mobile_client.swift` paths.

When main confirms the Rust policy-ready bootstrap/rootfs, add
`--rootfs /absolute/path/to/fs --enable-bootstrap` to bound preparation/build.
The folder must actually be named `fs`, matching `Bundle.main` lookup. Do not
enable it merely because a rootfs directory exists. Then check the generated
manifest's auth-logging gate before user login.

An optional explicit app build consumes already-built artifacts:

```sh
bash tools/alma-ios-lab/local_agent_probe/build.sh bound \
  --bindings /absolute/path/to/codex_mobile_client.swift \
  --headers /absolute/path/to/generated-headers \
  --library /absolute/path/to/libcodex_mobile_client.a \
  --rootfs /absolute/path/to/fs --enable-bootstrap
```

That script uses two Xcode jobs and unsigned generic-iOS output. It does not call
Cargo, codegen, provisioning updates, install, or launch commands. Main owns
matching archive/header/binding ABI, any additional native link inputs required
by its archive, signing with C6635V7W82, installation, and the user's explicit
sign-in step. No full Litter root view, Ghostty UI bridge, WebRTC, pet, Watch,
Alleycat, or desktop credential source is added to the probe project.


### Bounded host phone runner (main-controlled qualification)

`phone.py` uses only the tested cached pymobiledevice3 fallback. Set
`PYMOBILEDEVICE3_UDID` or pass `--udid`; it never discovers/selects a phone
interactively. The default action is preparation only:

```sh
python3 tools/alma-ios-lab/local_agent_probe/phone.py --prepare-only
```

An explicit verification invocation starts exactly the app's existing fixed
synthetic subscription request using its already-signed-in account:

```sh
python3 tools/alma-ios-lab/local_agent_probe/phone.py --verify-subscription
```

Installation is separately opt-in and checks the built app's bundle identifier:

```sh
python3 tools/alma-ios-lab/local_agent_probe/phone.py \
  --install /absolute/path/to/AlmaLocalAgentProbe.app --verify-subscription
```

The fixed bundle is `com.alma.litter.agent-probe`. Command forms are:

- `apps install --udid UDID --developer --streaming APP` (only with `--install`).
- `developer core-device launch-application --userspace --kill-existing BUNDLE -- --prepare-only`, adding `--verify-subscription` only when explicitly selected.
- `apps pull --udid UDID BUNDLE Documents/preparation-status.json LOCAL` and, for verification, the exact `Documents/verification-status.json` path.

The launch receives `PYMOBILEDEVICE3_UDID` in its environment. Inherited native,
RSD/tunnel and userspace mode environment overrides are cleared before each
command; launch explicitly selects userspace. No `--native`, devicectl,
uninstall, console attachment, login, arbitrary prompt, upload command, or
unrelated-process kill is used. `--kill-existing` targets this fixed app only.
There is exactly one launch attempt per invocation and no command-failure retry.

Timeouts: install 180 seconds, launch 45, each pull 20, and the whole
qualification phase 180. The latter includes pre-launch stale-report baseline
pulls, launch, status polling and waits; installation has its own budget.
Only missing/stale status reports are polled, without relaunching. Locked,
RSD disconnection, unavailable device, timeout, unconfirmed launch PID and app
failure have distinct outcomes. An uncertain verification can still be running
on the device; inspect that existing run before explicitly starting another.

Each run writes a new `.build/phone-runs/<timestamp-id>/` directory, or the new
path supplied by `--output`. `run.json` records source hash, exact commands,
command timeouts/return codes, host UTC timestamps, launch PID and every observed
phase/status in order. Status PID must match the launch response, and an
unchanged pre-launch file cannot count as fresh. A later PID switch for an
already-current report stops collection. The app files overwrite earlier
phases, so transitions between pulls cannot be recovered; the history is an
observation history, not a fabricated complete event stream.

Accepted latest statuses are also saved as `preparation-status.json` and
`verification-status.json`. These are allowlisted metadata projections:
phase/PID, accountReady/modelCount, durations, replyMatches, terminalIdle and
counts. Raw CLI output and downloaded status files are not retained; arbitrary
error details, response text, tokens and other fields are discarded. No auth
file or token store is read. Preparation succeeds only at current-PID `ready`.
Verification succeeds only at current-PID `completed` with true replyMatches,
terminalIdle and accountReady, positive model/message counts, and preparation
ready. In particular, `completed` with `replyMatches: false` exits nonzero.

Source evidence: the installed CLI's `cli/apps.py` (`install`, `pull`) and
`cli/developer/core_device.py` (`core_device_launch_application`, JSON result
without console attachment), plus the app's current phase JSON writers.
Validation for this runner was static Python compilation and nine deterministic
mocked subprocess scenarios: prepare, verification success, reply mismatch,
Locked, RSD disconnect, command timeout, stale PID, whole-run deadline and
missing launch identity. All passed; no real phone command was executed during
runner development. Only local source inspection and CLI `--help` were used.
