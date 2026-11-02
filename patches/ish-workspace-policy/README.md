# Fakefs-only workspace policy — bounded handoff

**Stopped at the user's requested boundary. This is not the native-workspace
integration.** The patch rejects realfs and host bind views. Main owns a separate
host-authorized realfs extension and ordinary native-workspace roundtrip tests.
No `boot_workspace_policy_with_mounts` or typed initial-realmount API is implemented.
Do not substitute the old `ISH_BIND_MOUNTS` symlink helper or write fakefs/data
directly from ScopedFS; neither provides a coherent, enforced shared file view.

Only `patches/ish-workspace-policy/` was written in this task. Main's vendor,
bridge, phone, owned lifecycle patch and shared pinned source were not changed.
No commits, pushes, global configuration changes or dependency downloads.

## Apply order and exact revision

1. Pinned iSH `4f783cd957b83de3019d6a843408d5bb3ff902c7`.
2. `patches/ish-lifecycle/owned-session-jobs.patch`, SHA-256
   `1892642f9c916969a19944fb5780f5e98aa5b821bcfb6e7f5c652bf786846bb7`.
3. This directory's `workspace-policy.patch` (`series`).

Final policy patch SHA-256:
`34289155642eacaad5f5ac3c04e6b4fc2fb7a16cea099826a38552367668a9d4`.
It changes 33 upstream files, including descriptor-operation dispatch updates
needed to preserve original fd-operation identity behind the guards.

Strict application, reverse detection, duplicate rejection and exact reverse
restoration passed against a freshly reconstructed owned baseline:

```sh
python3 patches/ish-workspace-policy/verify.py
```

The verifier writes only into this directory and creates no Git repository or
configuration. See [verification.json](reports/verification.json).

## Host API available in this patch

Exported through `ish_embed_host`:

```rust
IshInstance::boot_workspace_policy(
    rootfs_path: &Path,
    workdir: Option<&Path>,
) -> Result<IshInstance, IshError>

instance.workspace_policy_enabled() -> bool

instance.prepare_workspace_grant(
    read_roots: &[PathBuf],
    write_roots: &[PathBuf],
    network: WorkspaceNetworkPolicy,
) -> Result<WorkspaceGrant, IshError>

instance.spawn_with_grant(
    opts: SpawnOpts,
    grant: &WorkspaceGrant,
) -> Result<Arc<IshSession>, IshError>

enum WorkspaceNetworkPolicy { DenyDirect }
```

`rootfs_path` uses the existing Rust/FFI convention: the private fakefs **data
directory**, e.g. `<private-fakefs>/data`, not the CLI `-f` parent directory.
The host enables owned jobs, performs existing bootstrap setup, seals policy,
then starts the supervisor. Readiness mode **4** is required. Existing mode 2/3
boot APIs retain their previous behavior; there is no automatic relaxed fallback.
A failed bootstrap must not be retried as an unrestricted environment.

Read/write roots are **guest paths**. They must be canonical absolute existing
directories, non-overlapping within a grant, with at least one read root and at
most 16 roots total. `/`, reserved proc/dev/sys roots, host binds, realfs views,
and unsupported network policy are rejected. Mode 4 `spawn_with_grant` requires
explicit cwd and envp and rejects PTY. Ordinary `spawn()` returns an error in
mode 4, rather than running without a grant.

`WorkspaceGrant` is opaque and single-use. Main may retain it as
`Arc<WorkspaceGrant>` in the execution lease/PreparedExecution and pass
`grant.as_ref()` to spawn. Keep it through confirmed guest cleanup and any native
lease work. The kernel keeps root reservations while bound and refuses writer
overlap. Dropping a bound handle requests deferred disposal; it does not make an
active view reusable. A completed token cannot be attached to another job.

The existing M2 session completion/termination APIs still apply. `complete` is
ownership cleanup, not successful model work or permission to publish a revision.
Main must update its adapter to call `spawn_with_grant`; this patch does not edit
PreparedExecution, the adapter, bootstrap glue or ScopedExecutorFS.

Native C ABI, for reference:

```c
int ish_ffi_workspace_policy_enable(void);
int ish_ffi_workspace_grant_create(
    const char *const *read_roots, size_t read_count,
    const char *const *write_roots, size_t write_count,
    unsigned network); /* 0 = deny direct network; other values unsupported */
int ish_ffi_workspace_grant_release(unsigned token);
```

Grant creation is a native-host entry point, not a guest syscall. The supervisor
receives `OpenGranted { reqid, opts, grant }` and uses privileged job operation 7
(`NEW_GRANTED`). Under `pids_lock`, the kernel claims the immutable grant and
arms the job; task creation inherits the grant before the child can execute.
There is no post-spawn registration interval. UID 0, env variables and command
text do not grant authority. Guest code cannot create grants or acquire the
controller task's job-control authority.

## What the fakefs boundary actually uses

This is more than a raw path-prefix check, but it is deliberately restrictive:

* Sealing audits the private backing tree without following host links, rejects
  host symlinks/hardlinks and fakefs inode aliases, and rejects inline binds and
  unknown filesystem mounts. Virtual proc/devpts bootstrap mounts remain present
  but are not generally accessible to jobs.
* Roots are checked against fakefs metadata and walked with directory descriptors
  and `O_NOFOLLOW`. Actual device/inode ancestry is retained to reject overlapping
  root objects, including aliases, as well as logical path overlap.
* Guest mount/umount and bind-helper changes are frozen after sealing. There is
  no dynamic-remount API. Controller shutdown has the existing teardown path.
* Root anchors cannot be removed/renamed by jobs. Link creation and directory/link
  renames are unsupported. Regular-file rename stays within one writable root;
  file-type checks are repeated inside the fakefs metadata transaction.
* Every traversed path component is checked before symlink/stat resolution.
  Open/mutations are checked before backing I/O. File descriptors carry job and
  permission labels across fork/dup; read/write/pread/pwrite/getdents/mmap/ioctl and
  descriptor metadata paths are guarded. Raw read/write/fstat fast paths fall
  back to guarded paths for policy jobs.
* File-backed shared mmap is unsupported, including initially read-only shared
  mappings that could later gain write protection. Private file mappings and
  anonymous same-job memory remain available.
* Proc fd reopening, ptrace, cross-job signals, named/System-V IPC and inotify
  are unavailable to policy jobs. Pipe stdio and same-job anonymous Unix
  socketpairs remain supported. Named socket destinations are rejected even
  through sendto/sendmsg on a socketpair.

There are explicit runtime exceptions: harmless null/zero/full/random devices,
selected own-process proc metadata, and basic CPU/memory/version information.
Ancestor traversal/stat metadata is permitted without granting directory listing.
The policy is not an exact implementation of every Core permission-profile
feature: main's `ExecutionPolicy.prepare` must reject shapes it cannot represent
without loss, rather than approximate or weaken them.

Direct guest IPv4/IPv6 sockets and named Unix endpoints are denied. The guards
are in emulated guest syscall/fd paths; they do not intercept trusted native
OpenAI/Web sockets. That separation was inspected in source, **not tested with
live native OpenAI/Web requests**.

Trust assumptions remain explicit: host-selected roots, a trusted supervisor and
stdio setup, private backing storage, and no out-of-band native topology mutation
while grants are held. Native tools need their own enforcement and the same lease.
This is not protection against interpreter memory-corruption vulnerabilities,
malicious native host code, or a VM-equivalent containment claim.

## Realfs integration gap owned by main

Adding an initial mount-list constructor alone is insufficient. Current code has
these deliberate fakefs-only restrictions:

* `ish_workspace_enable` rejects unknown/realfs mounts and inline binds.
* `verify_root` starts from `g_fakefs_mount->root_fd` and fakefs metadata.
* `ish_workspace_before_open` and `ish_workspace_rename` consult fakefs directly.
* `generic_openat` and `ish_workspace_tag_open` reject non-fakefs/non-whitelisted
  proc views.

A realfs extension must supply secure descriptor-relative backing operations,
resolve grants against the selected realm's root identity, handle overlapping
native views and readonly ceilings, and install mappings before sealing/starting
the supervisor. Preserve deny-unknown-mount behavior; do not merely remove these
checks to make integration run. No such extension was implemented or tested here.

## Evidence and limits

* [guest.json](reports/guest.json): final C binary passed the ordinary private
  fakefs fixture: RO read/write rejection, RW create/truncate/fsync/rename,
  private mmap, rejected shared mmap and link/directory-rename operations,
  Bash arrays, Python/Node subprocess I/O, anonymous IPC, direct socket denial,
  and missing/bound/completed grant rejection. Node also performed file I/O.
* [supervisor.json](reports/supervisor.json): actual cross-built supervisor passed
  mode-4 granted execution and missing/invalid/reused token rejection, plus mode
  2/3 smoke checks. These wire checks **preceded the final C physical-root
  identity/ancestry refinement**; they were not rerun after that refinement.
* The final C guest fixture was run after that refinement. The Rust supervisor
  source still matches the cross-build copy. C FFI compiled, and the native C
  grant API test passed on the preceding C revision; it was not rerun afterward.
* [handoff-status.json](reports/handoff-status.json) records those boundaries and
  current hashes. Rust host-wrapper compilation, final-stack supervisor rerun,
  native workspace sharing, realfs enforcement, native Web and phone acceptance
  remain unverified.

Fixtures used only this directory's copied rootfs. Two preexisting host-symlink
entries (`work`, `packages`) were removed from that copy without following them.
No unexposed-host mount intrusion probes ran. The harness initially hit iSH's
inline-argument limit and an unnecessary tty setup on pipe stdin; fixtures were
staged as ordinary guest files and terminal setup was removed. A native API test
initially passed the CLI parent path instead of the FFI data path; the corrected
invocation passed. None of those failed attempts is counted as acceptance.

Existing private-cache commands, for inspection/repetition only:

```sh
python3 patches/ish-workspace-policy/tests/run_guest.py
python3 patches/ish-workspace-policy/tests/run_supervisor.py
```

They expect the already prepared private build/rootfs. C and supervisor builds
used two jobs and cached tools/dependencies. The ignored cache retains source,
build logs and the isolated supervisor workspace; this handoff does not add a
fresh-cache build orchestrator. Main owns vendor preparation and subsequent
integration/phone validation.
