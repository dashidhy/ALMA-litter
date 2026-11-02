# M4 handoff status: parent Rust wiring applied

The parent added `pub mod auth_refresh` and implemented `reject_for_runtime`
plus a shared `server_response_sender`. Both success and error replies use a
known mapped runtime, fall back to the primary sender only for `codex`, and fail
unknown runtime routing explicitly. The parent-owned full mobile iOS check now
passes: `cargo-check-ios-local-6.log`, 16.03s, 31 mobile-library warnings.
Do not apply the earlier generic-fallback sketch; the parent's stricter route
implementation supersedes it. No connection.rs edit by this agent is needed.

No upstream patch is needed: local mobile uses
`codex_app_server::in_process::start` directly and already forwards server
requests and sends Resolve/Reject via its handle. The initial wrapper-based
rejection hypothesis was withdrawn; `AppServerClient::start` is not this path.

## Binding/native handoff

The reusable UniFFI 0.31 CLI binary is:

`tools/alma-ios-lab/auth_refresh_regression/.build/rust/target/debug/auth-refresh-bindgen-evidence`

It calls `uniffi::uniffi_bindgen_main()`. Run from a Cargo workspace with the
existing toolchain environment, using standard arguments, e.g.
`generate --library <production-static-archive.a> --language swift --out-dir <dir>`.
The parent has verified archive extraction support and is generating production
bindings from the iOS archive; a full host mobile cdylib build is not needed.

Exact generated callback error evidence (compiled production Rust metadata,
UniFFI 0.31, not a handwritten declaration) is in
`generated-error-enum.swift.txt` and `generated-callback-evidence.json`:

```swift
case Unavailable
case TimedOut
case AccountChanged
case RefreshFailed
case UnsupportedServer
```

These are unit cases with **no associated message argument**. The production
`ChatGPTAuthRefreshProvider.swift` type-checks against the actual generated
interface (`generated-provider-typecheck.txt`). The isolated fixture namespace
is not the app namespace; use the parent's production generated bindings in the
qualification UI. No generated fixture source was installed into app sources.

Full app binding generation/static linking and the native qualification UI are
parent/Averroes work. Registration in AppRuntimeController is already prepared.
No auth network, real account, Keychain mutation or device action was performed
by this agent.

The older `auth_regression/run.py` extractor targets the pre-M4 single-function
implementation. Its owner should update it or label it historical; current M4
coordinator dependencies/strict account behavior are covered by this directory's
offline Swift and Rust suites.
