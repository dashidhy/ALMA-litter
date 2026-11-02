# Turn completion regressions

Run `python3 tools/alma-ios-lab/turn_completion_regression/run.py` from the repository.
No dependencies are built or added. The runner reuses cached Tokio host artifacts
and cached iOS protocol metadata; missing caches cause failure, not downloads.

The 11 tests execute the production waiter, notification mapping arms, and local
interrupt emitter extracted directly from current source. Host protocol declarations
are extracted from pinned source with serialization/schema attributes removed and
unrelated enum variants omitted. Minimal EventProcessor channel scaffolding replaces
unrelated approval handling. This is a bounded logic check, not a full client test.
The same tests also compile against actual codex-app-server-protocol, codex-protocol,
and Tokio iOS metadata (no linking or device execution).

Coverage: all four upstream statuses with/without errors; synthetic acknowledged
cancellation; interrupted/failed/in-progress with final text but no error; completed
with an error; commentary/partial/unknown/missing final phase; correct final answer;
wrong server/thread/turn; stale completion; event lag and closed stream. Source guards
check subscription before request, output_schema forwarding, use of the returned turn
ID, unchanged 60-second timeout, and the existing single stale-thread retry.

Evidence is in `evidence.json`, `host-output.txt`, and `ios-real-protocol-output.txt`.
`cargo-check-evidence.json` and `cargo-check-output.txt` record the earlier permitted
main iOS check, which passed before Main's subsequent workspace/lib/Cargo refactor.
The final full integration check belongs to Main; no fresh full check was started
after that handoff instruction. No model, device, network, or credential calls ran.

Integration surface: `UiEvent::TurnCompleted` now carries
`status: codex_app_server_protocol::TurnStatus`. Real events copy `n.turn.status`.
Both existing local completion constructors represent acknowledged cancellation
and use `Interrupted`; no synthetic error completion constructor existed in scope.
No status inference from error absence, no TAH observer, and no reducer/UI behavior
were added. Existing interruption fixtures use `Interrupted`; genuine successful
reducer fixtures use `Completed`.
