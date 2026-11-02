Integration update: the old synchronous iOS hook has been retired from the
mobile crate for the0.166 backend migration. Its fixed source is preserved as
`legacy_ish_exec.rs` solely to reproduce the earlier logging regression. The
preflight/serializer tests still use current production files; hook tests are
historical and do not validate the new ExecBackend.

# iOS shell preservation and metadata-only logging regression

Run from the ALMA-litter root:

```sh
python3 tools/alma-ios-lab/shell_regression/run.py
```

This is an offline host test, not a full `codex-mobile-client` crate build or
an iSH/device test. It needs the two existing source archives under
`tools/alma-ios-lab/.cache`, cached shlex 1.3.0, host Bash/zsh/Python/Node,
and the sibling `ALMA/.build/tauri-toolchain`. The runner explicitly selects
`RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin` (observed rustc 1.99.0), never
invokes Cargo or installs toolchains, and writes only under this folder's
ignored `.build/`. It does not initialize the Codex submodule or touch phones.

## Production change and deliberate iOS scope

- `shell_preflight.rs`: iOS retains interpreter, flags, script, positional
  arguments, and guest `/tmp`. Android retains its existing `sh -c`
  normalization and native temp-directory rewrite.
- `mobile_exec_command.rs`: serialize the complete iOS argv using upstream
  `shlex_join`. The outer iSH sh transports quoted arguments; it does not
  become the interpreter for a Bash/zsh/Python/Node script. Android retains
  its prior parser/`sh -c` behavior.
- `ish_exec.rs`: both execution paths log counts, sizes, timeout, status, and
  elapsed time. No command, cwd, output preview, or free-form patch error is
  logged here. Detailed patch errors still reach the caller. No output is
  decoded or truncated for logging, including non-UTF-8 bytes.

Android's executable/runtime setup is outside this iSH-specific change. Its
existing behavior is tested unchanged; any Android interpreter-preservation
follow-up should be a separate change with Android runtime validation.

## Default Bash integration handoff

These hooks receive argv after shell selection. They cannot distinguish
default `/bin/sh -c ...` from an explicit internal `/bin/sh -c ...` request.
Consequently they must not promote sh to Bash or reinterpret zsh as Bash.
An actual `/bin/bash -c` or `-lc` from Codex now reaches Bash intact.

The upstream integration owner still needs to select/report guest `/bin/bash`
as the default before argv construction, align the guest `SHELL` environment
and model-facing instructions, and supply Bash in the guest. Those entry
points and packaging are outside the three allowed Rust files:

- Codex 0.166: `shell-command/src/shell_detect.rs` and the executor's
  `ShellInfo`/`core/src/shell.rs` shell-selection path.
- Mobile runtime: `shared/rust-bridge/codex-mobile-client/src/ish_runtime.rs`
  (`runtime_env`) and `local_runtime_instructions.rs` (currently advertises sh).

Missing interpreters remain failures, without silently falling back to sh.
This patch does **not** claim to complete M11's default selection, environment,
packaging, full exec-backend integration, or device acceptance. M6 evidence
is restricted to these logging sites, not a whole-application privacy audit.

## What the runner actually compiles

For both pristine Codex 0.166.0 and 0.155.1 archives, the runner copies the
actual `extract_shell_command`, `extract_bash_command`,
`extract_powershell_command`, `detect_shell_type`, and `shlex_join` functions,
plus `ShellType`, PowerShell flags, and `Shell::derive_exec_args`. Function
bodies are not reimplemented. A minimal `Shell` struct supplies the method's
fields without pulling in serde or the Codex workspace. The copied parser
and derive functions currently have identical hashes across both archives.

The production preflight and command-serialization modules, including their
unit tests, are copied into a small Rust harness. Only Android cfg selectors
are replaced with a test cfg to exercise both policies on macOS; there is no
pretend cross-compilation. An inert host-only registration shim satisfies
the iOS install reference. `ish_exec.rs` and `shell_quoting.rs` are included
directly by path. Registration, apply-patch, absolute-path conversion, and
Tokio use small test doubles. This does not validate their upstream APIs or
the missing Codex submodule. Runtime execution uses host `/bin/sh` to launch
the real requested host interpreter; logging cases inject byte buffers at
the runtime boundary. Tests run serially because temp-directory tests mutate
environment variables.

Coverage includes both Bash login modes, arrays, `$0`/`$@`, empty arguments,
quotes, literal substitutions, heredocs, pipelines, Unicode files,
Python/Node subprocesses, explicit sh, zsh-specific expansion, unsupported
interpreter failures, and streaming status/output. Logging cases cover
ASCII lengths 199/200/201; Chinese and emoji at offsets 198/199/200/201;
invalid UTF-8; a 1,000,000-byte Unicode result; and patch/setup/runtime errors.
The runner scans captured stderr for planted command/cwd/output/error
sentinels and requires metadata from both execution paths.

## Recorded result (2026-11-01)

Both archive versions: **41 iOS-policy tests + 27 Android-policy tests passed**
(136 test executions total), with both stderr log scans passing for each
version. This includes pre-existing module/quoting unit tests. Generated
`.build/evidence.json` records compiler, archive/parser/module hashes and
test summaries; each version/platform directory contains stdout and stderr.

The full crate was not built because its Codex submodule is uninitialized.
No runtime packages or device state were changed. The selected stable
toolchain lacks rustfmt; no component was downloaded. `git diff --check`
is used for whitespace validation.
