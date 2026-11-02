# Opt-in iSH session job lifecycle

Pinned base: `4f783cd957b83de3019d6a843408d5bb3ff902c7`.
Apply `owned-session-jobs.patch` to that pristine tree (`series` contains the
order). All work and builds for this task stayed in this directory. No phone,
shared source/build, bridge, repository Cargo manifest/lock, or Core patch was
modified. No downloads, commits, pushes, or global configuration changes.

This is process ownership and ordinary cancellation support. It is **not a
filesystem/network boundary, VM isolation, or adversarial guest containment**.
The tests only create and cancel their own synthetic session processes; they do
not perform mount probes or host-directory intrusion.

## Adapter-facing APIs

```rust
IshInstance::boot_owned(rootfs_path: &Path, workdir: Option<&Path>)
    -> Result<IshInstance, IshError>

IshInstance::owned_jobs_enabled(&self) -> bool
IshSession::status(&self) -> SessionStatus

IshSession::terminate_owned(&self, timeout: Duration)
    -> Result<(), IshError>
```

`boot_owned` opts into kernel ownership before the init task runs. It requires the
patched supervisor's readiness version **3**. The frame layout is unchanged;
version 3 promises the stronger completion contract below. A mismatched old
supervisor/version is rejected rather than silently using process-group cleanup.

`IshInstance::boot` remains legacy mode, readiness version **2**, with the existing
process-group behavior. In owned mode the existing async `terminate()` delegates
to `terminate_owned(Duration::from_secs(10))`; legacy `terminate()` still only
sends the old request. The explicit method lets the adapter select its deadline.
Calling it on a legacy instance returns an error.

`status()` exposes retained opened/pid/exit/closed/failure state so adapters can
subscribe first and then reconcile an authoritative snapshot without losing fast
startup or failure events. `owned_jobs_enabled()` checks the opt-in contract and
instance poison state. Owned `signal()` supports SIGINT only; other signals fail
explicitly, and `Term` is the cancellation API.

In owned mode **`Closed` means all three conditions are satisfied**:

1. The session leader has been reaped.
2. Its output pipe/PTY reached EOF and buffered output was drained.
3. The kernel's job has no fork reservations or live owned task threads left.

`Exited` remains leader status, not whole-session completion. `Term` requests
cancellation; it is not an acknowledgment. A timeout, supervisor failure,
disconnect, or job-control error is an error, never successful cleanup. Retain
the session handle and do not reuse its workspace until completion is confirmed.
Dropping the last session handle requests cancellation but cannot await it.

Do not treat the existing synchronous `run_oneshot*` timeout return as ownership
acknowledgment; it retains its older timeout-return behavior. The new adapter
should hold an `IshSession` and use the explicit acknowledged lifecycle API.
Output sequence numbering is unchanged (still output-only); the Core adapter
must maintain its own consistent pushed-event/retained-read sequence as planned.

## Kernel mechanism and authority

`ish_ffi_enable_session_jobs()` is the new host C boot API, called after
`ish_ffi_become_init()` and before exec/start. It designates that exact init task
as the controller. It can only be enabled once before children exist. There is
no guest syscall to enable or acquire controller authority; uid 0, environment
variables, process names and numeric pid values do not grant it. Fork/clone
children do not inherit that authority.

The controller uses private `prctl(0x49534a42, operation, job_id, 0, 0)` operations:

| Operation | Value | Result |
|---|---:|---|
| CAP | 0 | 1 when enabled and called by controller; ENOSYS when disabled; EPERM for other callers. |
| NEW | 1 | Allocate and arm a new id for the controller's next fork/clone. Reject a second armed job. |
| DISARM | 2 | Clear a pending assignment after a failed fork. |
| CANCEL | 3 | Mark cancellation sticky and send SIGKILL only to tasks with that job id. **Request acceptance only.** |
| LIVE | 4 | Count fork reservations and owned task threads not yet through cleanup. Unknown/released ids return ESRCH, not zero. |
| RELEASE | 5 | Free an empty, disarmed job record. Otherwise EBUSY. |
| INTERRUPT | 6 | Send SIGINT only to the job’s owned tasks; no process-group/PID reuse lookup. |

Job ids are monotonic, positive, and never reused; exhaustion is an error. At
most 64 job records are retained. Assignment is performed by `task_create_`
under `pids_lock`, before the child can run. A descendant inherits its parent's
id across fork/clone, exec and process-group/session changes. Cancelling uses
that id, not ancestry walks or `kill(-pgid)`. An already cancelled job cannot
successfully reserve a new child; a child reserved before cancellation is
counted and checks cancellation before executing guest code.

Counting ends in a host pthread cleanup handler **after** the task runner's
cleanup, not when the leader becomes a zombie or its output closes. Failed fork
reservations are released separately. The callback keeps an id, not a task
pointer that may already have been reaped. If an upstream safety-valve path
leaves a thread stuck, it remains counted: the adapter gets a timeout rather
than a fabricated completed session. A zero LIVE value immediately after NEW is
not a completion certificate: the job is still armed. The supervisor disarms or
cancels before release/acknowledgment.

Native host-process offload is bypassed for owned tasks. Registered offloads do
not provide the required descendant ownership contract; owned commands run in
the guest interpreter instead. Legacy jobs retain the old offload behavior.

The standalone C CLI has a host-only test opt-in,
`ISH_ENABLE_SESSION_JOBS=1`, applied before running the initial guest task. The
CLI does not copy this variable into guest startup environment. Production Rust
embedding uses the FFI boot API, not guest environment configuration.

## Supervisor behavior

Each owned `Open` arms a kernel job immediately before fork. A failed guest cwd
change is reported before exec instead of using a fallback cwd. Fork errors disarm
and release its reservation. The supervisor retains the job after exec errors
until cleanup completes. A leader's normal exit also cancels its outstanding
background descendants: they belong to that session's lifetime. There is no
implicit transfer to a future attempt or another session.

Owned stdin uses a nonblocking queue capped at 1 MiB. Overflow and write failures
are reported. Cancellation clears pending input and closes its writable pipe;
discarding pending bytes during cancellation does not produce a spurious
broken-pipe session failure. Owned output draining is limited to four 32-KiB
chunks per stream per loop pass so ordinary output cannot indefinitely starve requests.
Legacy stdin/output handling is unchanged.

Owned non-PTY sessions now have separate stdout/stderr pipes using the existing
wire Stream variants; Closed requires EOF on both. Legacy mode retains merged
output, and PTYs remain merged. Tests verify both markers, stream identity and
the real exit code. There is still no write-delivery acknowledgment or close-stdin RPC. The host
must keep reading the response pipe: a blocked host transport can still prevent
supervisor progress, and the explicit termination deadline then returns an error.

## Validation and reproduction

```sh
python3 patches/ish-lifecycle/verify.py
python3 patches/ish-lifecycle/build.py
python3 patches/ish-lifecycle/tests/run_guest.py
python3 patches/ish-lifecycle/tests/run_supervisor.py
```

The build reuses the existing local Meson and stable Rust 1.99 toolchain, creates
its own C build, and cross-builds the real Rust supervisor for AArch64 Linux musl.
The supervisor uses a private two-member workspace (protocol + supervisor) and
an offline cache resolution. This avoids unrelated unavailable host-workspace
dependency metadata; it is not a reproduction of the pinned workspace lockfile.
The original workspace manifest/lock stay unchanged in the delivered patch.

Tests copy the existing augmented rootfs into `.cache/rootfs`. They use no extra
host bind mounts. Kernel cases have a 30-second wall timeout; wire cases have
six-second frame/write deadlines and a 40-second per-mode ceiling. Cleanup only
targets the newly spawned test host process group. The control fixture and
session children operate only inside this copied guest filesystem.

Evidence: [source/patch checks](reports/verification.json),
[build](reports/build.json), [kernel cases](reports/guest-results.json),
[actual supervisor wire cases](reports/supervisor-results.json),
[validation limits](reports/validation.md).

## Limits and future policy integration

The Rust host-wrapper changes are **not compiled or exercised** here: the cached
complete host dependency graph is unavailable. The C FFI compiles, the C kernel
and real cross-built supervisor run, and their wire acknowledgment is tested.
The adapter still needs host-wrapper/iOS compilation, actual `ExecProcess`
integration and device acceptance. Arbitrary stuck syscalls, multithreaded guest
runtime stress, transport failure recovery and adversarial guest interference
are not established by these ordinary-process tests.

Job identity could later be an input to a trusted FsGate/policy lookup at actual
file/network operations. That would need a host-authorized job-to-policy binding
and enforcement for each operation, along with protection of controller state
and IPC. No such policy interface or enforcement is implemented here. Existing
guest signals, proc access, mounts and shared runtime vulnerabilities are not
made safe by adding lifecycle ownership. This patch's privileged job-control
entry point is narrowly checked; it is not a general isolation claim.
