# Scoped file primitive regression

The maintained source is `ALMA-codex/ios/native/src/scoped_files.rs` in the sibling
fork. The retained runner now reads that source and the fork's pinned Codex
release. Current TAH build and acceptance status is in the
[mobile TAH guide](../../mobile-tah/README.md).

## Historical 0.166 implementation record

The observations, source paths and integration status below describe the earlier
implementation stage. They are not a fresh qualification of the current package;
consult the dated milestone record for checks actually rerun during cleanup.

The implementation is
`shared/rust-bridge/codex-mobile-client/src/scoped_files.rs`. It is not declared
in `lib.rs`. The separate `scoped_executor_fs.rs` adapter now implements the
actual Codex 0.166 trait (see `../scoped_executor_regression/README.md`), but
neither is wired into iSH, guest mounts, or application flows. Runtime integration and guest policy remain with
the main implementation owner. This is a native Unix file API, not a security
boundary against arbitrary same-process code or a claim of VM equivalence.

## API

All operations return `std::io::Result`; paths use `&Path` and preserve name
bytes. Except for the trusted root constructor, paths must be relative.

| API | Behavior |
| --- | --- |
| `ScopedFiles::open(trusted_root, Access::ReadOnly/ReadWrite)` | Open an existing host-selected directory and retain its descriptor. The host controls root resolution and ancestors. |
| `access()` | Return the fixed authority. No authority escalation or raw-fd accessor. |
| `read_file(relative, max_bytes)` | Open without following links, verify the opened fd is a regular file, read at most limit+1 bytes, and reject oversized content rather than returning partial content. |
| `atomic_replace(relative, contents)` | Create a fresh same-parent temporary inode, write all bytes, sync the file, then `renameat` over the destination. Parents must exist. |
| `remove_file(relative)` | `unlinkat` one non-directory entry; no recursion. Missing entries are errors. |
| `create_dir(relative)` | `mkdirat` one directory, mode 0700 subject to umask. Existing destinations and missing parents are errors. |
| `create_dir_all(relative)` | Create missing parents using directory fds and no-follow opens. May leave created parents on native I/O failure; adapter preauthorizes policy before invoking it. |
| `metadata(relative)`, `root_metadata()` | Descriptor metadata for regular files/directories or the retained root. No symlink/special-file metadata support. |

All mutations check write authority before traversing paths. The parser
rejects absolute paths, `..`, NUL, empty paths/components, `.` components,
repeated separators, and trailing separators. These inputs are rejected
before operation-specific filesystem access. A leading slash is absolute
under this POSIX contract; backslashes are ordinary filename bytes.

Traversal clones the retained root fd and opens each parent using
`openat(O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)`. Reads use `O_NOFOLLOW` on the
leaf, then descriptor metadata rather than a path recheck. `O_NONBLOCK` and
`O_NOCTTY` avoid waiting on a FIFO or acquiring a controlling terminal before
the regular-file check. No canonicalize-then-open or string-prefix check is
used for authorization.

Replacement never opens the destination inode for writing and never uses
`O_TRUNC`. Exclusive temporary creation uses `O_CREAT | O_EXCL | O_NOFOLLOW`,
mode 0600 subject to umask, and bounded name-collision retries. Both arguments
to `renameat` refer to the same already-open parent. An existing final symlink
is replaced as an entry, not followed. Removal similarly unlinks a final
symlink itself. Parent symlinks are not traversed. These are implementation
properties, not adversarial-test claims.

## Controller contract and limitations

- Root and authority selection are trusted host decisions, never model/tool
  arguments. The module cannot restrict another same-process caller that uses
  other filesystem APIs.
- The controller must keep untrusted processes from changing ancestor
  directories, mount topology, or temporary entries while operations are in
  flight. It must define guest rename/link/mount and concurrent-writer policy.
  A directory fd remains usable after a rename; `O_NOFOLLOW` does not establish
  ongoing ancestry under arbitrary namespace changes.
- The controller must decide which existing hard links and special files may
  exist in a scope. Read metadata rejects nonregular descriptors, but opening
  a special file precedes that check. This helper is not a guest syscall filter.
- Atomic replacement preserves the old inode for existing descriptors or hard
  links. The new inode does not inherit the old file's mode, ownership, ACLs,
  or xattrs through this API. Native filesystem inheritance still applies.
- The temporary file is synced before rename. The parent is not synced, so
  success promises completed atomic replacement, not power-loss durability.
  Cleanup on ordinary pre-rename failures is best effort; process termination
  can leave `.alma-scoped-write-*` entries. Recovery policy is not implemented.
- Reads are byte-bounded, not snapshots against outside in-place writers.
  Callers choose sensible limits; `usize::MAX` is rejected on the tested
  64-bit targets because the extra-byte check would overflow.
- Directory listing, recursive removal, rename/move,
  append/truncate, permission changes, and guest/native path mapping are
  deliberately omitted. There are no placeholder methods for these operations.

When integrating, declare the module for the intended Unix targets and supply
a direct `libc` dependency in the mobile crate. The helper uses `libc` types,
flags, and functions; no syscall constants or ABI structs are hand-copied.
The current task does not edit either production manifest or `lib.rs`.

## Reproduction and actual evidence

From the ALMA-litter root:

```sh
python3 tools/alma-ios-lab/scoped_files_regression/run.py
```

The runner builds a separate small Cargo workspace under `.build/` with the
actual production file as its library source and `tests.rs` as integration
tests. There is no source rewriting or replacement filesystem implementation.
It uses the already cached libc version in the mobile workspace lockfile
(0.2.191 in this run), offline Cargo, and the sibling
`ALMA/.build/tauri-toolchain` with explicit
`RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin`. Cargo home, build products,
temporary files, and test workspaces stay under this folder. It does not
download a toolchain, initialize an upstream tree, or remove caches.

Recorded on 2026-11-01 with rustc 1.99.0:

- `aarch64-apple-darwin`: **15 tests passed**, with warnings treated as errors.
- `aarch64-apple-ios`: the isolated actual library and libc compiled to rlibs,
  with warnings treated as errors. No iOS executable was linked or run.
- New-file whitespace checks passed.

Tests cover normal create/read/replace/remove operations, nested Unicode
names, binary/empty bodies, byte limits, read-only rejection, malformed path
parsing, directory-read rejection, missing parents, old-open-inode integrity,
repeated complete writes, and cleanup after an ordinary rename failure.
An ordinary rename of the test's own root directory verifies retention of the
root fd. This host filesystem rejected a non-UTF-8 name with `EILSEQ`; the
corresponding test confirms propagation without lossy renaming or leftovers.

Every data operation stays in test-owned temporary workspaces. No real user
files, credentials, login/network, devices, mounts, unexposed-host access,
or adversarial namespace/race probes are involved. No full mobile crate build
or M3/iSH/ExecutorFileSystem integration is claimed.

`.build/evidence.json` records compiler, libc version, source/test hashes and
results. `.build/host-tests.{stdout,stderr}.txt` and
`.build/ios-compile.{stdout,stderr}.txt` preserve the actual tool output.
Ordinary test workspaces are retained under `.build/workspaces/` for review.
