# Validation — 2026-11-01

All execution used a private scratch source/build/rootfs under this patch directory.

| Check | Result |
|---|---|
| Source pin | Archive SHA-256 and every extracted source entry verified against the supplied pinned tree. |
| Patch applicability | Strict forward/apply/reverse checks passed; duplicate forward application rejected; reverse restored pristine bytes. |
| Private C kernel/CLI build | Passed; real, nonempty ARM64 Linux VDSO checked. |
| C FFI shim compilation | Passed against the patched headers/kernel interfaces. |
| Rust supervisor cross-build | Passed with stable 1.99 and cached dependencies; existing signal-handler cast warning remains. |
| Kernel fixture in real iSH | Six cases passed: stdin/stdout/stderr/exit 7; nested child in new POSIX session; leader exit + EOF with remaining descendant; scoped cancellation leaving the second test job usable; non-inherited controller authority; cancellation during a finite spawn loop. |
| Actual Rust supervisor in real iSH | Owned mode 3 passed normal I/O, automatic descendant cleanup after leader exit, termination with 256 KiB queued to a non-reading child, sibling-session survival, and owned Interrupt. Owned stderr is separately tagged; a missing guest cwd fails without Opened/output, then reaches owned Closed. Legacy mode 2 normal I/O/exit/Closed passed. |
| Rust host wrapper / whole embed workspace | Not compiled. Upstream lock references uncached Tokio 1.52.1; fresh offline full-workspace resolution also lacks `redox_syscall`. No dependency download or fabricated package was used. |
| iOS/phone, real adapter, full TAH | Not run. |
| Filesystem/network isolation, mount escape tests | Not implemented or tested. |

The first owned supervisor backpressure test caught a real issue: pending stdin
flushed after cancellation generated an EPIPE error even though cleanup was
progressing. Cancellation now clears its queue/closes input, and the test passed
after recompiling the supervisor. This was not treated as a passing first run.

Kernel live counts—not shell process-group membership or output EOF—determine
ownership completion. The wire tests validate the actual mode-3 supervisor
sequence. They do not establish every possible scheduling interleaving or prove
the uncompiled Rust host wrapper's async acknowledgment path.
