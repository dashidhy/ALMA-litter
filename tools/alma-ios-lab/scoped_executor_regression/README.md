# Actual Codex 0.166 scoped ExecutorFileSystem adapter — not runtime-wired

Follow-up: main has since wired these modules/dependencies and reported a passing
full mobile iOS check. The [actual apply-patch consumer regression](apply_patch_evidence.md)
now demonstrates the batch-authorization gap and tests a review-only upstream
hook proposal. The earlier adapter-only evidence below remains historical;
it does not establish whole-patch zero-mutation authorization.

`shared/rust-bridge/codex-mobile-client/src/scoped_executor_fs.rs` implements
the actual `codex_file_system::ExecutorFileSystem` trait from the checked-out
0.166 source. `scoped_files.rs` adds descriptor-relative metadata and recursive
parent creation. Neither production module/dependency registration nor runtime,
global filesystem, iSH, or phone wiring is changed.

## Host construction and dependency handoff

```rust
ScopedExecutorFileSystem::new(
    roots: Vec<(codex_utils_path_uri::PathUri, ScopedFiles)>,
    max_file_bytes: usize,
) -> std::io::Result<ScopedExecutorFileSystem>
```

The controller opens each `ScopedFiles` using its trusted native directory and
`Access::ReadOnly` or `Access::ReadWrite`, then consumes those capabilities into
the adapter alongside their virtual root URIs. Mounts are immutable, nonempty,
and disjoint in the virtual namespace, including equivalent URI spellings.
No native source pathname is stored in the adapter. Root authority can never
be widened by an operation's sandbox context. The controller remains responsible
for avoiding unintended aliases between physical roots and for trusted topology.

Direct dependencies required by these modules when main wires them:

- `codex-file-system` from the actual 0.166 `file-system` crate: trait,
  `ExecutorFileSystemFuture`, `FileSystemSandboxContext`, option/result structs,
  `FileSystemReadStream`, and chunk-size constants.
- `codex-protocol`: permission path/special-root types; actual profile and policy
  methods are invoked through the context.
- `codex-utils-path-uri`: `PathUri`, `PathConvention`.
- `bytes`, `futures`, `tokio`, and `libc`.

`codex-exec-server` re-exports this same trait and option types in its actual
`src/lib.rs`; this implementation does not define an alternate trait. It can
be passed as `&dyn ExecutorFileSystem` or stored in an `Arc<dyn
ExecutorFileSystem>` using the same dependency source/version. The controller
must still arrange runtime ownership and pass the adapter into apply-patch.

## Supported methods

| Trait method | P0 behavior |
| --- | --- |
| `canonicalize` | Verify the entry through a no-follow descriptor and return the same validated virtual URI. No native canonicalization or native-path return. |
| `read_file` | Regular-file read bounded by configured maximum. Oversize is an error, never successful truncation. |
| `read_file_text` | Bounded read and strict UTF-8; invalid text returns a static error without retaining body bytes in the error. |
| `read_file_stream` | Bounded whole-file buffer emitted as `Bytes` slices no larger than upstream `FILE_READ_CHUNK_SIZE`. |
| `write_file` | Size-check, require a regular existing target or absent target, then same-parent fresh-inode atomic replacement. |
| `write_file_stream` | Validate authority/policy before consuming input; reject empty/oversize chunks and excessive total bytes. Buffer all input and commit once; an empty stream writes an empty file. |
| `create_directory` | Single or recursive descriptor-relative creation. Preauthorize every potentially created parent before any I/O; conservatively requires write access even to existing parents. Recursive creation of the mapped root verifies it and succeeds. |
| `get_metadata` | Descriptor metadata for regular files/directories and virtual roots, including real size and timestamps. Missing/unsupported timestamps are errors, not invented zeros. |
| `remove` | Nonrecursive regular-file unlink below a mapped root; `force` suppresses only `NotFound`. Directory removal returns `Unsupported`. |

Normal apply-patch add/update/delete and move-by-read/write/remove are covered
by this method set, including the actual consumer's missing-parent retry
sequence. Moves/multi-file patches are **not transactions**; if a later remove
fails, a destination already written can remain.

`watch_missing`, `read_directory`, `walk`, `copy`, and recursive `remove`
return `io::ErrorKind::Unsupported` immediately. They do not return fabricated
empty results or success. No directory listing implementation is claimed.

## Policy intersection and path rules

When a context is present, the adapter uses its actual
`permissions.file_system_sandbox_policy()` and `policy_context()`. Reads and
metadata use `resolve_access(...).can_read()`; writes use `can_write_path(...)`,
including Codex's protected metadata-directory rule. These are the selected-
executor `PathUri` policy APIs, not local-path canonicalizing helpers.

Supported contexts contain unrestricted/external filesystem profiles or
restricted entries made exclusively from valid POSIX literal paths and the
special `Root` path. Literal read/write/deny precedence is evaluated by the
upstream policy implementation. `None` means only host-mounted authority applies.

Before filesystem I/O or stream consumption, the following return `Unsupported`:

- Glob entries or `glob_scan_max_depth`.
- Special entries other than `Root` (including project roots, tmp, minimal, home,
  or unknown forms); main must supply literal virtual paths for this P0 adapter.
- Conditional missing-path entries.
- Sandbox overrides, Windows sandbox/proxy selections, and legacy Landlock mode.

Invalid URI/policy paths return `InvalidInput`. Policy denials and paths outside
the virtual mapping return `PermissionDenied`. Native errors are reduced to
their `ErrorKind` plus a static message, preserving `NotFound` for apply-patch
retry without exposing native source paths. No file body, stream error body,
native root pathname, or credentials are logged here.

Virtual names must be unambiguous, UTF-8 POSIX file URIs, bounded to 16 KiB and
128 components. Foreign authorities/Windows conventions, opaque fallback URIs,
encoded separators, NULs, repeated/trailing separators, and dot/parent
components present in the received URI are rejected. `PathUri::parse` already
normalizes some dot segments before the adapter sees them; validation applies
to the resulting typed URI. That URI still must map to a host-granted root.
Virtual absolute URIs never become host absolute operation paths: only validated
relative components are passed to `ScopedFiles` after mapping.

Symlinks are never traversed, even when an upstream option permits following
them. Regular-file/directory callers work with either flag setting. Symlink
metadata and symlink reads/writes/removals fail through no-follow descriptor checks.
The underlying primitive can unlink a final link entry, but this adapter requires
a regular-file target. The fixed stricter
policy is intentional; following symlinks is not a supported feature.

## Scheduling and remaining P0 limits

The configurable file limit is 1 byte through 64 MiB. Streams buffer the whole
file within that limit. Native I/O is synchronous when the future is polled;
main must schedule operations on an I/O worker, not a UI thread. Input-stream
failure or cancellation before commit preserves the target; an already-started
synchronous commit cannot be cancelled. File sync/rename, parent-directory
durability, old inode/metadata behavior, and cleanup retain the primitive's
documented contract.

The trusted controller must prevent untrusted changes to directory topology,
mounts, links, and temporary entries while operations run. This adapter is not
guest syscall enforcement or a boundary against arbitrary same-process code.
No security or VM-equivalence claim is made.

## Reproduction and compiled scope

```sh
python3 tools/alma-ios-lab/scoped_executor_regression/run.py
```

The standalone workspace includes the two production files by path and depends
directly on the actual checked-out `codex-file-system`, `codex-protocol`, and
`codex-utils-path-uri` crates. No parent-source copies, extracted trait bodies,
fake protocol types, or filesystem stubs are used. It reuses cached dependencies
offline, explicitly selects `stable-aarch64-apple-darwin`, and uses **two Cargo
jobs** with a 600-second build/test cap. The local lockfile is initially seeded
from the existing mobile lock to retain yanked transitive `spin` 0.9.8; no upstream
or mobile lockfile is edited. This standalone graph required no new patches.

Recorded 2026-11-01, rustc 1.99.0:

- Actual trait adapter compiled and linked into host tests: **9 adapter scenarios
  passed**, plus **15 primitive regression tests passed**.
- Tests cover the normal patch operation sequence, metadata/root handling,
  Unicode/text/bytes, virtual mapping, read-only/context intersection, unsupported
  policy rejection before I/O/input polling, buffered-stream limits and cancellation,
  malformed URIs, explicit unsupported methods, and error-body sanitization.
- The extended primitive separately passed its existing 15 host tests and
  compiled to an `aarch64-apple-ios` rlib via the primitive runner (also two jobs).
- The adapter itself was **not iOS-cross-compiled**. The full mobile crate and
  full `codex-apply-patch`/`codex-exec-server` consumer were not built or run.
  The patch test is the real trait's normal read/write/remove/parent sequence,
  not an end-to-end patch-parser integration test.

All operation tests use their own temporary workspaces. There are no real user
files, auth operations, network requests, device operations, mounts, or adversarial
host-access/namespace probes. `.build/test-output.txt` contains actual build/test
output; `.build/evidence.json` records commands, commit, compiler, elapsed time,
and production/upstream source hashes. Runtime wiring remains with main.
