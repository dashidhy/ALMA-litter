# Readonly parent with writable candidate

Apply `readonly-parent-candidate.patch` **after** the existing owned-job,
workspace-policy and native-workspace patches. It targets the currently prepared
`.build/vendor/litter-ish-owned` baseline recorded in `baseline.json`; the actual
vendor and shared preparation script were not modified.

Only `kernel/workspace_policy.c` changes. Same-grant overlap is accepted only for
a strict RO ancestor and an explicitly RW descendant. Both lexical direction and
the entire retained device/inode ancestry prefix must agree. Identical physical
roots, duplicates, RO/RO nesting, RW/RW nesting and RW-parent/RO-child are rejected.
Cross-grant overlap/conflict checks are unchanged, including held unbound grants.

Runtime rights still OR matching grants. An RO parent therefore supplies whole
view reads/listing while only the candidate contributes write authority. This is
not general longest-prefix behavior. Existing root-mutation, no-link, directory
rename and same-RW-root regular-file rename restrictions remain unchanged.
No Rust API, supervisor wire protocol, mount setup, or ownership lifecycle changes.

Use the existing host-selected grant API:

```text
Guardian RO: runtime directories, /workspace/view
Guardian RW: /workspace/scratch

Actor RO: runtime directories, /workspace/view
Actor RW: /workspace/view/outbox/revision_v1, /workspace/scratch

prepare_workspace_grant(read_roots, write_roots, DenyDirect)
spawn_with_grant(options, &grant)
```

The controller must keep native directory topology immutable during the grant.
This adds no guest ability to assign grants, remount, or select host sources.
Different grants with conflicting parent/candidate views still cannot coexist;
completion and release must precede reuse.

## Verification

Run from the repository root:

```sh
python3 patches/ish-ro-parent-candidate/run.py
```

The runner copies the current prepared source and packaged rootfs into its own
ignored `.cache`, strictly checks/applies/reverses the patch, and builds the Mac
C kernel with two jobs. Every command has an external deadline of at most 180
seconds; guest fixtures use 45 seconds and native CPU/core limits. The private
cache is capped at 2 GiB. No dependency downloads are used.

`reports/result.json` records actual results, hashes and per-run host timing:

- Strict `git apply --check --whitespace=error-all`, reverse check, actual reverse
  restoring the exact baseline, and reapplication; exactly one patched path.
- Five synthetic identity checks using the actual extracted C helper functions.
- Actual host grant registration accepts the RO-parent/RW-candidate pair, rejects
  duplicates and all other overlap directions, and preserves cross-grant conflict
  rejection and release behavior. These use only the registered private fixture.
- Real Guardian guest: whole-view reads, Bash `ls`/`find`, input/prior/candidate
  write rejection and independent scratch writes (nine checks).
- Real Actor guest: whole-view reads and `ls`/`find`, candidate directory/file
  writes/fsync/regular rename, input/prior write rejection, cross-root/root and
  directory rename rejection, and link-creation rejection (14 checks).
- Trusted Python PID1 claims the immutable grant before spawn, confirms the sealed
  owned-job capability, rejects premature release, observes zero live owned tasks,
  releases the job, and rejects retired-grant reuse. Native host readback confirms
  the candidate output and unchanged readonly files.

This exercises the actual sealed kernel/granted-job path used by mode 4. It does
**not** rerun the Rust mode-4 supervisor wire suite, compile the Rust wrapper, or
qualify phone/model execution. All supervisor/host sources are unchanged. No
unexposed-host mount, VM escape, auth, network or phone probes were performed.
