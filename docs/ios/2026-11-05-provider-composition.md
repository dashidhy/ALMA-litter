# Provider composition and phone qualification

Current task, 2026-11-07: prepare and verify consolidated build 0.4.1 (14) on
Mac only. Phone installation and execution remain paused at the user's request.
The November 5 phone results below describe older artifacts; they do not qualify
the new ZCode long-task/proxy candidate. See the consolidated-candidate addendum
at the end of this document and the separate provider release assessment.

## Scope

The existing Alma TAH prototype consumes the release-owned Codex, Kimi and ZCode
implementations. ALMA main App sources remain read-only. All pre-existing local
changes are preserved. The starting status and diff are recorded in the ignored
`tools/mobile-tah/.cache/zcode-composition` directory.

## Historical short-task status (2026-11-05)

The phone is now available and installation/testing is authorized. The current
signed 0.4.0 (13) candidate uses the quota-corrected native archive and the final
ZCode relay runtime. `tools/mobile-tah/.cache/relay-app-verification.json` records
the exact artifact. Earlier build hashes and pending statements below are
historical composition controls, not the current acceptance status.

- Kimi 2.4.1: cached runtime passed the phone-owned synthetic Raw/V0/V1/V2 flow,
  six output readbacks and exact revision checks in 371.59 seconds. Evidence:
  `tools/mobile-tah/results/2026-11-05-kimi-cache-phone.json`.
- ZCode 3.17.2: official BigModel login restored through Keychain; real quota
  inspection satisfies the original AuthService admission. V0/V1/V2 completed
  on the phone. Canonical publication hashes and V2's exact retitle/unchanged ASR
  file passed. The final relay candidate's V3 also passed: 12 successful tools,
  explicit WebSearch/WebFetch, exact inverse retitle and unchanged ASR bytes.
  Its full revision took 304.829 seconds (Extra Guardian 60.150; Actor 244.419).
  Evidence: `tools/mobile-tah/results/2026-11-05-zcode-phone.json`.
- The automatic test driver's 300-second phase deadline expired during V1. It
  did not cancel the Core; V1 subsequently completed. Preserve that timeout
  report and distinguish the successful canonical publication from a successful
  automated run. V2/V3 use the normal UI path.
- No power, long-NVIDIA or background acceptance is implied by this short test.
  Model requests include networking/stream reading; provider timing is not an
  isolated SDK import measurement.

The diagnostic model-request activity is not retained by the Core's final
working-log projection. Tool spans are available, but no phone request-total or
isolated import figure was available from that functional run. The subsequent
separate load-profile lane records mean validation/import totals of 17.382 s for
Kimi and 27.183 s for ZCode (two fresh Raw tasks each). See
`tools/mobile-tah/results/2026-11-05-provider-load-phone.json`. These do not include
model requests and do not prove a phone no-cache speedup. Model timing would also
need a separate diagnostic sink rather than changing user-facing event semantics. V3's Edit took
5.392 s, including measured file read/write/match of 27/38/1 ms; these partial
spans do not establish the cause of the remaining time.

The quota implementation keeps the native credential owner and Adapter/Core
boundary: only the native owner resolves the PAT and requests the fixed official
quota endpoint; the Adapter projects its returned quota. No fake balance or
Core policy bypass was added. The runtime relay projects only transport copies
before stdio serialization, keeping the official SDK's internal stream intact.

For typing/login handoff, stop Device Hub Screen Sharing and verify View Screen.
Capture Keyboard off is insufficient. Agent-driven tests may resume sharing
after the user has finished.

## Required behavior

The NVIDIA long-phone lane uses the user's existing 254 saved transcript turns
(00:00:05–02:05:24, UTF-8 SHA-256
`abf7e3a1207902db21d70cdcf1f74704d2b7c1668b59a67df8804c0d80dda0f7`).
The raw fixture stays in ignored build storage, not committed source. Both
providers run the same zh-CN/Web-enabled V0, V1 (append five source-grounded key
points), V2 (exact retitle of that section). The phone owns all Core operations.
The explicit `--mobile-tah-long-qualification` flag selects this fixture and a
45-minute observer deadline per phase; provider/backend execution limits remain
unchanged. A 30-second initial wait lets Power Profiler attach before task work.
The task report records wall-clock origin, provider and actual model settings.
Functional acceptance requires all three publications, immutable prior revisions,
exact V2 change and ASR preservation. V0 alone is partial. Energy is a separate
acceptance: the user explicitly prioritized completing both providers' functional
tests after Instruments finalization blocked the first power export. Use
`supervise_long_phone.py --no-power` for that path; native battery/thermal samples
are retained but do not establish instrument-based power rates.

The optional load-profile build is a measurement overlay, not a shipping runtime.
It copies verified provider resources, adds only numeric cache/import measurements
to the guest terminal, and hashes the resulting copy. Official SDK/cache bytes
are unchanged. A build-marked Swift collector removes that private terminal field
before forwarding to the strict Adapter, including the duplicate close receipt.
With the explicit profiling launch flag it writes a bounded, content-free report
on its own actor. No prompts, responses, account IDs or credentials are stored.
The Core and its public event/terminal contract are unchanged. A two-Raw-task
synthetic lane exercises fresh task processes in one App process. Restore the
qualified non-profile App after measurement. Do not report these measurements as
energy or long-task acceptance.

```text
guest load timers → terminal measurement field → Swift profile collector
                                                   ├─ bounded diagnostic file
                                                   └─ original terminal → Adapter → Core
```

- The trusted Core loads on entry to TAH. Provider adapter modules load when their
  provider is first selected or used. One shared Core module graph owns all types.
- Native preparation coalesces per-provider requests. Kimi asset installation and
  Codex V8 initialization occur only for the selected provider. Process-wide TLS
  setup still runs before any networking or concurrency begins.
- TAH keeps scheduling, Guardian ordering, cancellation admission, publication
  and recovery. Adapter and native backend keep their existing public boundaries.
- ZCode uses the fork-owned native OAuth owner. The App supplies one atomic
  Keychain record, browser presentation and active-login polling. Only opaque
  handles enter JavaScript. The signed App bundle owns approved model metadata.
- Each Kimi attempt uses a fresh session and scratch copy of the prepared compile
  cache. The build requires a validated prepared cache generation.
- ZCode uses owned scopes and the `ios/native/WIRE.md` protocol. Native process
  closure and drained events precede capture and release. Cancellation may run
  concurrently with a blocked event read.
- Provider switches drain work through AuthService before revoking credentials.
  A failed cleanup prevents new task admission.

## Verification

Verify source locks, provider-only module evaluation, existing Core/browser tests,
native iOS metadata, generated UniFFI bindings and a generic iOS App build. Record
the built artifact and its resource hashes. Physical device installation and
runtime behavior belong to the subsequent phone acceptance.

The Tauri test package also links the existing `TAHMobileQualification` runner.
Only an explicit `--mobile-tah-qualification` launch runs it. The phone invokes
the same controller commands as the UI, owns Guardian/V0/V1/V2 and publication,
and writes its report to Documents. Mac only launches the whole fixture and
reads the report; it never dispatches individual roles. Normal launches do not
run this fixture. This lane avoids Device Hub keyboard interception. The fixture
is synthetic and bundled; it cannot silently use the selected user's transcript.

## Ownership

This change modifies App composition, packaging and thin UI/auth hooks only.
Fork-owned SDK, native execution, auth and adapter changes are owned by their
respective workers. Imported source changes require an updated explicit lock.

## Current Mac evidence

- Existing Core V0/V1/V2 replay and immutable historical output checks pass.
- 194 browser UI tests pass, including ZCode native-browser authorization entry.
- Three fresh JavaScriptCore contexts pass provider-only evaluation and repeat
  selection checks. Node closed-module tests also verify unused-provider counters.
- Controller checks pass on Mac and compile for the iOS simulator.
- Shared native library passes iOS-target metadata/type checking.
- Kimi's owner validated this App's lazy graph in its real Framework/SDK replay.

The App uses AuthService as the authoritative switch/drain lifecycle owner.
Adapter preparation is coalesced, and native preparation uses provider-specific
OnceCells. Task SDK processes, scopes and credentials retain the existing
single-attempt closure rules. Immutable module factories, iSH and V8 may remain
resident after first use. This does not claim native process-global unloading.

## Build input handling

The App reads Kimi's `ios/tests/.cache/tah-sdk/latest.json`, requires a passing
qualification and a prepared compile-cache generation, and compares its Node hash
with the bundled rootfs binary. ZCode consumes an explicit prepared generation
through `ALMA_ZCODE_RUNTIME` or its pre-phone runtime receipt. Source and runtime
identity records accompany the App bundle.

`native_v8_inputs.py` verifies the fork's complete pinned V8 source inventory and
artifacts. Cargo may create the exact pinned iOS binding and its deterministic
checksum sidecar under `gen`. Only those byte-for-byte known outputs are added
to the expected inventory. Tampered bindings, sidecars, upstream source, extra
files and symlinks remain rejected. The negative regression exercises all five.

## Native auth checks

The App Keychain callback is synchronous and serializes each complete CAS. A Mac
fixture compiles the production store against a deterministic Security boundary.
Twenty writers using one revision admit exactly one update. Stale revisions,
read failures and write failures are rejected, and sign-out changes the revision
while storing a null account. This fixture does not access the actual Keychain.
The browser presentation bridge passes Swift 5 and Swift 6 iOS-target typechecks.
Its delegate callback hops to MainActor without transferring the UIKit object.
Full App compilation still supplies the actual generated native API.

## Historical first signed composition build

Alma TAH 0.4.0 (13) completed the generic iOS Xcode build with the actual native
static library and newly generated UniFFI. Nineteen production Swift files
typechecked against those bindings with zero diagnostics. Codesign deep/strict
verification passed. The existing orientation warning remains.

The current executable SHA-256 is
`e6bd734eb07c830ea383a67aa216d5077535e74bdc4c482ea86e7450b6b9b5f2`.
The resource verification checked every Kimi and ZCode runtime entry, all provider
chunks, the trusted Core bundle and the Kimi cache's Node hash against the bundled
rootfs. Kimi runtime manifest is `3a484cc8ed48d272a4715755c45c92276456334d96b8b60027b68c6d081d84c4`.
Kimi compile-cache manifest is `f9bc748771829867bc11e88d3bac0d2b11cfc1323921116391bb4efe3a931b5c`.

This composition build uses the existing ed9 ZCode resource generation, manifest
`80802764a11c0fe6f83ae4beeaae04b3250d9a3960b6dd87ddb17edee634a165`. Main owns
the remaining runtime pipe/bootstrap fixes. Replace that generation with the
final qualified runtime before treating the App as ready for functional phone
acceptance. The machine artifact report explicitly sets `phoneTestReady=false`.

Once main supplies the final generation, set `ALMA_ZCODE_RUNTIME` to its absolute
resource directory, rebuild the trusted bundle, run `prepare_tauri_app.py`, then
repeat the generic Xcode build and resource/signature checks. Rebuild the native
archive first if native source identities changed. No phone was installed or
launched during this work. No repository commit was made.

Logs, artifact hashes and the exact touched-file list are in
`tools/mobile-tah/.cache/zcode-composition`. Two unused incremental compilation
caches older than 72 hours were removed to preserve build headroom. Their names
are recorded in `cache-cleanup.json`. Existing source changes were preserved.

## Review corrections after the first signed build

The first signed build is a composition control. Review then added native typed
PAT validation and bound credential handles. Each handle retains the exact
`Arc<BoundAuthorization>` created for its account generation. Login begin/Ready
revokes the old handle, and scope preparation rechecks it under the admission
lock after asynchronous work. Old inspection responses also recheck the handle
before returning success or an invalid-account result.

The browser cancellation path now sends native cancellation independently of a
blocked poll, before waiting for that poll to finish. The production Swift class
was compiled against UI/native substitutes that deliberately ignore Swift Task
cancellation. Both late Ready rejection and failed cancellation cleanup pass.
ZCode's Adapter owner also added original AuthService regression coverage for
transient inspection errors so existing credentials are retained.

The native archive and App must be rebuilt after these corrections. Current
progress and artifact reports distinguish the initial signed control from the
final resource build.

## Final Swift review

The stateless Keychain callback now uses checked `Sendable`. Both Safari Done and
`UIAdaptivePresentationControllerDelegate` dismissal call the same coalesced
native cancellation path. Safari is presented full-screen. The four dismissal
fixtures cover Done/interactive close, duplicate notifications, successful and
failed native cancellation, and a late Ready response from a poll that ignores
Swift task cancellation. They all pass.

Next-revision settings retain the original Core semantics. Draft checkpointing
does not invoke provider preparation, selection or cancellation. Preparation is
attached only to TAH entry, explicit AuthService selection/confirmed replacement,
and Adapter authentication/task admission. Existing busy/borrower rules continue
to own the active Frozen Attempt.

After review, the native archive rebuilt successfully in 362.789 seconds. The
actual generated bindings and all 19 production Swift sources again passed both
Swift 5 and Swift 6 iOS-target checking with zero diagnostics. The final runtime
resource build is recorded separately once both provider generations freeze.

## Historical pre-phone composition handoff

The reviewed App was rebuilt and signed successfully. Its executable SHA-256 is
`749618247fcd77c7a1e25191064b3d542e6721880b580a909947baed78b2aadd`. It includes
the final Kimi runtime `e08d2b24617a21b81ed127202cbdd12f6389c685c628e60c6e36251e5258d788`
and independently produced cache `1202dce701019ea2370ee1d559015afbabb5b978817eca7a4dea09e22cd5c454`.
The frozen ZCode Adapter includes typed auth errors and event-driven long-thinking
activity, with the owner reporting 95 passing regressions. The App's source lock
contains the exact five production source hashes.

The only remaining App artifact step is main's final ZCode runtime replacement.
The current signed composition control still contains ed9. `verify_app.py`
defaults to `phoneTestReady=false`; use `--phone-candidate` only after supplying
the finally qualified runtime and the expected provider manifest hashes. This
worker leaves every source change uncommitted for main's combined review.

Final packaging uses `ALMA_ZCODE_RUNTIME` and optionally
`ALMA_KIMI_COMPILE_CACHE`. Explicit paths work without historical experiment
reports. The latest passing Kimi record is a convenience fallback only, and its
expected runtime hash must match. Native preparation and source verification
remain active; final project generation rejects stale native sources even when
an old archive's checksum still matches its old receipt.
## 2026-11-07 consolidated candidate addendum

Build 0.4.1 (14) consolidates the Mac-qualified ZCode non-streaming guest
generation (`4332d5c066672c79f5991d6c09aeaf242eaef73ea10ebc13a07ee41ccb666ad3`)
with the later native host-proxy patch. Codex remains pinned to 0.166.0 and Kimi
Code to 2.4.1 while newer releases are evaluated separately. This task builds
and verifies the signed device package on Mac only: it does not install, launch,
or test the phone. Preserve one previous signed package as rollback, record
native source/artifact identities, verify all runtime assets and the signing
identity, and remove obsolete owned build intermediates after qualification.
The signed package and exact verification are now recorded in
[`2026-11-07-zcode-consolidated-build.json`](../../tools/mobile-tah/results/2026-11-07-zcode-consolidated-build.json).
Compilation exposed a consumer-boundary issue: provider sources are included as
the App's nested `zcode_native` module, so the host-network references must be
module-relative and the App must enable matching proxy dependencies/features.
Those corrections passed the 72 native regressions and the actual iOS build.
The resulting signed executable contains the new proxy-denial guard, and the
compiler dependency file records the new host-network source. Version mismatch
is rejected by the verifier. This is build/package verification, not a new
phone execution or long-task acceptance claim.

