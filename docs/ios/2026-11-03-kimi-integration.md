# Kimi integration evidence — 2026-11-03

This record covers the Kimi provider implementation in the ALMA-litter Tauri
phone prototype and completed Mac owned-policy qualification. Phone evidence
comes from local exported journals, native diagnostics, and recorded UI checks.
Core phone integration passed. Raw Guardian and V0–V3 publication are verified,
including real WebSearch in V2 and successful PyTorch FetchURL in V3. The
TensorFlow URL remains subject to the cloud service's safety rejection. The
sanitized result contains counts, hashes, stage timings, and minimal tool statuses. [Phone results JSON](../../tools/mobile-tah/results/2026-11-03-kimi-phone.json)

## Acceptance status

| Lane | Evidence | Status |
| --- | --- | --- |
| Mac owned-policy Raw Guardian | Real SDK Read, Glob, Grep with synthetic HTTP | Passed |
| Mac owned-policy Actor | Real SDK Read, Glob, Grep, Write, Edit and read-back with synthetic HTTP | Passed |
| Phone authentication | Exported metadata has `providerID=kimi`, `state=valid` | Verified |
| Phone Raw Guardian | `09:37:27Z` start, `09:38:17Z` end_turn and close/capture/release, saved ALLOW assessment | Passed |
| Phone V0 | Completed operation, critic PASS, accepted revision 0 and publication | Passed, UI elapsed 78 seconds |
| Phone V1 | Completed operation, critic PASS, accepted revision 1 and corrected notes | Passed, UI elapsed 2m18s |
| Phone V2 publication | Completed operation, critic PASS, accepted revision 2 | PASS, 166.164 seconds from journal timestamps |
| Phone V2 WebSearch | One completed tool call | PASS |
| Phone V2 FetchURL | Two failed calls to the TensorFlow tutorial, cloud probe returns 403 `websearch_audit_failed` | PROVIDER_BLOCKED |
| Phone V3 FetchURL/publication | Real PyTorch FetchURL tool 8 completed, critic PASS, accepted revision 3 | PASS, 137.177 seconds |
| Core phone integration | Raw Guardian, V0–V3 publication, real WebSearch/FetchURL, lifecycle, preservation and cached switching | PASS |
| Codex cached authorization | Exported auth metadata has `providerID=codex`, `state=valid` | PASS |
| Kimi cached reconnection | Exported auth metadata has `providerID=kimi`, `state=valid` at `10:24:41.203Z` | PASS |
| Existing NVIDIA V0/V1 history | UI readback at 18:22 Asia/Shanghai | PASS, observed history access |
| Cross-provider new generation | New generation after switching provider | Untested |

The Mac tests cover guest execution, filesystem tools, normalized events,
transport, and cleanup. Phone journals additionally verify Framework publication
and accepted revision state. Native diagnostic timestamps identify the provider
attempt boundaries. UI elapsed times describe the observed complete workflows.
All timestamps in this record are UTC on 2026-11-03.
[Authentication metadata](../../tools/mobile-tah/.cache/kimi-phone-auth-metadata.json), [native diagnostics](../../tools/mobile-tah/.cache/kimi-phone-diagnostics.json)

## Phone V0 publication and V1 input evidence

Action `3a92da08-200d-4585-8b65-d7b18dd989af` used `kimi-for-coding / low`,
interaction language `zh-CN`, action language `en`, and `Web=false` for V0 and V1.
Both exported SQLite databases were opened read-only. Their integrity checks
returned `ok` and their pending-write tables were empty.

| Export | Database SHA-256 | Verified publication |
| --- | --- | --- |
| `tools/mobile-tah/.cache/kimi-phone-v0-journal/tah.sqlite3` | `8ca584c09007ea776b39e901d5e7aa13891205b79f05b3b590bddbe0aa2f6035` | `publication/8527209d-93cf-4fbb-bf67-419081b27c99` |
| `tools/mobile-tah/.cache/kimi-phone-v1-journal/tah.sqlite3` | `83637bdba61c6a8601dcdd0a01847fe6a7c72a8da96d41c354ad6354ff4ae4bd` | `publication/441bae62-f947-4238-ac8a-4eb069b1dcf2` |

The V1 export retains both publications and records accepted revision 1.
Each completed operation has one Actor round and critic decision `PASS`.
Decoded publication files match their recorded byte lengths and SHA-256 values.
[Exported V0 journal](../../tools/mobile-tah/.cache/kimi-phone-v0-journal/tah.sqlite3), [exported V1 journal](../../tools/mobile-tah/.cache/kimi-phone-v1-journal/tah.sqlite3)

| Published file | Bytes | SHA-256 |
| --- | --- | --- |
| V0 `structured-notes.md` | 1,338 | `81b7232b4dc907f3862bdaba280b54e395b73ab0425a3161d9a85905661fd7f4` |
| V1 `structured-notes.md` | 1,331 | `277a6ad267bbeb110acf6ed1c57055fd9866ce6aeb3de64e1b53f5ef660bff5a` |
| V0 and V1 `suspicious-asr-terms.md` | 382 | `253efc59cbb5427afe0050f9228c00e492abed1d494516a7cb2f8adf314196de` |

V1's published notes state “for a total of 12 images” in both the overview and
timestamped content. Its operation and publication ledger store the exact
instruction verified in the UI before submission.

```text
Correct the total image count to 12. Keep all other facts unchanged.
```

Native diagnostics place the V1 Guardian start at `09:46:53Z`, its `end_turn`
and close/capture/release at `09:47:42Z`, and the following Actor start at
`09:47:42Z`. The exported completed operation and publication establish the
final V1 outcome.

An earlier hardware-keyboard attempt was transformed by the Chinese IME while
still an unsubmitted draft. The verified clipboard replacement supplied the
submitted instruction. Device Hub **Edit → Send Clipboard** transferred the
text reliably. Clipboard write, Send Clipboard, field verification, and
submission run sequentially. [Device Hub text entry](../../tools/mobile-tah/README.md#device-hub-text-entry-for-phone-qualification)

## V2/V3 Web evidence and preservation

The V2 journal export is
`tools/mobile-tah/.cache/kimi-phone-v2-journal/tah.sqlite3`, SHA-256
`b584cc45db7b897a079efd1c75ca4b30d241a3175085c79e4a6763ce8697aa01`.
Its accepted revision is 2, and the publication is
`publication/f76c420e-0282-4efc-a8e6-1ce37ea28a9a`. The completed operation uses
`kimi-for-coding / high`, interaction `zh-CN`, action `en`, and `Web=true`.
It has one Actor round and critic `PASS` with zero issues.
[Exported V2 journal](../../tools/mobile-tah/.cache/kimi-phone-v2-journal/tah.sqlite3)

The V2 notes are 2,186 bytes with SHA-256
`e6bc9cb73bbe51187d959ac52c6849482b81237020cdd639f621a54b37554386`.
The 382-byte ASR file has SHA-256
`253efc59cbb5427afe0050f9228c00e492abed1d494516a7cb2f8adf314196de`
in all four publications. Every decoded file was checked against its recorded
length and digest. The durable working logs also match their stored sizes and hashes.

| Revision | Started UTC | Completed UTC | Journal duration |
| --- | --- | --- | --- |
| V0 | `09:39:09.809` | `09:40:28.337` | 78.528 s |
| V1 | `09:46:53.886` | `09:49:11.962` | 138.076 s |
| V2 | `10:06:41.442` | `10:09:27.606` | 166.164 s |
| V3 | `10:32:07.952` | `10:34:25.129` | 137.177 s |

Per-stage timestamps and durations are recorded in the result JSON. V2 progressed
through preparing, Extra Guardian, safety save, Actor, critic, and completed.
Its minimal tool summary records one successful WebSearch and two failed FetchURL
calls, alongside successful file operations. Publication and critic acceptance
are independently recorded from individual Web tool outcomes.

Direct host probes to the official `/coding/v1/fetch` service returned the
following results. The report retains public target URLs, HTTP status, byte count,
elapsed time, and the allowlisted provider error type.

| Target | Cloud HTTP status | Response bytes | Classification |
| --- | --- | --- | --- |
| TensorFlow image segmentation tutorial | 403 | 138 | `websearch_audit_failed` |
| example.com | 200 | 1,302 | Host service success |
| PyTorch Vision models documentation | 200 | 14,975 | Host service success |
| Wikipedia Image segmentation | 200 | 74,149 | Host service success |

Pinned SDK 2.4.1 tries the Moonshot cloud fetcher first. Its catch path invokes
the local fetcher, whose DNS safety check fails in the service-only guest.
The phone's visible DNS error therefore masks the provider rejection identified
by the separate TensorFlow service probe. The result explicitly identifies the
host probe as the basis for that diagnosis. The service-only broker and original
network grants remain the active boundary. V3 subsequently completed PyTorch
FetchURL on the phone and published the updated notes. [Sanitized service-probe results](../../tools/mobile-tah/results/2026-11-03-kimi-phone.json)

The baseline `tools/mobile-tah/.cache/kimi-phone-before/consistent.sqlite3`
contains 127 event rows. Each row was matched by `operation_id` and every stored
column compared, including header and payload BLOB bytes, against all four
exports. All 127 matched exactly in V0, V1, V2, and V3, with zero missing or changed
rows. The respective exports contain 147, 151, 159, and 163 event rows. All database
integrity checks returned `ok` and all pending-write tables were empty. Only
aggregate preservation evidence is published in the sanitized report.

Codex cached authorization is `valid` in
`tools/mobile-tah/.cache/kimi-phone-return-codex-auth.json`, checked at
`2026-11-03T10:13:37.949Z`. Existing NVIDIA V0/V1 records were opened in the UI
at 18:22 Asia/Shanghai, recorded as an observed history-read check. Kimi cached
reconnection is verified by `kimi-phone-return-kimi-auth.json`, with state `valid`
and checked time `2026-11-03T10:24:41.203Z`. Cross-provider new generation remains
untested. [Switching evidence and limits](../../tools/mobile-tah/results/2026-11-03-kimi-phone.json)

### Verified V3 publication

The V3 export is `tools/mobile-tah/.cache/kimi-phone-v3-journal/tah.sqlite3`,
SHA-256 `c2c969c34400dec392e8d6e0ec0f3ccabe7646cbfef81ac877a602b71177c637`.
It records accepted revision 3 and publication
`publication/4afba549-ff39-43e6-93ab-dc43a44cb91b`. Integrity is `ok`, pending
writes are zero, and all earlier Kimi publication file hashes are retained.
[Exported V3 journal](../../tools/mobile-tah/.cache/kimi-phone-v3-journal/tah.sqlite3)

The persisted workflow ran from `10:32:07.952Z` to `10:34:25.129Z`. Extra Guardian
took 60.486 seconds and Actor took 76.484 seconds. Tool 8 completed FetchURL for
`https://docs.pytorch.org/vision/stable/models.html`. Critic returned `PASS` with
zero issues and one Actor round. The final diagnostics record two successful
start/end_turn/close/capture/release sequences for Guardian and Actor.
[Final native diagnostics](../../tools/mobile-tah/.cache/kimi-phone-final-diagnostics.json)

The published `structured-notes.md` is 2,034 bytes with SHA-256
`af6062b3ee71a3612fec2451fc120c5e4442d590f67ac2fe7e936ac6ac923834`.
Its External Reference contains the actual page's DeepLabV3, FCN and LRASPP model
families and cites the PyTorch URL. Removing that section from V2 and V3 produces
byte-identical remaining text. The corrected total of 12 and transcript facts
are preserved, as is the 382-byte ASR file. Both output lengths and hashes were
verified from the exported publication.

V2's publication/search pass and provider-blocked TensorFlow fetch remain part of
the record. V3 supplies the successful phone FetchURL evidence that completes the
core Web acceptance path. The cloud provider can still reject individual URLs,
and the service-only guest continues to reject direct-fetch fallback.

## Exact release and resources

The release selected as latest during the 2026-11-03 audit is pinned for this
integration. Reproduction consumes the recorded version and hashes.

| Input | Locked identity |
| --- | --- |
| Kimi Code release | `@moonshot-ai/kimi-code@2.4.1` |
| Release publication | `2026-10-30T09:50:16Z` |
| Source commit | `2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7` |
| SDK | `@moonshot-ai/kimi-code-sdk@0.22.0` |
| SDK entry SHA-256 | `a85fa13949e2b3fb9bbf08a143d122123598ecac778e97d40716cde2b1e97e78` |
| permission-rules patch SHA-256 | `a73d4c08efbdb59dbb732e3adc51eec83d31f27d12c8eca6a737872b3cfb9e02` |
| Guest runtime | Linux ARM64 Node `22.23.4` under iSH |
| Qualified rootfs lock for both artifact sets | `121f61e704e53396f429cbb57db2d9b3b06818eaa3d8bd3fce63f89ea5e96ea7` |
| Earlier owned Mac tool-run runtime manifest | `aace22419d604cb313d36d8115c1ad96d71707edb83a13429db9ee8335f013f6` |
| Earlier owned Mac tool-run guest entry SHA-256 | `be0915f8d9a37d32c0cd1bf867b136980fede5bfead2f7780e2b437570ed151b` |

The release lock includes upstream source, build toolchain, artifact closure,
and the reviewed permission patch. Adapter adoption has a separate inventory
under `shared/tah-runtime/kimi-source-lock.json`. The 2.4.1 release uses its
existing Harness/session API. The later main-branch Environment extension is
outside this pinned implementation. [Release lock](../../tools/kimi-mobile-probe/latest-source.lock.json)

The owned Mac tool-run IDs above identify the packaged resources frozen when
Read/Glob/Grep and Actor Write/Edit were qualified. The copied guest entry matched
that resource byte-for-byte. The later cleanup-hardened phone package has its own
identity below. The retained Mac assertions remain bound to their original inputs. [Frozen probe inputs](../../tools/alma-ios-lab/kimi_owned_probe/.cache/integrated-inputs.json)

## Final phone build identity and V3 start

The final generated Tauri Xcode inputs select the cleanup-hardened runtime
`8440bebe8469d691df56ed989551cf3453dd72413c8dafb6667146e808c38ae0`.
Its manifest hash matches the copy in the local built App. All 878 runtime files
in that built App match the manifest's byte lengths and SHA-256 values, including
the locked SDK entry. The generated JSCore bundle and mobile configuration also
match their built copies.

| Final build evidence | Identity |
| --- | --- |
| Runtime manifest SHA-256 | `8440bebe8469d691df56ed989551cf3453dd72413c8dafb6667146e808c38ae0` |
| Guest entry SHA-256 | `2b68bc688d5536b47cff64fb5ee4aa12ed2226507d311dbc578117673fa15a4c` |
| App executable SHA-256 | `588b58872d847343489c86a63638c51b52d8b635b9b941a828a89c8a866ef675` |
| App executable Mach-O UUID | `44BE0F11-26C8-35CF-87DC-1CE97C209C61` |
| Generated `tauri-app/project.yml` SHA-256 | `d575981a1473d10ac3316eecd0b9c17fd6e6293005301fe8d7cb3ea7880b698c` |
| Generated `project.pbxproj` SHA-256 | `c2d8bfe1eae032f9997aa17bfbf647953aec0817bb14587901059fd5293fc9d4` |
| Linked `libalma_tah_ui_lib.a` SHA-256 | `14b0e41edb2244061b499676f28cc10e111acb39927d6358f31758a3b410af4b` |

These hashes identify the generated inputs and built product associated with the
retained successful build, installation, and launch logs. The App executable is
460,497,760 bytes. The result JSON records precise artifact paths, byte counts,
resource comparisons, and provenance separately from the earlier owned Mac
qualification. [Build identity and original Mac test identity](../../tools/mobile-tah/results/2026-11-03-kimi-phone.json)

The V3 phone attempt started at 18:32 Asia/Shanghai (`10:32Z`, minute precision),
using `kimi-for-coding / low`, Web enabled, action language `en`, and interaction
language `zh-CN`. The journal verifies completion and publication at
`10:34:25.129Z`. The persisted UI draft in
`kimi-phone-ui-check.json` matches the full instruction below, including the final
period. The instruction has 240 UTF-8 bytes and SHA-256
`f5c2b5c32a43e83d3d20389b1d09a2c2e1dd897acc0658482e013361bdded791`.

```text
Use FetchURL to read https://docs.pytorch.org/vision/stable/models.html and replace the External Reference section with one brief sourced note about its semantic segmentation models. Preserve all transcript facts and the total of 12 images.
```

The result records only the selected draft's identity and verification facts,
plus the public target URL. The final phone journal independently verifies a
completed FetchURL tool and accepted publication.

## Implementation and ownership

The original trusted TAH Core runs in JavaScriptCore and owns frozen attempts,
Raw/Extra Guardian ordering, Actor, critic, revisions, acceptance, publication,
and journal semantics. Provider-specific behavior stays behind the existing
`TAHFramework -> ProviderAdapter -> ProviderBackend` boundary. React and Swift
present the state and invoke the original application actions.

| Component | Responsibility |
| --- | --- |
| `shared/tah-runtime/platform/entry.ts` and `runtime.ts` | Provider registration, configuration and existing AuthService composition |
| `shared/tah-runtime/platform/kimi/mobile-provider.ts` | Native credential handles, frozen input checks, normalized-event ledger, lifecycle receipts and candidate capture |
| `shared/tah-runtime/platform/kimi/guest/` | Guest entry, pipe fetch, real Kimi Harness/session, tool approval, event and terminal conversion |
| `shared/rust-bridge/codex-mobile-client/src/kimi_backend.rs` | Owned Node process, stdin/stdout frames, native HTTP broker, cancellation, drain and terminal delivery |
| `shared/rust-bridge/codex-mobile-client/src/provider_scope.rs` | Sealed iSH instance, exact filesystem grants, owned completion, capture and release |
| `shared/rust-bridge/codex-mobile-client/src/kimi_assets.rs` | Verified immutable runtime installation under `/workspace/.runtime/kimi` |
| `TAHCodexPlatform.swift` and `TauriNativeHost.swift` | Native provider-aware authentication, secure Kimi input, Keychain and controller composition |
| `apps/ios/tah-ui/` | Provider selection, account/settings presentation and task UI |

The native platform retains the real credential and passes an opaque handle to
trusted JavaScript. Guest configuration uses the placeholder credential. The
Rust broker validates the frozen model and route, then supplies native
Authorization headers. Model requests use the approved Kimi model routes.
WebSearch and FetchURL additionally require the frozen Web capability.

Each guest uses read grants for `/bin`, `/sbin`, `/usr`, `/lib`, `/etc`, its
material view, and `/workspace/.runtime/kimi`. Scope scratch is writable. Actor
receives its declared output roots. The native grant uses `DenyDirect`, while
`/proc` and `/dev` use the kernel's specific pseudo-path checks. The Adapter
requires runtime closure, joined requests, retained events, and scope quiescence
before capture and release. [Mobile Adapter](../../shared/tah-runtime/platform/kimi/mobile-provider.ts), [native backend](../../shared/rust-bridge/codex-mobile-client/src/kimi_backend.rs), [scope implementation](../../shared/rust-bridge/codex-mobile-client/src/provider_scope.rs)

## Owned-policy compatibility failures and fixes

### ICU data mapping

The initial phone failure surfaced as `kimi_terminal_missing`, then as a guest
fatal category after error classification was added. The owned Mac probe
reproduced the underlying `RangeError` with message `Internal error. Icu error.`
at `sdk/index.mjs:117090:62`, inside `String.localeCompare` during skill catalog
sorting. It failed before the first HTTP request.

Reading `/usr/share/icu/74.2/icudt74l.dat` succeeded for all 2,799,392 bytes.
Temporary logging in the private source snapshot captured ICU requesting a
file-backed `MAP_SHARED` mapping. `workspace_fd.c::wp_mmap` explicitly returns
`ENOTSUP` for that request. The locale and `ICU_DATA` controls reproduced the
failure. All diagnostic kernel edits were removed before final qualification.

`prepare_kimi_icu.py` now packages the existing pinned data as the exported
`icudt74_dat` object in `libicudata.so.74.2`, so the ELF loader uses private
mappings. The production rootfs builder applies this transform after the locked
APK installation, checks both input and output hashes, and includes
`rootfsBuildVersion=2` in its lock identity. Shared-library data packaging is an
official ICU packaging mode. [ICU data packaging](https://unicode-org.github.io/icu/userguide/icu_data/), [production transform](../../tools/mobile-tah/prepare_kimi_icu.py), [native tools lock](../../tools/mobile-tah/kimi-tools/source-lock.json)

| ICU evidence | Value |
| --- | --- |
| Data SHA-256 | `ec1035db29767d51df2161dc8dcdb1700140a56e0cc70262444f20c89bed081d` |
| Original stub library SHA-256 | `a8a959195940f14fccfa7ad7eaab9c5d19fc30c3797d78e541757cafc3050748` |
| Embedded library SHA-256 | `c0c1dc1c77a7b1b8959ad061740f0183f8911918d7ded05217ea25b708286d76` |
| Compiler | Apple clang `21.0.0`, build `clang-2100.4.1.1` |
| Linker | LLD `23.1.1`, Rust LLVM revision `1b9c0d5ff9bbe7634aead059efe6b11a7eeba145` |
| SONAME | `libicudata.so.74` |
| Export | `icudt74_dat`, GLOBAL OBJECT, default visibility, 16-byte aligned |

ELF inspection verified that the replacement exports the same symbol name and
SONAME as the original stub, satisfies the installed `libicuuc.so.74.2` import,
and contains byte-identical data. It has ARM64 ELF64 format and data-only LOAD
segments. A repeated build reproduced the output hash. The qualified run uses
the original kernel source and grants. [ELF and tool-version evidence](../../tools/alma-ios-lab/kimi_owned_probe/.cache/icu-elf-verification.json)

A faithful kernel implementation of read-only shared mappings would also need
maximum-write permission tracking and safe `mprotect` updates. Current
`pt_set_flags` updates guest flags before checking host `mprotect` success.
A scoped conversion to private COW would change the requested mapping semantics
and needs separate regression qualification. The implemented integration uses
the tested packaging transform.

### Native realpath

After ICU initialization succeeded, native `fs.promises.realpath` failed on the
allowed scratch directory `home/empty-skills`. Focused logging identified
`readlink("/workspace")` receiving `EACCES` because `generic_readlinkat` requires
`WP_READ` and that ancestor has traversal rights.

The guest entry assigns `fs.promises.realpath = promisify(fs.realpath)` and
calls `syncBuiltinESMExports()` before SDK import. Node's callback resolver
performs the component checks supported by the scoped filesystem. The probe
verified allowed-path resolution and rejection of a path outside the grant.
The kernel also rejected guest symlink creation. [Guest entry](../../shared/tah-runtime/platform/kimi/guest/entry.mjs), [resolver controls](../../tools/alma-ios-lab/kimi_owned_probe/.cache/diagnostic-compat-embedded.stdout)

## Completed owned-policy tool qualification

The isolated probe compiles a byte-verified copy of the actual
`.build/vendor/litter-ish-owned/embed/host` crate, with private offline Cargo
lockfiles and build outputs. It uses `boot_workspace_policy_with_workspace`,
`prepare_workspace_grant`, and `spawn_with_grant`, then launches
`/usr/bin/node /workspace/.runtime/kimi/guest.mjs` with the production environment.
It sends a minimal frozen attempt and synthetic SSE responses through the real
pipe transport. The official SDK executes every requested file tool.

| Case | Tool sequence | HTTP requests | Events | Guest time | Peak sampled process RSS |
| --- | --- | --- | --- | --- | --- |
| Raw Guardian | Read → Glob → Grep | 4 | 13 | 38.6 s | 746,432 KiB |
| Actor | Read → Glob → Grep → Write → Read → Edit → Read | 8 | 25 | 39.4 s | 738,800 KiB |

Both cases verified the actual tool output in later model requests, successful
tool completion events, continuous event sequence numbers, each response ACK,
final-text consistency, material integrity, private-home deletion, `end_turn`,
guest exit 0, and owned closure. The Actor case additionally compared the edited
host-side output to the expected UTF-8 content. Materials contained Chinese text
and emoji. All assertions passed. [Guardian assertions](../../tools/alma-ios-lab/kimi_owned_probe/.cache/tools-guardian-success-validation.json), [Actor assertions](../../tools/alma-ios-lab/kimi_owned_probe/.cache/tools-actor-success-validation.json)

The probe used synthetic credentials and HTTP responses. Guest runs have a
100-second deadline, a 115-second outer process deadline, and a sampled
1,800 MiB per-process RSS stop threshold. The build uses one Cargo job and a
600-second deadline. The original 521 source files matched their baseline
hashes after diagnostic instrumentation was removed, excluding the regenerated
private Cargo lock. [Probe report and commands](../../tools/alma-ios-lab/kimi_owned_probe/RESULTS.md)

## Reproduction

Use the prepared native dependency lane and exact pinned SDK artifacts described
in the mobile TAH README. From the repository root, generate and verify resources.

```sh
python3 tools/kimi-mobile-probe/prepare_latest.py --verify-only
python3 tools/mobile-tah/adopt_kimi.py --check-only
python3 tools/mobile-tah/build_tauri.py --resources-only
python3 tools/mobile-tah/prepare_kimi_runtime.py --verify-only
python3 tools/mobile-tah/prepare_kimi_rootfs.py --verify-only
```

Follow the combined Rust archive, real UniFFI bindings, and Xcode sequence for the
phone package. The generated project records the selected rootfs and
`kimi-runtime` paths. Record rebuilt bundle identities and device acceptance
against the resulting installed package.
[Tauri build recipe](../../tools/mobile-tah/README.md#tauri-build-and-reproduction)

The owned probe's `.cache/integrated-inputs.json` retains the resource paths from
the qualified Tauri project. With those prepared artifacts available, run the
bounded model-free checks.

```sh
python3 tools/alma-ios-lab/kimi_owned_probe/run.py build
python3 tools/alma-ios-lab/kimi_owned_probe/run.py tools-guardian-success
python3 tools/alma-ios-lab/kimi_owned_probe/run.py tools-actor-success
python3 tools/alma-ios-lab/kimi_owned_probe/verify_icu_elf.py
```

Local `.cache` transcripts, manifests, fixtures, plans, process metadata, and
validation JSON are retained on the qualification host. The durable source
recipe and this evidence record describe their provenance. Cache availability
and the prepared toolchain are reproduction prerequisites.

## Guest close failure regression

The guest now attempts `session.close()` and `harness.close()` independently and
sequentially. A failure in either attempt remains a retryable
`kimi_close_failed` cleanup failure. Cleanup takes precedence over completion or
cancellation, and the final answer is emitted only after successful cleanup.

`adopt_kimi.py` encodes this adaptation and checks the expected upstream text
before applying it. Regenerated `adaptation.patch` and `adaptation.json` retain
the change. The source comment identifies the per-attempt owned guest process.
[Adoption helper](../../tools/mobile-tah/adopt_kimi.py), [adaptation record](../../shared/tah-runtime/platform/kimi/adaptation.json)

The targeted regression failed before the fix and passed afterward. It injects
session-only, harness-only, and both-close failures for completion and cancellation,
covering six cases. It verifies both sequential attempts, cleanup-family
precedence, and suppression of the final answer. This is source-level regression
evidence. The earlier phone V0/V1 results used the preceding build.

```sh
node --test --test-name-pattern='guest cleanup independently' tools/mobile-tah/kimi_checks.mjs
```

The retained `kimi-final-checks.log` records all 12 test groups passing with zero
failures. The Xcode build, installation, and launch logs record success for the
cleanup-hardened package. Its runtime manifest is
`8440bebe8469d691df56ed989551cf3453dd72413c8dafb6667146e808c38ae0` and guest SHA-256 is
`2b68bc688d5536b47cff64fb5ee4aa12ed2226507d311dbc578117673fa15a4c`. The V2 publication evidence
above follows that build, and V3 verifies successful FetchURL and publication
on the cleanup-hardened phone package.
[Build and regression evidence](../../tools/mobile-tah/results/2026-11-03-kimi-phone.json), [regression source](../../tools/mobile-tah/kimi_checks.mjs)

## Qualification limits

Core phone integration is complete, with no pending checks in the recorded
Raw Guardian, V0–V3 publication, real WebSearch/FetchURL, cached authorization,
history-read, and journal-preservation scope.

- The official cloud service returned HTTP 403 `websearch_audit_failed` for the TensorFlow tutorial. The guest retains service-only fetching and rejects direct fallback. Other public URLs, including the phone-qualified PyTorch target, succeeded.
- Long transcripts, long-running Kimi inference, background/physical-lock execution, and power consumption were not tested in this lane.
- Cross-provider new generation remains untested. Codex/Kimi cached authorization and existing NVIDIA V0/V1 history access passed.

The result JSON retains these limits separately from the completed core checks.
