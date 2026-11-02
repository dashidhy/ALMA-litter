# Phone TAH runner handoff

Only the new `src/tah_runner.rs` and this regression directory were written.
Main owns module/export wiring, workspace scope, prepared inputs, Swift, final
Cargo integration and external cleanup. No dependency or existing file changes.

Entry points (crate-visible, async):

- `tah_runner::inspect(server_id: String, actual_account_fingerprint: String) -> serde_json::Value`
- `tah_runner::run(server_id: String, actual_account_fingerprint: String) -> serde_json::Value`

Both require a prepared attempt and a lowercase SHA256 fingerprint equal to its
expected fingerprint. Swift must derive that fingerprint from the same OAuth
account used by the app; the Rust runner never receives or returns a raw account ID.
Only a local session exposing exactly the `codex` runtime is accepted.

Inspection performs real typed account/read (without proactive refresh), bounded
model/list pagination and account/rateLimits/read when invoked. It exposes only
validChatGPT, curated model IDs/default/efforts, and the original quota wire fields
used by the Mac usage normalizer. It excludes accountId, reset-credit details,
opaque upsell metadata and unknown fields. It does not claim auth inspection passed
on behalf of the original host receipt builder. No RPC was executed during this work.

Run permits exactly one submission per process, consumes its gate even on failure,
subscribes to raw session ServerEvent before inspection/thread/turn, bypasses mobile
model normalization, requests ephemeral thread + developer instructions separately
from user turn input, explicitly disables provider model fallback, and checks the
returned model/cwd/ephemeral/effort and actual turn ID. With no explicit effort,
the returned effort must match the selected catalog model's default.

Report fields: outcome (`observed` or `failure`), identity, inspection,
threadReceipt, turnReceipt, notifications, terminal, cancellation, and failure
where applicable. `observed` means a transport observation, NOT TAH acceptance.
The notifications are `{kind:"notification",method,params}` native Codex frames
for the ORIGINAL Mac CodexEventNormalizerV1. No normalized TAH events are generated.
Reasoning items (including nested turn items), all reasoning deltas/summaries,
raw-response frames, account events and token-usage events are omitted. Other
scoped unsupported notifications fail closed, including model reroutes.

An actual Completed/no-error TurnCompleted and exactly one final_answer matching
an ItemCompleted receipt are required. Idle is never completion. Events are bounded
at 10 MiB (serialized array bytes), final text by maximum_final_bytes, and total
attempt time at 180 seconds (175 seconds plus up to five for turn/interrupt).
Requests/legacy events/wrong runtime/lag/closure fail closed. Unrelated thread/turn
frames are excluded. Already-buffered tail output is checked, but future tail,
quiescence, candidate file capture and OS process exit belong to Main/host cleanup.
On failure, turn/interrupt is attempted if authoritative IDs are available; a lost
turn/start reply can recover the ID from a queued TurnStarted. If IDs are missing,
the report explicitly records cancellation unavailable. Acknowledgment is not exit.

Verification:

- `python3 tools/alma-ios-lab/tah_runner_regression/check.py`: entire actual runner
  and nine regression tests type-check using cached REAL iOS upstream protocol,
  Tokio and serde metadata. Only surrounding app/session shell is stubbed.
  Tests compile but do not execute in this lane.
- `python3 tools/alma-ios-lab/tah_runner_regression/host_check.py`: six pure production
  boundary helper tests execute using existing compatible cached host serde artifacts.
- No model/device/network/credential calls, full build, code generation, or commit.

Unverified: final crate/UniFFI integration, actual server RPC/event execution,
end-to-end Mac normalizer replay, cancellation delivery, quiescence and process exit.
