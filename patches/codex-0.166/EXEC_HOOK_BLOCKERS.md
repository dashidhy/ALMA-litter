# Why the old iOS exec hook is not ported

Follow-up: the user authorized architectural integration after reviewing this
analysis. `embedded-exec-backend.patch` now addresses constructor/registration,
backend routing and bounded event production. [EMBEDDED_API.md](EMBEDDED_API.md)
describes that experimental implementation. The real iSH adapter, policy
enforcement, bridge migration and device acceptance remain outstanding. The
analysis below describes the original baseline and is retained as design context.

All upstream line references below are against the pristine pinned 0.166 source
under `tools/alma-ios-lab/.cache/codex-rust-v0.166.0/codex-rs/`. The original hook
is `patches/codex/ios-exec-hook.patch`. These are inspected source contracts, not
claims that an alternative iOS executor was built or tested.

## Incompatible shortcut and what must stay intact

| Contract | 0.166 location | Why shifting the old hunks is wrong |
|---|---|---|
| Prepared command and effective permissions | `core/src/tools/handlers/unified_exec/preparation.rs:48`; `core/src/unified_exec/process_manager.rs:537` | `ExecCommandRequest` contains `prepared`; argv comes from `prepared.resolved.command`, with environment, permission decisions, TTY, output/yield limits and completion timeout. Restoring the former flat request discards the new preparation path. |
| Startup, ownership and approval | `core/src/unified_exec/process_manager.rs:271`, `:537`, `:622` | The normal path calls `open_session_with_sandbox`, publishes the process handle to `Completion`, monitors deferred network denial, and installs startup/collection cleanup. The old early iOS return bypasses this ownership and permission machinery. |
| Cancellation and timeout | `core/src/unified_exec/oneshot.rs:41`; `core/src/unified_exec/process.rs:257` | The oneshot path owns a child cancellation token/drop guard and terminates the actual published handle. Cancelling a `spawn_blocking` join does not stop its guest process. The old hook supplies no cancellable handle and always returns a completed response. |
| Transcript/output ownership | `core/src/unified_exec/process.rs:43`; `core/src/unified_exec/async_watcher.rs:51` | Pending output and the completion transcript now update together under one lock. Watcher `Buffer` no longer owns a transcript. Reintroducing its old transcript field is not a rebase: it creates competing output state and loses current closure/drain handling. |
| Interactive processes and lag recovery | `core/src/unified_exec/process.rs:481`; `exec-server/src/process.rs:162`, `:199` | Retained sequenced reads and pushed events distinguish exit from output closure. `write_stdin`, live process IDs, lag recovery, and late output need actual state. The old unbounded chunk channel plus `(i32, Vec<u8>)` cannot represent these states. |
| Legacy direct exec capture | `core/src/exec.rs:922`, `:982`, `:1025` | Preserve capture-policy output caps, `after_spawn`, distinct timeout/cancellation outcomes, TERM grace and process-group cleanup. The old synchronous hook forces `timed_out: false`, merges output, ignores streaming/cancellation, and runs before normal child/output handling. |

In particular, mapping `request.command` to `request.prepared.resolved.command`
and making the compiler happy would still be a lifecycle/security regression.
No `ExecProcessEventReceiver::empty()` shim, unconditional success for terminate,
`timed_out: false` substitute, or disabled cancellation branch is included here.

## Concrete cross-layer work still required

1. **Expose an embedded environment/backend integration point.**
   `exec-server/src/environment.rs:703` holds private backend/filesystem fields.
   `Environment::local` at line 789 constructs `LocalProcess` and
   `LocalFileSystem`; existing public factories select local or remote execution,
   not an injected embedded iSH backend plus filesystem. A narrow host-supplied
   construction path must preserve trusted HTTP policy and effective environment
   configuration. Do not falsely label the phone as remote or use unsandboxed
   test constructors to enter an alternate branch.

2. **Route local iOS execution through that backend even with snapshots off.**
   `core/src/unified_exec/process_manager.rs:1375` uses the backend only when
   `environment.is_remote()` or an executor shell snapshot is present. Otherwise
   it falls through to native PTY/process spawning. Merely installing a backend
   does not fix TAH: TAH is local and disables shell snapshots. A deliberate
   embedded-backend routing capability must also cover relevant direct/oneshot
   exec paths, with the existing upstream preparation, guards and collectors.

3. **Implement the actual iSH process contract.**
   `exec-server/src/process.rs:199` requires process ID, wake subscription,
   event subscription, retained `read(after_seq, max_bytes, wait_ms)`, `write`,
   `signal`, and `terminate`. `ExecBackend::start` at line 223 returns
   `StartedExecProcess`, not a final output tuple. Wire these to real supervisor
   process ownership, bounded retention, stream identity, exit/closed/failure,
   interrupt and confirmed descendant termination. Preserve env/cwd/argv,
   stdin/EOF behavior, and reject unsupported capabilities explicitly.
   `exec-server-protocol/src/protocol.rs:376` additionally carries TTY,
   `pipe_stdin`, env policy, sandbox intent and managed-network requirements.

4. **Expose a real event producer, not just an inert receiver.**
   The trait is public, but `ExecProcessEventLog` is `pub(crate)`
   (`exec-server/src/process.rs:71`); `ExecProcessEventReceiver` has private
   fields (`:162`) and only exposes `empty()`/`recv()`. An implementation outside
   that crate needs a supported bounded producer/receiver factory (or an in-crate
   adapter). Returning `empty()` compiles but violates the documented requirement
   to support pushed output and lifecycle events. Keep replay bounded by both
   bytes and event count and recover lag using retained reads.

5. **Unify tool filesystem and network enforcement with the backend.**
   The old bridge's `ish_exec.rs` special-cases native apply_patch with `LOCAL_FS`
   and ignores the provided env; `ish_runtime.rs::run_streaming` supplies its own
   runtime env to a synchronous oneshot call. Even after the other agent's shell
   and logging fixes, a complete adapter must map the same restricted guest
   workspace into `ExecutorFileSystem`, validate all parsed patch targets before
   writes, enforce at actual file operations, and retain native provider/Web
   networking separately from guest networking. Forwarding argv alone does not
   carry the role/attempt boundary. These are M2/M3/M10/M12 in the lab plan.

6. **Bind policy/bootstrap and bridge events to 0.166.**
   Use the new `InProcessStartArgs.embedded_network_policy` and current policy/auth
   bootstrap, adapt `ThreadItemPayload`, and prune/gate omitted peripheral bridge
   references. This is the later bridge work, not something a replacement
   callback in an upstream patch can complete on its own.

This requires coordinated upstream integration points, shared Rust bridge,
iSH supervisor/process control, and workspace/network policy changes. The current
write scope permits only the new patch directory; those runtime owners are
explicitly separate. The necessary backend is therefore recorded as blocked,
not implemented with old API contracts or a compiling placeholder.

## Acceptance before enabling the new lane

The integration owner should first verify actual process IDs and yield/poll/stdin,
then timeout/cancel during startup and after spawn, cancelled task drops, and
parent-plus-descendant shutdown. A continuously writing child must stop before
workspace reuse. Cover stdout/stderr flood, many tiny events, UTF-8 splits,
lagged subscribers, output arriving after exit, and bounded retention. Keep
approval/network-denial and sandbox-retry behavior intact.

Verify shell → native apply_patch → shell byte consistency and rejection of
unauthorized read/write/rename/link targets, plus restricted guest networking
while trusted model/Web requests work. Run the preserved upstream lifecycle
tests and equivalent iSH tests; a host-only mock is insufficient. Then do iOS
link/start, real subscription/Web, and foreground/background TAH acceptance.
None of these runtime checks is covered by the patch-application report.
