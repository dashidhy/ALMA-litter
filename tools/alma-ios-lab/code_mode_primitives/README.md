# Packaged Node Code Mode primitive checks — frozen handoff

Actual packaged **Node v22.23.4**, running inside the unchanged Mac iSH
`patches/ish-native-workspace/.cache/native-ish`, passed the requested **16
primitive cases across the recorded runs**. Two separately labeled per-cell
process alternatives also passed. This is not a provider, protocol implementation,
security review, or phone/model qualification.

The authoritative compact handoff is `handoff.json`. It references the original
reports without replacing failures with later successes.

| Cases | Result | Host wall time | Report |
|---|---|---:|---|
| Fresh SourceTextModule, top-level await, static/dynamic import rejection, ordinary scratch write/read | 5 passed | 5.2567 s | `results.json`, modules |
| Exact upstream settled.js and six unchanged upstream fixture sources | 6 passed | 5.3970 s | `results.json`, settled |
| Worker process.exit: catch/finally/microtask suppression; exit before an infinite loop | 2 passed | 7.5219 s | `results.json`, exit-sync |
| Worker process.exit: after top-level await; inside an awaited timer | 2 passed | 7.5908 s | `results.json`, exit-async |
| Ready/start handshake, CPU loop, parent-timer Worker.terminate, resolved termination promise | 1 passed | 7.2527 s | `cpu-handshake-results.json` |
| Separate process exit, prior output/write-set preservation | 1 passed | 4.8676 s | `process-alternative-results.json` |
| Separate process CPU loop, trusted owned-job cancellation | 1 passed | 4.4090 s | `process-alternative-results.json` |

These are individual host run durations, including trusted Python controller and
Node startup/teardown. They are not phone performance measurements or one combined
benchmark. The successful Worker CPU check was a later targeted run; the other
15 primitive cases were not rerun after the CPU handshake change. The unchanged
case bodies and each run's test-source hashes are retained in the reports.

## Important findings and limits

**A ready/start barrier matters.** The original CPU Worker posted a startup
message and immediately entered its loop. The parent did not reach the observed
message/termination stage; native RLIMIT_CPU stopped iSH at 20.1168 seconds. An
instrumented repeat stopped at 20.0991 seconds with the last parent phase
`worker-constructing`. This does not prove that Worker.terminate itself failed:
the test never reached that call. The precise underlying cause was not diagnosed.

The corrected primitive starts an idle Worker, receives `ready`, arms a parent
termination timer, then sends `start-loop`. The Worker records loop entry in
private scratch and posts its loop message. The parent reaches
`terminate-requested` and `terminate-resolved`; the Worker exits with code 1.
The trusted controller then confirms zero live owned tasks and releases the job.
A future provider must initialize control before running cell source and retain
an independent owned-job/host fallback. The initial early-start failure remains
an explicit limitation; one passing handshake case is not exhaustive lifecycle
qualification.

**The requested exit behavior works in these four fixtures.** Each Worker sends
ordinary `postMessage` output and store records before `process.exit(0)`.
The parent compares all messages after the Worker exit event. Only prior output,
the prior store write, and the exit marker remain; catch/finally/queued microtask
or following source do not execute. This tests a native process.exit binding in
a cell context, not a catchable sentinel exception. The full official exit/getter
matrix, callback drainage, concurrent store commits, output pressure and races
remain untested.

**The process alternative is distinct.** A separate Node process emits a complete
prior output/write-set frame with synchronous pipe writes, then exits normally.
A different owned process enters a CPU loop; trusted PID1 cancels its job and
observes SIGKILL plus zero live tasks. A future Rust provider can own the committed
session snapshot and merge a cell's write set only after confirmed completion;
no synchronous store RPC is required. No authoritative Rust store was implemented
or tested here.

**Use pipe stdio.** An initial fixture mistakenly supplied `/dev/null` opened by
the unowned controller. The current policy permits controller-provided anonymous
pipe stdio, not that inherited device handle. Even simple Node startup aborted.
Changing only fixture stdin to a pipe resolved startup and the module checks;
`stdio-diagnostic-results.json` and `stdio-fixed-results.json` preserve both
observations. The earlier controller disarm call also omitted its required job
ID; `controller-fix-history.json` records that fixture error. Neither issue was
fixed by weakening policy or editing shared code.

## Execution boundary

- A private rootfs copy and native fixture live only under this directory's ignored
  `.cache`. Fakefs controller installation uses guest filesystem APIs.
- The unchanged harness mounts only this private fixture at `/workspace` before
  policy sealing. That name is a test mapping, not an application/model workspace.
- Read grants: `/bin`, `/sbin`, `/usr`, `/lib`, `/etc`, `/workspace/input`.
  Write grant: `/workspace/tmp` only. Host registration uses direct-network deny.
- Trusted PID1 claims immutable grant 1 with prctl operation 7 before spawning.
  All Node children/Workers inherit the owned job. No WorkspacePolicySemaphore
  or model workspace grant is used.
- Each native iSH process has CPU limits **20 seconds soft / 24 seconds hard** and
  core dumps disabled, set before exec. An external host watchdog kills only that
  process group at **30 seconds**; bootstrap uses 10 seconds. Guest controller
  deadlines and zero-live acknowledgment are additional checks.
- Every passing run reports owned cleanup confirmation and disappearance of its
  native process group. CPU-limit failures confirm native process-group death,
  **not** a guest owned-job completion acknowledgment.
- Source rootfs, shared executable, and upstream JS/test inputs have before/after
  hashes confirming no changes. No shared patch, vendor, bridge, phone, auth,
  model, network, unexposed-host or VM-escape probes were used.

Node's observed flags include the existing iSH additions `--no-lazy` and
`--max-old-space-size=512`, as well as requested `--jitless` and
`--experimental-vm-modules`. This is evidence for the packaged runtime with those
flags, not arbitrary Node builds. The old-space flag is not a total memory limit.

## Reproduction

From the repository root, using the existing cached inputs only:

```sh
python3 tools/alma-ios-lab/code_mode_primitives/run.py
python3 tools/alma-ios-lab/code_mode_primitives/run.py --groups process-exit process-cpu --report process-alternative-results.json
```

The default suite now includes the corrected handshake. These commands operate
only on this directory's scratch copy and reports; they do not compile or modify
the shared harness. `settled.js` and the six fixture sources are read from the
pinned Codex source and copied into the private readonly fixture. No dependencies
are installed. Work is frozen at this handoff; no provider decision or integration
is implied.
