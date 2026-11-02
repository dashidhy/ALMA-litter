# Unintegrated iSH ExecBackend: contract regression and handoff

Production source: `shared/rust-bridge/codex-mobile-client/src/ish_exec_backend.rs`.
This module is intentionally **not declared in lib.rs or wired into bootstrap**.
No Cargo manifest, old exec hook, runtime, Core patch or ScopedExecutorFS was
changed for this backend task. Main owns that integration and full compilation.

The module imports the real `codex_exec_server::{ExecBackend, ExecProcess}` and
`ish_embed_host::{IshInstance, IshSession}` APIs. It requires the latest
`patches/ish-lifecycle/owned-session-jobs.patch` and the already applied Core
embedded-environment/event-producer APIs. The lifecycle patch now exposes:

```rust
IshInstance::boot_owned(rootfs_path, workdir)
IshInstance::owned_jobs_enabled(&self) -> bool
IshSession::status(&self) -> SessionStatus
IshSession::terminate_owned(&self, timeout: Duration) -> Result<(), IshError>
```

Mode 3 has separate stdout/stderr for non-PTY sessions, kernel-scoped Interrupt,
and `Closed` only after owned tasks finish and both output pipes drain. An owned
spawn with a failed guest `chdir` fails before executing the command; it does not
silently use the supervisor's cwd. Use a matched, patched host/supervisor build.
The retained status snapshot includes opened/pid/exit/closed/failure, including
events that arrived before subscribing.

## Required construction and policy contract

```rust
IshExecBackend::new(
    instance: Arc<IshInstance>,
    policy: Arc<dyn ExecutionPolicy>,
    cleanup_timeout: Duration,
) -> Result<IshExecBackend, ExecServerError>
```

There is no default or permissive production policy. A legacy/poisoned iSH
instance is rejected; execution requires a Tokio runtime and rechecks known
readiness after policy preparation. Cleanup deadlines must be nonzero and at
most 120 seconds. `start` has a separate ten-second startup deadline, not a
ten-second command lifetime.

The caller supplies:

```rust
trait ExecutionPolicy: Send + Sync {
    fn prepare<'a>(&'a self, request: &'a ExecParams)
        -> Pin<Box<dyn Future<Output = Result<PreparedExecution, PolicyError>> + Send + 'a>>;
}

struct PreparedExecution {
    options: ish_embed_host::SpawnOpts,
    lease: Box<dyn ExecutionLease>,
}

trait ExecutionLease: Send + Sync {
    fn not_started(self: Box<Self>);
    fn complete(&mut self) -> Result<(), PolicyError>;
    fn quarantine(self: Box<Self>);
}
```

`prepare` must implement actual enforcement and readiness, including the full
filesystem sandbox context, managed-network intent, guest cwd/argv, environment
inheritance/filtering/overrides, and exclusive attempt ownership. Unknown or
unsupported restrictions must be rejected. It must also clean up if its future
is cancelled before returning. Merely implementing this callback does **not**
prove any of those constraints are enforced. No real enforcement implementation
or FsGate is supplied in this task; that remains a prerequisite to production use.

The adapter checks that the provider preserves argv, cwd and stdin intent and
supplies an explicit, valid environment containing each requested overlay value.
It will not silently inherit the supervisor environment or rewrite an explicit
shell wrapper. The provider must separately enforce `env_policy` using the
trusted guest baseline, never the app's process environment.

Lease methods must be bounded/nonblocking and must not release on ordinary Drop.
`not_started` means Open was never queued. `complete` means ownership cleanup was
confirmed, including after execution failure or cancellation; it does **not**
mean successful model work or authorize publishing a revision. If complete
fails, cleanup is unconfirmed, or the runtime shuts down with an outstanding
lease, `quarantine` must preserve the no-reuse boundary beyond object lifetime.
The adapter cannot enforce that persistent boundary on behalf of its provider.

Pass this backend and the separately enforced filesystem to Core's
`EnvironmentManager::from_embedded`. Main must still provide the network bootstrap
policy, guest Bash metadata, role policy and attempt mapping. The backend does not
alter subscription auth, model instructions or the app's environment.

## Execution and output semantics

* Start subscribes before the first retained read/status snapshot. Fast output,
  fast completion and a failure before subscription are reconciled from state.
  A handle is returned only after the real session reports opened.
* The collector owns a new monotonic sequence for every Core `Output`, `Exited`
  and `Closed`. iSH's output-only cursor is maintained separately. Partial iSH
  pages advance by the last chunk actually consumed, not its global `next_seq`.
* Core replay and retained reads use the same chunks and sequence assignments.
  Lifecycle changes can occur between output chunks. Paged Core reads return a
  cursor at the end of that page rather than skipping unread retained output.
* iSH broadcast events are wakeups; authoritative retained reads recover lag.
  If iSH reports already-lost retained bytes, execution fails explicitly and
  cleanup is requested. No empty event receiver is used.
* The initial implementation has a **hard output budget** of 1 MiB / 4,096 chunks,
  splitting chunks to at most 8 KiB. Exceeding it fails and terminates the owned
  session; it does not silently truncate. This is a deliberate current limit,
  not a general streaming/large-output acceptance claim.
* Core's requested read size is a whole-chunk budget: the first chunk may exceed
  a smaller requested cap, up to 8 KiB. Wait hints are bounded to 60 seconds.
* Stdin accepts only sessions requested with `pipe_stdin`, with a 32-KiB chunk
  limit and 1-MiB lifetime submission budget. The budget is charged before
  enqueue, so concurrent/cancelled writes cannot grow the host's unacknowledged
  queue without bound. `Accepted` means queued, not consumed by the child.
* Interrupt uses the mode-3 kernel job's SIGINT operation. Termination waits for
  owned cleanup and lease finalization. Unconfirmed cleanup or lease-finalization failure does not report Closed;
  its lease is quarantined and its process id stays reserved. An execution error
  may coexist with confirmed Closed: the error remains visible to Core.
* There are at most 64 active/reserved ids per backend, each at most 128 bytes.
  Successful cleanup releases the id. A backend full of quarantined sessions
  rejects new starts until the embedding owner reconciles/replaces it.
* Dropping a start future after Open, or dropping the last process handle,
  requests cancellation while the independent collector retains the session and
  lease. Runtime shutdown cannot establish cleanup and quarantines instead.
* iSH signal exits are mapped to conventional `128 + signal` codes. Ordinary
  exit codes are retained. `sandbox_type`/denial classification is not fabricated.

The initial adapter requires an absolute guest executable, normally `/bin/bash`
from the reported ShellInfo. Pinned iSH uses `execve` without PATH lookup. A bare
`sh`/program override is rejected rather than resolved through the host or silently
rewritten; explicit `/bin/sh`/`/bin/zsh` argv remains intact. Commands inside a
Bash script still use the guest shell’s normal PATH semantics.

Unsupported capabilities fail before Open: PTY, shell snapshots, executor proxy
launch, and Core's `arg0` override. The last is intentional: pinned iSH interprets
its `arg0` option as the **executable path**, whereas Core uses process-visible
argv0. Passing it through would execute the wrong program. There is also no
close-stdin or resize method in the current Core process contract. The default
`start_with_network_policy_decider` refusal remains intact.

The module contains no plaintext logging; failure strings are fixed categories.
This does not audit logging inside the caller's policy provider or the rest of
the application.

## Tests and exact evidence boundary

```sh
python3 tools/alma-ios-lab/backend_regression/run.py
```

The runner compiles the **unchanged production module** with the actual Core
producer/trait source and explicit boundary fixtures. The iSH instance/session,
protocol DTOs and policy in `fixtures/` are test doubles confined to synthetic
`/fixture/owned` paths; they neither access host workspaces nor prove enforcement.
They are not linked into the production module.

Fifteen tests cover initial replay and own sequencing, partial-page cursor
correctness, wake-channel lag, lost iSH retention, hard output limits, dropped
start/policy futures, unacknowledged cleanup, stdin/Interrupt, startup failure,
lease-finalization failure, runtime shutdown, readiness/capability/policy/env
rejection, total stdin budget and active-process capacity. The initial paging
test incorrectly expected one 64-KiB response to contain all retained output;
it was corrected to drain every page and assert all 262,144 bytes and unique
output sequences. No failing run is counted as passing evidence.

See [results.json](results.json) for the module and actual Core-source hashes,
compiler output and test result. This is **not** compilation against the full
real dependency graph or execution of the adapter against a real `IshSession`.
The separate lifecycle tests do run the real patched C kernel and cross-built
Rust supervisor, but do not close that adapter integration gap.

Outstanding: main's module/Cargo wiring, real patched iSH host-wrapper compilation,
full 0.166 trait/type checking, actual policy/lease + ScopedExecutorFS enforcement,
real adapter regression with owned sessions, iOS linking/device work and TAH.
The current Iroh/Netwatch dependency issue is outside this task and was not modified.
