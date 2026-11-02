# Codex 0.166 ThreadItem migration evidence

Bounded work on `dev/ios`, against the actual Codex checkout at
`6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` (with the existing prerequisite patches).
The real type is `ThreadItem { payload, started_at_ms, completed_at_ms }`;
IDs remain in `ThreadItemPayload`, exposed by `ThreadItem::id()`. Serde keeps the
wire payload flat.

## Final M1 qualification

**The real local-profile mobile Rust library check passes against actual Core.**
The main-owned `cargo-check-ios-local-4.log` was read and archived here unchanged:
`Finished ios-dev ... in 15.21s`, **0 errors, 31 mobile-library warnings**.
See [the compile log](cargo-check-ios-local-4.log) and
[the final evidence record](m1-final-evidence.json) with the log SHA-256.
The old six-error record below is historical and superseded. No identical full
check was rerun to finalize this report.

The parent removed the remaining global iSH hooks, retained their historical
regression fixture, registered OwnedBackend/ScopedFs, and changed `ish_runtime`
to owned `Arc`/`boot_owned` lifecycle. **Actual Core Environment wiring remains
pending**: a successful Rust library check does not demonstrate embedded command
execution, P0 text end-to-end behavior, generated Swift/Kotlin compilation, an
app link, or a device run. The 31 warnings are nonfatal (mostly retired helpers
and feature-disabled paths); no warning cleanup was folded into this migration.

Recorded supporting checks remain 42 source-derived tests passed, actual iOS
protocol metadata checks passed (tests compiled, not executed), and remote guard
probes passed in both feature modes. Their earlier source snapshots are recorded
in their individual evidence files; these are not newly rerun full-build results.

Exact outstanding UI/capability work:

- Regenerate bindings, then extend plan wire parsing/serialization in iOS
  `Bridge/AppSpecificTypes.swift:299,325`, plan/account rendering in
  `Views/ConversationInfoView.swift:685,704`, and GCP account switches in
  `Views/SettingsView.swift:180,1195,1206,1221`. Android account `when` expressions
  need GCP in `ConversationInfoScreen.kt:877`, `AccountSheet.kt:150`, and
  `SettingsSheet.kt:273`. Exact new plan/voice cases are listed below; no
  handwritten exhaustive realtime-voice switch was found. No UI was edited.
- Message edit/in-place rollback fails before RPC. Forking remains an inclusive
  canonical `last_turn_id` operation; missing/active boundaries fail explicitly.
- Detached review, legacy explicit realtime handoff, client-controlled handoff,
  and nonempty custom realtime tools fail before RPC. Ordinary realtime settings
  remain representable but are not runtime/device-qualified here.
- Durable image IDs/detail survive typed data and queued projections, but image
  fetching/rendering and creating new durable attachments through the public
  mobile input surface are unsupported. Queue previews report this explicitly.
- The deleted custom dynamic-tool argument stream has no invented replacement;
  typed item events remain authoritative. Partial answers retain nonterminal
  behavior via mobile Commentary; a distinct public partial-answer case is not
  exposed. ChatGPT workspace name is not added to the existing account display
  projection.
- Local-only builds explicitly reject remote CLI entry through MobileClient;
  Alleycat/Iroh and pairing remain feature-gated. The enabled remote transport
  port is deferred, not qualified by this no-default-features check.
- Earlier FFI SSH bootstrap entries still need parent-owned guards before their
  own side effects: `ffi/server.rs:361` (`start_remote_over_ssh_connect`) and
  `ffi/ssh.rs:78,492` (`ssh_connect_and_bootstrap`, `run_guided_ssh_connect`).
  MobileClient's completion guard cannot undo caller-side SSH/bootstrap work.

M1 is finalized at Rust library compile qualification with these explicit limits.
The subsequently authorized M4 auth-refresh integration is separate work and is
not credited as complete by this M1 report.

## Original runtime write scope

All paths below are relative to `shared/rust-bridge/codex-mobile-client/src/`.

| File | Change |
| --- | --- |
| `conversation.rs` | Exhaustively match `&item.payload`; retain ID and turn attribution; project recorded start time (completion fallback) to epoch seconds, including widget early returns; migrate fixtures and add five regression tests. |
| `session/events.rs` | Migrate item/turn fixtures; strengthen started/completed routing tests to compare full wrappers including timestamps. Runtime notification cloning remains intact. |
| `mobile_client/event_loop.rs` | Read payloads in deserialization tests and wrap command fixtures with `ThreadItem::untimed`. |
| `store/reconcile.rs` | Wrap user-message fixtures; supply the new optional turn root ID. |
| `mobile_client/store_listener.rs` | Match payloads for completed-plan persistence and collab receiver hydration, keeping start/completion distinctions and receiver normalization. |
| `ffi/app_store.rs` | Migrate MCP/collab fixture constructors and payload destructuring. |
| `store/reducer.rs` | Match payloads for dynamic argument cleanup and completed-plan mode; wrap synthetic progressive file changes; preserve an existing recorded timestamp when an update is untimed; migrate fixtures and test timestamp retention. |
| `ffi/client.rs` | Read completed assistant text from the payload; keep the existing structured-response completion/error flow. |

No unsupported-item catch-all was added. Hook prompts remain explicitly hidden;
review/compaction/plan boundaries, Web action serialization, tool statuses,
argument cleanup, and final-answer handling retain their existing behavior.
The full protocol wrapper is passed/cloned without reconstruction in live paths,
so both lifecycle times and optional payload fields remain intact. The existing
mobile record exposes only one display timestamp; it does not expose both times.

## Authorized three-file follow-up

Only these three runtime files and this evidence directory were written in the
follow-up. The earlier eight runtime files were read for regression coverage.
The actual projection path was verified as `src/mobile_client/thread_projection.rs`.

| File | Change |
| --- | --- |
| `perf_profile.rs` | Wrap the benchmark's assistant payloads with `ThreadItem::untimed`; initialize `Turn.root_turn_id` to absent. Preserve item IDs/text/optional data and the original turn timestamps/duration. |
| `mobile_client/thread_projection.rs` | Use explicit `ImageReference::Inline`/`File` handling; retain typed image references and optional detail in `imageInputs`, while keeping the legacy inline URL list. The queue preview explicitly says an image attachment cannot be previewed on mobile for durable references. |
| `types/server_requests.rs` | Project mobile image URLs through `ImageReference::Inline`, preserving the existing flat wire URL and absent detail. Text spans, local paths, mentions and skills are unchanged. |

Queued drafts continue to clone the full typed `inputs`. Their saved JSON now
retains typed image inputs instead of losing durable file IDs or image detail.
The test-only JSON reconstruction helper prefers that retained representation,
so inline URLs are not duplicated; legacy URL aliases remain accepted. Image-only
durable messages retain a nonempty draft/preview and saved JSON. Preview limitation
text is kept out of the actual message text sent to the model. Text-only projection
retains its existing shape. No remote fetcher, uploader, new public input variant,
or image UI was added. Durable image rendering and creating new durable attachments
from the public mobile input surface remain unsupported, explicitly documented
here and reported in the queue preview where relevant.

## Unavoidable adjacent API changes

- `MessagePhase::PartialAnswer` is handled explicitly as mobile `Commentary`,
  preserving its nonterminal semantics. `FinalAnswer` stays terminal; absent
  phase stays absent. Adding a third public mobile enum case is outside scope.
- `ImageGenerationItem.result` became `image: GeneratedImageRef`.
  Inline bytes and saved paths retain existing behavior. A durable `File` result
  signals completion without being mistaken for base64 or a local path.
  Image fixtures now initialize `input_images`.
- `UserInput::Image.url` became `image: ImageReference`. Inline URLs retain their
  behavior. Durable files render an attachment label so image-only user messages
  are not dropped. File IDs remain on the upstream wrapper, but the existing
  mobile image record cannot expose/fetch them; that needs separate attachment
  support outside this write scope.
- Typed fixtures initialize `CommandExecution.sandbox_type/model_context`,
  `McpToolCall.mcp_app_ui`, and `Turn.root_turn_id` with absent values. These are
  required constructor fields in the checked-out API; no new values are invented.

## Verification

Run from the repository root:

```sh
python3 tools/alma-ios-lab/thread_item_regression/run.py
```

Result: **42 passed, 0 failed**. See `test-output.txt` and `evidence.json` (input
hashes and command). `git diff --check` also passes.

The harness uses an isolated, ignored `.build` workspace and offline cached
small dependencies. It extracts actual upstream declarations, including every
ThreadItem payload variant/field and serde annotations, and compiles source
copies of the mobile hydration code and its tests. It also compiles the actual
reducer merge helper/test and the two FFI payload tests. The follow-up adds the
actual queue projection/conversion functions and their six new tests, the existing
audio-preservation test, and a construction/hydration test of the benchmark's
2,000-item fixture. The timing/allocation benchmark itself is not run.
AST checks now parse all fourteen authorized files, reject old enum syntax, and compare payload constructor fields to
the upstream declarations (including constructors inside `vec!`). Source checks
verify the event/control branches still retain the wrapper and completion guards.

This is **source-derived evidence, not a real protocol-crate or full mobile/iOS
build**. Schema/TypeScript/UniFFI derives are removed in the harness only.
Path handling is a transparent test wrapper; sandbox/model-invocation metadata,
reasoning effort, and Codex error info are opaque JSON support aliases. Two
missing custom Debug implementations are replaced by derives in test copies.
The queue UUID is a deterministic harness-only ID; UUID generation is not tested.
The actual RPC error enum is copied without its formatting derive. No dependencies
were added for this follow-up, including in the harness.
Shell extraction is a no-op shim, so its two dedicated tests are excluded; the
unrelated parser test suite is also filtered. Neither production source nor
repository manifests/locks are rewritten for the harness. A matching formatter
was checksum-verified and unpacked only under `.build`; formatting was applied
to changed regions of the authorized files.

The strengthened complete event-routing tests in `session/events.rs`, other
full reducer/listener tests, integration, generated bindings and device behavior
still require the main build. No full-crate build, device action, submodule
mutation, dependency/lock edit, commit, push or global configuration change was
performed by the initial two passes. The latest authorized alignment pass did
run the real local-profile iOS mobile check with two jobs, as recorded below.
The final M1 section records the later successful Rust library check. A linked
app build, generated-binding compilation and device validation remain unclaimed.

## Actual local-profile compile follow-up

The user supplied `tools/alma-ios-lab/.cache/cargo-check-ios-local-2.log` with 34
mobile-crate errors and expanded write scope to `types/models.rs`,
`mobile_client/dynamic_tools.rs`, and `mobile_client/mod.rs` in addition to the
prior files. This pass changed exactly these nine runtime files:

- `types/models.rs`: retain every upstream plan identity rather than aliasing
  tiers; add all 16 missing realtime voices with bidirectional conversion; add
  distinct `Account::Gcp`; accept the new ChatGPT `workspace_name` field while
  retaining the existing email/plan projection; preserve the skill path string
  supplied as `LegacyAppPathString`.
- `types/server_requests.rs`: initialize new thread-list filters to `None`;
  explicit mobile goal set/clear actions carry `origin: User`; reject detached
  review rather than silently requesting inline review; reject custom realtime
  handoff and nonempty dynamic-tool options before creating a request; keep
  ordinary realtime settings and current protocol defaults, including
  `backend_reasoning_status: false` and `voice_session_id: None`. Empty dynamic
  tool lists remain equivalent to no tools. Remove conversions to deleted
  handoff request types, preserving mobile request records for explicit errors.
- `mobile_client/dynamic_tools.rs`: initialize both new thread-list filters to
  `None`, preserving the existing unfiltered session-list request.
- `ffi/client.rs`: resolve/finalize realtime handoff methods now return explicit
  errors directly, before entering the runtime/RPC path.
- `mobile_client/mod.rs`: remove the deleted typed rollback helper; message edit
  rejects unsupported in-place rollback before any RPC or store mutation; fork
  uses the genuine upstream inclusive `last_turn_id` parameter, not a speculative
  fork followed by rollback.
- `mobile_client/thread_projection.rs`: select the fork boundary by the original
  user item's canonical turn ID. Missing IDs, invalid selection and a known
  active selected turn fail before forking; rendered item counts are not used.
- `mobile_client/event_loop.rs`: remove references to the deleted rollback
  request variant from routing/method classification.
- `store/reconcile.rs`: remove the deleted typed rollback response handler;
  explicitly reject a legacy `thread/rollback` reconciliation rather than
  reporting success; update its regression test.
- `session/events.rs`: remove the nonexistent upstream dynamic-argument delta
  notification arm. ItemStarted/ItemCompleted remain authoritative. Internal
  legacy delta events/reducer handling remain available. Current 0.166 does not
  provide that custom streaming widget-argument preview; no replacement event
  or completed result is fabricated.

No changes were made to main-owned connection/iSH hooks, Cargo, `lib.rs`,
submodule patches, UI/Swift/Kotlin, generated sources or device state. All
pre-existing cfg lines in `mobile_client/mod.rs` were verified unchanged, including
the main owner's remote feature gates. No commit or push was performed.

### Real mobile crate check

```sh
bash tools/alma-ios-lab/cargo_ios.sh check -p codex-mobile-client --lib \
  --target aarch64-apple-ios --profile ios-dev --no-default-features --locked -j 2
```

The first migration check reduced 34 errors to 7; it exposed the additional GCP
account case, which was then fixed. That earlier check reported **6 errors, all in
main-owned files**, with **no diagnostics in this migration's files**:

| File at recorded check | Remaining error |
| --- | --- |
| `session/connection.rs:588` | Removed `codex_cloud_config::cloud_config_bundle_loader` import |
| `session/connection.rs:1244` | Removed `RemoteAppServerClient::connect_websocket_stream` constructor |
| `ish_exec.rs:12` | Missing `set_ios_exec_hook` |
| `ish_exec.rs:13` | Missing `set_ios_streaming_exec_hook` |
| `ish_exec.rs:114` | Missing `IosExecOutputHandler` |
| `shell_preflight.rs:129` | Missing `set_mobile_exec_preflight` |

See `cargo-check-ios-alignment-final.log` for actual compiler output and
`cargo-check-ios-evidence.json` for the command, exit code 101, remaining errors,
changed-file hashes and feature-gate preservation. This earlier failing check
is superseded by the final M1 successful library check above. Neither check
claims that the final iOS app builds or executes. Pair-module unused imports and upstream deprecations remain warnings.

### Additional verification and limits

- `run.py`: **42 passed**, including the earlier hydration/image regressions,
  parsing all 14 authorized files, constructor auditing, and assertions that
  removed optional entry points reject before RPC and bounded fork supplies a
  canonical turn ID. These remain source-derived tests with the documented shims.
- `check_real_protocol.py`: **passes**. It extracts actual mobile conversions and
  seven new plan/voice/account/request tests, strips UniFFI derives only from
  those mobile definitions, and type-checks them against the actual cached iOS
  `codex_app_server_protocol` and `codex_protocol` metadata. No substitute protocol
  definitions or dependency rebuild are used. Tests are compiled with
  `rustc --test --emit=metadata`; they are **not executed on a host or device**.
  See `real-protocol-output.txt` and `real-protocol-evidence.json`.
- `git diff --check`: passes.

### Downstream enum work (reported only)

Bindings must be regenerated by the main build. New mobile plan cases are
`ProLite`, `ProMax`, `SelfServeBusinessProLite`, `SelfServeBusinessUsageBased`,
`Ent26`, `EnterpriseCbpAutomation`, `EnterpriseCbpUsageBased`, `EduPlus`, `EduPro`,
`Sci`, and `SciPlus`. The new voice identities are `Aube`, `Bubbie`, `Haetsal`,
`Hanul`, `Himari`, `Leher`, `Miko`, `Neer`, `Porto`, `Rindo`, `Rio`, `Rivage`,
`Selva`, `Sonna`, `Tinta`, and `Viola`. `Account` adds `Gcp`.

Observed handwritten consumers requiring follow-up:

- iOS `Bridge/AppSpecificTypes.swift:299,325`: plan wire parsing/serialization.
  The serializer's exhaustive switch needs new cases; the parser currently
  returns nil for their wire names.
- iOS `Views/ConversationInfoView.swift:685,704`: account presentation and plan
  labels have exhaustive switches.
- iOS `Views/SettingsView.swift:180,1195,1206,1221`: account switches need GCP.
- Android `ui/conversation/ConversationInfoScreen.kt:877`,
  `ui/settings/AccountSheet.kt:150`, and `ui/settings/SettingsSheet.kt:273`:
  account `when` expressions need GCP after Kotlin bindings regenerate.
- No handwritten exhaustive `AppRealtimeVoice` switch was found; generated
  bindings still need to include the new cases. No UI files were edited.

Remaining behavior limits are explicit: past-message editing/in-place rollback,
legacy client-controlled realtime handoff and custom realtime tools, detached
review delivery, and durable-image rendering/new durable attachment creation
through the mobile input surface remain unsupported. Ordinary realtime requests,
current bounded fork, fresh-thread P0 text workflows and inline image URLs retain
their current protocol paths. Additional unrelated API drift can surface once
main-owned compilation blockers clear.

## Remote CLI capability-guard follow-up

Only `mobile_client/mod.rs`, `ffi/client.rs`, and this evidence directory were
written in this pass. `network_scope.rs` is parent-owned and was not modified.
Its before/after hash matched. Parent connection/bootstrap and feature-gate edits
were preserved. The prior six-error full-check log above records an earlier
source state, before the parent's reported managed-config/network-bootstrap fixes;
it is not a fresh diagnosis of the current connection code.

The first executable statement in each of these MobileClient entry points now
checks `network_scope::remote_cli_available()` and returns
`TransportError::ConnectionFailed(REMOTE_CLI_UNSUPPORTED.into())` when disabled:

- `connect_remote`
- `connect_remote_over_slingshot`
- `connect_remote_over_ssh_bridges`
- `connect_remote_over_ssh`
- `finish_connect_remote_over_ssh`

This check precedes cached-session reuse, Slingshot enrollment/credentials,
server-health updates, session replacement, SSH connection/bootstrap and remote
resource attachment **inside these methods**. Existing method continuations were
verified identical to the pre-edit snapshots. Enabled builds continue through
the real existing connection paths; disabled builds cannot return a fake cached
connection success. The old remote transport API port remains deferred.

`AppClient.remote_cli_available()` exposes the same shared build capability to
platform consumers. It does not claim network reachability or connection success.
Bindings/UI were not regenerated or edited.

Run the bounded guard verification with:

```sh
python3 tools/alma-ios-lab/thread_item_regression/check_remote_cli_guards.py
```

Both feature configurations pass. This compiles the exact leading source guards
and accessor against the actual parent-owned `network_scope.rs`, with a
side-effect counter after each guard. Disabled mode returns the parent's error
before that counter advances; enabled mode reaches the continuation. Only the
error container and post-guard continuation are harness shims. It does not open
SSH, enroll, contact a remote endpoint, or validate the deferred remote transport.
See `remote-cli-guard-output.txt` and `remote-cli-guard-evidence.json`.
`git diff --check` passes. No shared-target full build was rerun during this
small guard follow-up; old iSH backend wiring remains parent-owned.

### Parent follow-up outside the current write scope

Whole-app prevention of remote CLI side effects also needs guards at the earlier
FFI bootstrap entry points. The new completion guard cannot undo caller-side SSH
work that has already happened:

- `ffi/server.rs:361`, `start_remote_over_ssh_connect`, inserts/reuses a bootstrap
  flow, publishes Connecting, and spawns `run_guided_ssh_connect` before reaching
  MobileClient. Guard this entry before those actions (including its cached-flow
  success path).
- `ffi/ssh.rs:492`, `run_guided_ssh_connect`, calls `SshClient::connect` and
  bootstraps the remote server before `finish_connect_remote_over_ssh`.
- `ffi/ssh.rs:78`, `ssh_connect_and_bootstrap`, independently connects and
  bootstraps remote Codex. It also needs a CLI capability guard at entry.

These files were inspected only. Generic SSH-only operations are separate from
remote CLI capability; this handoff does not recommend disabling them wholesale.
