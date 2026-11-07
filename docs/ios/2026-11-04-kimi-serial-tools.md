# Kimi mobile tool serialization — 2026-11-04

App **0.3.5 (11)** completed the full NVIDIA V0 on the iPhone with
`k3.1-pro / max`, Chinese output, Web enabled, and empty extra instructions.
Generation took **1567.290 seconds**. Rule Critic returned `PASS` with no issues,
both published files passed byte-length/SHA-256 verification, and all 171
pre-test journal events remained byte-identical. The run settled 86 tools,
including ordinary missing-file and Web errors that the model recovered from.
The final acceptance and power evidence are recorded below.
[Machine-readable acceptance](../../tools/mobile-tah/results/2026-11-04-kimi-serial-power.json)

The following sections retain the earlier failed iterations and the bounded
regressions used to qualify each correction.
[App version source](../../tools/mobile-tah/prepare_tauri_app.py),
[Signed build](../../tools/mobile-tah/.cache/kimi-power-ready-build.log),
[Installation](../../tools/mobile-tah/.cache/kimi-power-2026-11-04/install.log),
[Launch](../../tools/mobile-tah/.cache/kimi-power-2026-11-04/launch.log)

## Prior phone failure and recorded configuration

The NVIDIA action `850d2d27-9fc3-4052-b852-c0d234b8d19c` ran on 2026-11-04 from
06:13:58 to 06:16:53 Asia/Shanghai with provider `kimi`, model `k3.1-pro`, effort
`max`, and Web enabled. It ended with `kimi_request_limit`, nine completed tools,
and six stopped tools. The retained diagnosis and UI settings record that
model/effort pair.
[Failure diagnosis](../../tools/mobile-tah/.cache/kimi-nvidia-failure-2026-11-04/diagnosis.json),
[Recorded settings](../../tools/mobile-tah/.cache/kimi-nvidia-failure-2026-11-04/journal/mobile-ui.json)

The diagnosis attributes the failure to a parallel search burst crossing the
local active-request cap of four. The production-code reproducer rejected a
fifth concurrent request with total count four and sequential request ID five.
The phone diagnostic combines concurrency, cumulative-count, and sequence
failures under one category and omits the individual counters. The causal
assessment uses that reproducer together with the six active searches observed
at failure. The Adapter reproduction also recorded a terminal event arriving
with active lifecycle objects.
[Native reproduction](../../tools/mobile-tah/.cache/kimi-nvidia-failure-2026-11-04/repro/result.log),
[Adapter reproduction](../../tools/mobile-tah/.cache/kimi-nvidia-failure-2026-11-04/repro/terminal-repro.json)

## Scope and execution semantics

The change is scoped to tool scheduling inside the mobile Kimi backend's SDK
guest. The trusted guest entry sets `process.env.ALMA_KIMI_SERIAL_TOOLS = '1'`
before loading the SDK. The locked source patch adds a strict environment check
after batch preflight and delegates to `executeSerial`. The flag-off path uses
the upstream parallel pipeline.
[Guest entry](../../shared/tah-runtime/platform/kimi/guest/entry.mjs),
[Locked source patch](../../tools/kimi-mobile-probe/latest-source.lock.json)

For each preflighted call, the helper completes preparation, execution,
post-execution hooks, finalization, result dispatch, and yield before preparing
the next call. This includes approval adjudication and the SDK's start/result
events. Each preparation receives the original full model batch. Finalization
receives the original outcome and resolved accesses, and execution timing covers
the tool task itself.

The helper latches the preparation-time `stopBatchAfterThis` flag and settles
later calls through the existing skipped-result path. That path takes precedence
over cancellation. When cancellation reaches a queued runnable call, the helper
emits its start and synthetic aborted result through normal finalization before
advancing. Preflight-rejected calls retain their rejection path. Active execution
uses the SDK's existing cancellation handling. Tool failures, approval decisions,
hook results, and `stopTurn` continue through the SDK's existing result and
outer-loop handlers.
[SDK source](../../tools/kimi-mobile-probe/.cache/latest-release/source/packages/agent-core-v2/src/agent/toolExecutor/toolExecutorService.ts)

The original SDK model loop consumes every result from the original model batch
before its next model request. The original model prompts and frozen inference
configuration feed that loop. The same hash-locked TAH Core owns Guardian/Actor
ordering, critic, acceptance, journal, revisions, and publication. The integration
continues through `TAHFramework -> ProviderAdapter -> ProviderBackend`.
[TAH source lock](../../shared/tah-runtime/source-lock.json),
[Mobile Adapter](../../shared/tah-runtime/platform/kimi/mobile-provider.ts),
[Guest Adapter](../../shared/tah-runtime/platform/kimi/guest/adapter.ts)

## Local regression evidence

The focused suite runs the real bundled SDK and registered native tool
implementations with synthetic model/Web responses on the host. Its fixture uses
`kimi-for-coding / low`. It covers Read, Glob, Grep, Write, Edit, FetchURL, and
WebSearch, including six additional searches in one mixed batch. Wrappers record
actual native execution entry and settlement alongside normalized lifecycle
events.
[Regression source](../../tools/mobile-tah/kimi_serial_checks.mjs)

| Run | Calls | Maximum actual executions | Maximum active tool lifecycles | Result |
| --- | --- | --- | --- | --- |
| Prior SDK, serial flag set | 16 | 11 | 13 | Serial assertion fails |
| Patched SDK, serial flag set | 16 | 1 | 1 | Pass |
| Patched SDK, cancellation | 12 | 1 | 1 | Pass |
| Patched SDK, flag off | 16 | 11 | 13 | Parallel control passes |

Both retained patched runs report **3 tests passed, 0 failed**. Web resource
concurrency also peaks at one with the flag enabled and eight in the parallel
control. The success case checks all 16 native executions, ordered start/result
pairing, file contents, final text, and complete tool-call results in model order
in each subsequent model request. The prior SDK entry hash is
`a85fa13949e2b3fb9bbf08a143d122123598ecac778e97d40716cde2b1e97e78`.
[Prior SDK baseline](../../tools/mobile-tah/.cache/kimi-serial-final-baseline.tap),
[Patched run](../../tools/mobile-tah/.cache/kimi-serial-patched.tap),
[Patched repeat](../../tools/mobile-tah/.cache/kimi-serial-patched-repeat.tap)

The cancellation case starts resource execution only for `blocking-search`.
All 12 requested calls receive terminal native results and paired normalized
lifecycles. Only the first WebSearch resolves native execution, the queued Write
leaves its destination absent, and the model-request count is one. The existing
Kimi suite separately reports **12 groups passed, 0 failed**. The serial TAP logs
also retain `runtime.not_found` diagnostics from file-history checkpoint cleanup
alongside the passing assertions.
[Cancellation assertions](../../tools/mobile-tah/kimi_serial_checks.mjs),
[Existing regression groups](../../tools/mobile-tah/.cache/kimi-serial-existing-checks.log),
[Retained serial diagnostics](../../tools/mobile-tah/.cache/kimi-serial-patched-repeat.tap)

## Pinned source and fresh rebuild

The release lock contains both the permission-rules patch and serial-tools
patch, including patch-text hashes and target-file before/after hashes.
`prepare_latest.py` re-extracts the pinned archive, applies both patches with
`--fuzz=0`, builds the SDK, and verifies the packaged file inventory. The
fresh-source `--offline --rebuild` run passed with the identities below.
[Release lock](../../tools/kimi-mobile-probe/latest-source.lock.json),
[Build helper](../../tools/kimi-mobile-probe/prepare_latest.py),
[Clean rebuild evidence](../../tools/kimi-mobile-probe/.cache/serial-tools-2026-11-04/clean-rebuild.log)

| Identity | Value |
| --- | --- |
| Source commit | `2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7` |
| SDK entry SHA-256 | `5664680fdf03d133e959655ebe36d3ca0282bec4365289e4e79893c3e02a678a` |
| SDK artifact tree SHA-256 | `e16a2345d623c63a0f3d2100b54d8bbc8f50bc02d42f7cb2e8558f7acb8c8e5b` |
| SDK artifact files | 744 |
| Permission-rules patch SHA-256 | `a73d4c08efbdb59dbb732e3adc51eec83d31f27d12c8eca6a737872b3cfb9e02` |
| Serial-tools patch SHA-256 | `2ba3608334b27c7b57147660af4e9cd87582d5a5983c4ec2c3a871d71c81884a` |
| Patched executor SHA-256 | `4e07eb919901c7e3236ac5981ca0347d9d3c8a6fb6951cdeff1eafabae43f8d5` |

The archive helper now accepts the upstream `CLAUDE.md -> AGENTS.md`
documentation symlink after validating that its target is a sibling regular
file in the archive. It also validates archive paths and member types, rejects
absolute or parent-traversing link targets, and enforces the expanded-size cap.
The clean rebuild exercised extraction from the pinned archive through packaged
artifact verification.
[Archive extraction](../../tools/kimi-mobile-probe/prepare_latest.py)

## Reproduction

From the repository root, the prepared toolchain and cached source/dependency
inputs support the following checks.

```sh
node --test tools/mobile-tah/kimi_serial_checks.mjs
node --test tools/mobile-tah/kimi_checks.mjs
python3 tools/kimi-mobile-probe/prepare_latest.py --offline --rebuild
python3 tools/kimi-mobile-probe/prepare_latest.py --verify-only
```

The `.cache` links above identify local qualification evidence retained on the
host. The earlier 2026-11-03 phone publications have their own package identities
and acceptance record.
[Mobile build recipe](../../tools/mobile-tah/README.md#tauri-build-and-reproduction),
[Prior phone integration evidence](2026-11-03-kimi-integration.md)

## Device acceptance

| Check | Status | Evidence |
| --- | --- | --- |
| Signed app build, 0.3.1 (7) | PASS | [Code signing and build success](../../tools/mobile-tah/.cache/kimi-serial-build.log) |
| Device installation | PASS | [Installation log](../../tools/mobile-tah/.cache/kimi-serial-2026-11-04/install.log) |
| Device launch | PASS | [Launch log](../../tools/mobile-tah/.cache/kimi-serial-2026-11-04/launch.log) |
| First NVIDIA regression with k3.1-pro / max and Web enabled | FAILED | Action `7303a90d-bcdf-4dc2-94a7-06ec38e648a6`, 617.125 seconds, `kimi_process_failed` after 55 settled tool calls. |
| Final NVIDIA V0 on 0.3.5 (11) | PASS | Action `7822534b-e279-48a0-9096-7d27adc83db9`, 1567.290 seconds, 86 settled tools, Rule Critic PASS, two verified published files. |

## Long-run transport follow-up

The first serial phone run completed 52 tools and received three HTTP 404 tool
errors. All 55 tools had settled when the process failed. The retained native
diagnostic combines several process failures, so this run cannot uniquely
identify the underlying cause.
[First serial phone run](../../tools/mobile-tah/.cache/kimi-serial-2026-11-04/run1-result.json)

Code review found that the Kimi process adapter retained consumed stdout/stderr
for the whole attempt. Its 16 MiB cap therefore limited lifetime traffic. A
production-code host reproduction reads each 32 KiB batch immediately, yet one
additional byte after 16 MiB still produces `iSH output budget exceeded`.

Kimi now opts into `with_consumed_output()`. Its sole protocol reader acknowledges
the previous page with its next read cursor. The adapter evicts only acknowledged
chunks, reclaims their byte and count budgets, and rejects rewind or unread
cursors. A delivered page remains replayable until acknowledged. Unread output
keeps the same bound. The default shell lane retains its existing replay contract.
The event log independently retains a bounded ring. The Kimi reader uses wake
notifications and reads, with no event-log subscriber.

The adapter suite passes 24 checks, including 32 MiB transferred through a 16 MiB
retention budget, tiny-chunk reuse, slow readers, invalid cursors, closed partial
pages, and cancellation. The Kimi backend suite passes 25 checks, including the
real Kimi consumer processing 32 MiB of owned output and reaching terminal
closure. Both harnesses compile production code with explicit iSH boundary
doubles. Native iOS compilation also passes.
[Adapter checks](../../tools/mobile-tah/.cache/kimi-stream-adapter-checks.log),
[Kimi consumer checks](../../tools/mobile-tah/.cache/kimi-stream-host.log)

Process failures now map known static executor categories to specific Kimi error
codes, including `kimi_process_output_limit` and `kimi_process_output_lost`.
Unknown error contents remain excluded from diagnostics. The original phone
failure remains insufficiently detailed for unique retrospective attribution.

Stdin retains its cumulative bound because owned iSH acknowledges queue admission
without delivery acknowledgment. The lower iSH rolling output buffer also retains
its existing lag detection. These limits remain separate from consumed-output
reclamation.

## Model streaming deadline and diagnostics

App 0.3.2 (8) reached 57 tool calls in the second phone run. Fifty-five completed
and two returned tool errors. The SDK retried a model request, then returned
`kimi_turn_failed` after 830.467 seconds. Native output reclamation and request
concurrency errors did not recur. The retained generic SDK error cannot establish
the original provider error or HTTP status.
[Second serial phone run](../../tools/mobile-tah/.cache/kimi-serial-2026-11-04/run2-result.json)

Review found two total 120-second timers around model streaming, one in reqwest
and one in the outer request task. Both could terminate a response while it still
produced tokens. App 0.3.3 (9) uses reqwest's per-read 120-second timeout and gives
model requests the attempt deadline. The 30-minute whole-attempt deadline remains
authoritative across model steps, retries, and tools. Search and fetch requests
retain a 120-second total deadline. Connect and consumer-ACK deadlines also remain
bounded. Reqwest timeout errors retain the static `kimi_http_timeout` category.

The native suite passes 27 checks. Added coverage checks model/Web deadline
selection, a productive stream continuing beyond the read-timeout duration, and
an inactive stream ending with `kimi_http_timeout`.
[Streaming transport checks](../../tools/mobile-tah/.cache/kimi-stream-timeout-host.log)

The mobile adapter now classifies known SDK error causes through a bounded
eight-node chain and retains validated HTTP statuses. Retry summaries include
allowlisted error names, validated status codes, and attempt numbers. Raw error
messages and unknown text remain excluded. The adoption recipe reproduces this
mobile seam from the pinned Mac adapter sources. Its real-SDK fixture suite
passes 100 tests, covering nested errors, special statuses, cycle/depth bounds,
malformed retry metadata, and private-text exclusion.
[SDK error checks](../../tools/mobile-tah/.cache/kimi-error-classification-checks.log),
[Mobile failure mapping](../../shared/tah-runtime/platform/kimi/guest/failures.ts),
[Adoption recipe](../../tools/mobile-tah/adopt_kimi.py)

The two earlier phone failure categories lacked sufficient detail to attribute
them conclusively to the discovered transport defects. The defects are separately
reproduced and the next phone run validates the combined changes.

## Model response budget and optional SDK index

App 0.3.3 (9) ended the third NVIDIA run after 1270.870 seconds. Sixty-two tools
completed and nine returned errors, with all 71 settled before termination.
Live SDK session logs captured model-stream consumption failing with
`ChatProviderError` and `kimi_http_response_failed`. The pipe adapter had replaced
the original native category with that generic message.
[Third serial phone run](../../tools/mobile-tah/.cache/kimi-serial-2026-11-04/run3-result.json),
[Captured SDK request timing](../../tools/mobile-tah/.cache/kimi-serial-2026-11-04/run3-session.log)

The model SSE stream shared the Web response's 2 MiB lifetime byte limit. SSE
repeats JSON metadata for many small token deltas. App 0.3.4 (10) separates the
model wire-response cap at 16 MiB from the 2 MiB Web cap. Each native delivery
chunk remains at most 8 KiB and waits for its consumer ACK. The owned Kimi stdin
submission cap becomes 32 MiB to accommodate base64 transport framing. It remains
a cumulative bound. Native request and whole-attempt count/time bounds remain
enforced. The host suite passes 29 checks, including a 3 MiB model response,
bounded delivery chunks, retained Web limits, and finite model limits.
[Native byte-budget checks](../../tools/mobile-tah/.cache/kimi-long-stream-host.log)

The pipe adapter now preserves only allowlisted native failure categories, and
the SDK adapter recognizes those exact categories through native error wrappers.
Unknown response/error text stays excluded from retained public failures. The
SDK suite passes 102 tests. The three focused serial-tool checks also pass
against the final mobile configuration.
[SDK and pipe checks](../../tools/mobile-tah/.cache/kimi-long-stream-sdk.log),
[Final serial checks](../../tools/mobile-tah/.cache/kimi-serial-final-sdk.log)

Live logs also established a separate retry loop in the optional SDK session
index. Hard-link creation failed with `ENOTSUP`, followed by approximately ten
mirror-retry warnings per second. The mobile configuration now uses the official
`[database] base = false, search = false` options. The SDK reads its authoritative
session records directly. TAH continues to persist its conversations and
publications in its own journal. This configuration change is reproduced by
the mobile adoption recipe.
[SDK database options](../../tools/kimi-mobile-probe/.cache/latest-release/source/packages/agent-core-v2/src/persistence/configSection.ts),
[Live SDK index evidence](../../tools/mobile-tah/.cache/kimi-serial-2026-11-04/run3-sdk.log)

App 0.3.4 (10) passed signed build, installation, launch, and Raw Guardian. The
fourth phone V0 uses action `19a5db7b-0f87-4f5c-ab16-a869d8650192`, `k3.1-pro / max`,
Chinese output, Web enabled, and empty extra instructions. It ended with
`kimi_tool_scope_denied` after successfully writing both files. The following
approval correction addresses its two pre-creation reads. The prior individual
response errors cannot be retrospectively
attributed to the byte cap because the original category was discarded.

## Missing-file handling and Mac comparison

The fourth run tried to read its two output files before creating them. The
approval helper treated `ENOENT` on every operation except Write as a rejection.
The adapter's `policyDenied` flag then made the whole turn fail after the model
had created and checked its output. The pinned Mac Kimi adapter has the same
combination of approval and terminal handling.

The mobile helper now walks to the nearest existing ancestor for missing paths
requested through its granted file tools. Existing ancestors must pass the
same workspace and realpath checks. Write/Edit still require a writable root,
and symbolic links, hard-linked files, special files, and out-of-workspace paths
remain rejected. Authorized missing files reach the SDK's ordinary file-not-found
result. Regression cases cover Read-before-create followed by Write and normal
turn completion, missing ancestors, outside paths, writable-root checks,
symbolic-link parents, and hard links.

Mac Codex and Qoder record an ordinary tool error as `tool_completed` with
`status: failed`. That event alone does not terminate their agent loop. The Mac
conversation UI uses a warning triangle for failed tool events. Qoder also
classifies `ENOENT` as `io_enoent`. This is distinct from a rejected approval or
a whole-turn terminal failure. The final phone run reproduced both missing-file
reads as ordinary tool failures and then successfully published its results.

The Mac handoff is the same missing-path approval correction in
`providers/kimi/adapter/src/policy.ts`, together with the Read-before-create
regression. The exact imported Mac tree and commit are recorded in the source
lock. Current Mac Codex/Qoder and conversation presentation were inspected
read-only during this work.
[Mac Kimi source identity](../../shared/tah-runtime/kimi-source-lock.json),
[Mobile adoption recipe](../../tools/mobile-tah/adopt_kimi.py),
[SDK regressions](../../tools/mobile-tah/kimi_checks.mjs)

## Thinking activity and power qualification

Every native `thinking.delta` previously became a normalized activity event.
The adopted presentation tracker recomputed the working-log serialization and
hash for these events even though they added no visible content. The mobile
adapter now emits thinking liveness at most once per second using monotonic
`performance.now()`. A new model step emits immediately. Tool lifecycle, tool
progress, commentary, retries, cancellation, and terminal events retain their
original handling. No periodic timer or deferred terminal delivery is added.

The real-SDK test injects 1,024 thinking deltas and checks burst suppression,
elapsed-time boundaries, immediate step starts, event order, final text, and
cleanup. The final SDK suite passes 105 checks and the serial suite passes three.
[Final SDK checks](../../tools/mobile-tah/.cache/kimi-power-ready-sdk.log),
[Final serial checks](../../tools/mobile-tah/.cache/kimi-power-ready-serial.log)

The user unplugged the phone. Device Hub sharing was stopped for every power
window. Brightness remained 51%. Before the final Actor, two idle windows held
`Nominal` for 108.015 and 105.594 seconds respectively. All power windows used
only Power Profiler and Thermal State, attached to ALMA TAH. CPU attribution was
collected in a separate trace.

| Window | Observed power seconds | Whole-device rate |
| --- | ---: | ---: |
| Idle after cooling, 0.3.4 | 105.996 | 7.60%/hour |
| Idle before Actor, 0.3.5 | 103.008 | 7.67%/hour |
| Early Actor | 117.968 | 17.26%/hour |
| Middle Actor | 168.996 | 12.91%/hour |
| Late Actor, clipped at publication | 488.750 | 15.44%/hour |
| Post-publication portion of the final window | 148.259 | 7.98%/hour |

All windows remained `Nominal`, with zero charger-connected intervals. These are
whole-device instrument estimates from separate intervals. The Actor windows
cover approximately 12m 56s of the 26m 7s task. There is no controlled pre-fix
Kimi power trace. Rounded phone UI battery readings were 92% at Actor start and
82% when checked about 34 minutes later, including approximately eight minutes
after publication and subsequent reading. That observation is a broader interval
than the isolated Actor samples.
[Power interval summary](../../tools/mobile-tah/.cache/kimi-power-2026-11-04/power-summary.json)

The 73.146-second CPU trace contains 17.354 seconds of usable sampled weight.
iSH task-execution stacks account for 15.093 seconds, or 86.97% of that weight.
JavaScriptCore-containing stacks account for 0.831 seconds, including scavenging
and WebKit support. The modeled process CPU mean is 23.87%, with 100% representing
one core. Guest Node/V8 symbols are unresolved, so the trace cannot separate
guest work from emulation and synchronization. Stack categories can overlap,
and their shares are not battery-energy shares.
[CPU analysis](../../tools/mobile-tah/.cache/kimi-power-2026-11-04/cpu-analysis.json)

## Final phone publication

The final V0 ran from 10:34:52.025 to 11:00:59.315 Asia/Shanghai. It published
`structured-notes.md` (43,519 bytes) and `suspicious-asr-terms.md` (1,680 bytes).
The first critic round passed with zero issues. The 86 tool results include two
ordinary missing-file reads and five Web errors. All tool lifecycles settled.
The published files and full working log passed byte-length and SHA-256 checks.
The SQLite journal contains 212 events, preserves all 171 baseline rows exactly,
has integrity `ok`, and has zero pending writes. Native close/capture/release
returned successfully and this attempt's scope was removed. The phone UI also
showed the rendered latest V0 notes.

This qualification covers one complete NVIDIA V0 with the final build. The
Rule Critic checks the outcome contract. Notes factual accuracy was not
exhaustively audited. The machine-readable report retains exact hashes,
configuration, timings, sample conditions, and the scope of each measurement.
[Final acceptance record](../../tools/mobile-tah/results/2026-11-04-kimi-serial-power.json)
