# Experimental embedded execution integration

Pinned base: Codex 0.166.0, `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`.
Patches: `embedded-exec-backend.patch`, then `embedded-guest-shell.patch`; apply via
`series.experimental`, after the two prerequisite patches and optional snapshot
patch if used. The backend patch also applies independently to pristine 0.166;
the guest-shell follow-up requires the backend patch. Strict stacked application
and reversal are verified. No production sync script is
changed. No adapter or fake iSH process implementation is included.

## Public APIs for the bridge owner

Exported by `codex_exec_server`:

```rust
Environment::embedded(
    exec_backend: Arc<dyn ExecBackend>,
    filesystem: Arc<dyn ExecutorFileSystem>,
    info: EnvironmentInfo,
    http_client_factory: HttpClientFactory,
) -> Result<Environment, ExecServerError>

EnvironmentManager::from_embedded(
    exec_backend: Arc<dyn ExecBackend>,
    filesystem: Arc<dyn ExecutorFileSystem>,
    info: EnvironmentInfo,
    http_client_factory: HttpClientFactory,
) -> Result<EnvironmentManager, ExecServerError>

Environment::is_embedded(&self) -> bool
Environment::uses_exec_backend(&self) -> bool

ExecProcessEventLog::bounded(
    event_capacity: usize,
    byte_capacity: usize,
) -> Result<ExecProcessEventLog, ExecServerError>
ExecProcessEventLog::try_publish(&self, event: ExecProcessEvent)
    -> Result<(), ExecServerError>
ExecProcessEventLog::subscribe(&self) -> ExecProcessEventReceiver

pub const EMBEDDED_ENVIRONMENT_ID: &str = "embedded";
```

The manager creates exactly one default environment named `embedded`, with no
native `local` fallback. It constructs the environment using the same explicit
HTTP factory the manager retains. A later remote upsert cannot replace this
embedded entry. `is_remote()` remains false; no fake remote connection or
test-only constructor is used in the production integration. The standalone
environment constructor is available for direct API consumers; the manager
constructor is the intended app-server bootstrap path.

Supply the real guest shell, cwd, platform, home and temporary directories in
`EnvironmentInfo`. Cwd, shell path and platform must be present. This first
version requires `EnvironmentCapabilities::default()` and rejects all capability
extensions, including snapshots and executor configuration loading. `info()` and
`force_info()` return the supplied metadata, not host detection. The host must
finish guest initialization before constructing the environment. There is no
health monitor or provisioning implementation here.

### Guest Bash default and explicit overrides

Use constructor metadata to select the guest default. For the supplied iSH Bash
package, initialize the manager with this shape (replace the cwd with the actual
guest attempt directory):

```rust
let guest_info = codex_exec_server::EnvironmentInfo {
    shell: codex_exec_server::ShellInfo {
        name: "bash".into(),
        path: "/bin/bash".into(),
    },
    executor_version: "0.0.0".into(), // custom adapter version unknown
    provider_id: None,
    cwd: Some(codex_utils_path_uri::PathUri::parse("file:///workspace/attempt")?),
    user_home_dir: None,
    platform_os: Some("linux".into()), // iSH guest OS, not the iOS host
    prepend_path_dirs: Vec::new(),
    temporary_directories: None,
    temp_dir: None,
    capabilities: codex_exec_server::EnvironmentCapabilities::default(),
};
let manager = codex_exec_server::EnvironmentManager::from_embedded(
    backend, filesystem, guest_info, http_client_factory,
)?;
```

Set this before registration; `EnvironmentReadyInfo` is for capability roots, not
shell metadata updates. Keep explicit thread selections' cwd/workspace roots
consistent with this guest mapping. Home/temp metadata can be populated with the
real guest paths when available. It does not grant access or set environment
variables; the adapter/runtime still owns env and model instructions.

`resolve_environment` consumes this `ShellInfo` for embedded execution.
`Shell::from_environment_shell_info` maps the declared name to the shell syntax
and stores the path without testing host executable existence. With no shell
override and `allow_login_shell: false`, the command becomes
`["/bin/bash", "-c", original_script]`.

The follow-up consumes an explicit `exec_command.shell` override before the
host-oriented `get_command` resolver. It detects syntax lexically and preserves
the exact guest path: `/bin/sh`, `/bin/zsh`, bare `sh`, or a guest-only Bash path
are not replaced by `/bin/bash` or a native executable. Wrappers written inside
the script remain byte-for-byte unchanged. If that executable is absent in the
guest, report the real execution error; do not substitute a different shell.
Unknown shell types or missing embedded shell metadata fail explicitly, and the
constructor rejects unrecognized shell names. Existing remote/native shell
selection behavior is unchanged by this follow-up.

See [guest-shell verification](reports/guest-shell-verification.json) and
[four focused shell tests](reports/guest-shell-tests.json). These exercise the
actual shell methods and lexical detector with type fixtures, including a path
which exists only in the guest namespace. They do not execute Bash or establish
full Codex/iOS integration; the constructor test with explicit guest metadata is
included in the patch but remains unrun in the actual upstream crate.

Pass `Arc::new(manager)` to the existing `InProcessStartArgs.environment_manager`.
Keep the actual `embedded_network_policy`, thread configuration loader, auth
bootstrap, role/attempt permissions and outbound HTTP policy. This patch neither
supplies these policies nor changes their ownership. Use `embedded` in explicit
turn-environment selections. Do not insert an unsandboxed native environment to
make old bridge calls succeed.

## Backend and filesystem obligations

Implement the **existing** `ExecBackend` and `ExecProcess` contracts. No signatures
are rolled back. `start(ExecParams)` receives portable argv/cwd, env policy/env,
TTY/stdin intent, filesystem sandbox context and managed-network enforcement
context. Preserve them and enforce every restriction, or reject before side
effects. The host constructor is trusted dependency injection, not an enforcement
wrapper. A permissive backend/filesystem remains permissive; this patch is not
proof of isolation.

`start` must be cancellation-safe before returning its handle. Do not detach a
start operation that can create an orphan after its future is dropped.
`terminate()` must confirm cleanup of the owned process tree; never implement it
as successful cancellation of a wait. Implement real `read`, `write`, interrupt,
wake subscription, exit/closed/failure and sequence behavior. Backpressure and
retained reads remain the adapter's responsibility. The unchanged contract has
no dedicated close-stdin or resize method: do not invent either or claim parity
with the host process RPC APIs.

Use a bounded event log per process. Record output in bounded retained storage
first, then publish its ordered event. New subscribers receive bounded replay
followed by live events. On `Lagged`, consumers recover using `read(after_seq, ...)`.
`try_publish` rejects oversized events without changing state; split output
chunks rather than silently discard them. Replay is capped by both count and
bytes, each live event by the byte capacity; Tokio can round the live queue count
up to a power of two. Each subscriber owns a bounded replay copy. Dropping all
producers closes live delivery. No empty receiver is used for embedded execution.

The supplied `ExecutorFileSystem` must enforce the same guest workspace mapping
and role policy as execution. Native apply_patch already uses the environment
filesystem; its sandbox-selection decision now treats embedded execution as
executor-managed, preserving its per-operation sandbox context. Parsing,
whole-patch validation and actual restricted file operations are still required.

## Unified exec and direct capture

Model-facing unified exec uses the supplied backend even when shell snapshots
are disabled. Both resumable commands and `exec_command_to_completion` retain
the upstream process manager, initial-command guard, `Completion` handle,
timeout/cancel path, denied-network monitor, bounded output/transcript buffers,
polling, stdin and final event publication. `oneshot.rs`, `process.rs`,
`async_watcher.rs` and `output.rs` are byte-identical to upstream. Embedded
output uses the existing bounded-after-exit drain mode; it is not represented as
a remote transport.

The preparation and runtime changes select executor-managed sandboxing before
launch. They forward managed-network context without entering the remote-only
branch that relaxes enforcement when an executor proxy is absent. The Linux
escalation capability check also applies to embedded executors; unsupported
restricted escalation fails rather than bypassing denied reads.

Host shell snapshots, host package PATH prepends, host shell resolution and
host-only local projections are excluded for embedded environments. Host
credential masking requires protected host shell state that an embedded guest
cannot consume. When that masking is requested with a tool network proxy,
execution explicitly fails; it does not silently run unmasked. Trusted provider
HTTP/Web continues through the caller's HTTP policy; guest network restrictions
still belong in the adapter.

For an already-authorized **direct one-shot** request, `codex_core::exec` exports:

```rust
execute_embedded_command(
    environment: &Environment,
    params: codex_exec_server::ExecParams,
    expiration: ExecExpiration,
    capture_policy: ExecCapturePolicy,
    stdout_stream: Option<StdoutStream>,
    after_spawn: Option<Box<dyn FnOnce() + Send>>,
) -> Result<ExecToolCallOutput, codex_protocol::error::CodexErr>
```

This is an explicit replacement call site for the later bridge, not a global
hook into host `execute_env`. The caller performs authorization and constructs
the real portable sandbox/network request; do not send a host sandbox wrapper
as argv. Params pass unchanged to `backend.start`. TTY, open stdin, snapshots and
executor-local proxy launch are rejected by this direct API. Managed-network
enforcement without its context is rejected before start. Use unified exec for
interactive model commands.

Direct capture uses bounded reads, distinguishes stdout/stderr, drains all pages
even if `closed` is already true, preserves the full protocol i32 exit status and explicit sandbox
denial, and reuses upstream output aggregation/capture limits/finalization.
Expiration covers startup, output and drain; timeout is distinguished from
cancellation. Failure, timeout and cancellation await termination; termination
errors propagate. Dropping the future schedules cleanup and cannot promise
synchronous confirmation: the host must keep Tokio alive and await its own
adapter/attempt cleanup before workspace reuse. As upstream specifies,
`FullBuffer` intentionally ignores exec expiration and retains all output;
model-facing capture should use `ShellTool`.

The host-only `command/exec`, `process/spawn` and `/shell` escape paths are **not
ported**. They have native-only assumptions and broader stdin/resize/full-access
contracts. With this manager they fail as unavailable because there is no native
local environment. This is the deliberate ownership narrowing; re-enabling them
would need a separate adapter and policy review, not an alias for `embedded`.

## Verification and remaining work

See [validation](reports/embedded-validation.md) and
[strict patch report](reports/embedded-verification.json).

```sh
python3 patches/codex-0.166/verify_embedded.py --output reports/embedded-verification-new.json
python3 patches/codex-0.166/tests/run_event_log_tests.py
python3 patches/codex-0.166/tests/run_capture_tests.py
python3 patches/codex-0.166/verify_guest_shell.py --output reports/guest-shell-verification-new.json
python3 patches/codex-0.166/tests/run_guest_shell_tests.py
```

The harnesses materialize the pinned tree plus verified patch in this directory's
ignored cache. They use cached packages and the repo-local stable compiler,
without downloads or global Cargo changes. Their boundary DTO/environment/error
fixtures are test-only: passing them is **not full Codex type checking**. The
capture implementation and its eleven tests are read unchanged from the patched
source; the constructor and unified routing tests require the actual upstream
crates and remain unrun.

Still required: full upstream compilation and formatting; actual constructor and
routing tests; dependency/lockfile integration; real iSH process/filesystem/network
adapter; cancellation during real supervisor startup and descendant shutdown;
auth/ThreadItem bridge migration; iOS linking and device/TAH/Web/background tests.
No build script selects the experimental patch automatically.
