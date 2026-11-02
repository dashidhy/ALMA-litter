# M4 native ChatGPT refresh: implementation and handoff

M1 is finalized separately in `../thread_item_regression/README.md`: the main's
full local-profile Rust library check passed in 15.21s with 31 warnings. No
identical M1 full check was rerun. Parent Rust wiring is now applied: **the full local-profile mobile Rust check
passes with M4** (16.03s, 31 warnings). Production static-archive binding generation
and native qualification remain parent/Averroes work; real auth network was not
used. See `cargo-check-ios-local-6.log` and `parent-integrated-evidence.json`.

## Authorized runtime changes

- `shared/rust-bridge/codex-mobile-client/src/auth_refresh.rs`: new typed async
  UniFFI callback/provider registry and Rust-owned dispatcher. Only a current,
  local Codex session is eligible. Remote/non-Codex requests never invoke the
  local credential store. Missing providers, typed native errors, invalid/empty
  tokens, account mismatch and expired requests become explicit JSON-RPC errors.
  Replacing/unregistering a provider invalidates its in-flight result.
- `src/mobile_client/event_loop.rs`: intercept the real upstream
  `ServerRequest::ChatgptAuthTokensRefresh` before debug logging and raw/UI event
  projection; retain the original request ID/runtime and send a real response or
  rejection. Session identity is checked before invocation and before delivery.
- `src/ffi/client.rs`: register/clear the async native callback. No credentials
  are stored in the dispatcher registry.
- `apps/ios/Sources/Litter/Models/ChatGPTAuthRefreshProvider.swift`: stateless
  Sendable bridge. It passes only immutable values to the existing `@MainActor`
  auth owner and returns typed access token/account/plan fields. It does not parse
  wire JSON, invoke API-key fallback, or forward/log arbitrary native error text.
- `Models/AppRuntimeController.swift`: register the provider in `bind` before
  reachability/reconnect work there. Full generated binding integration remains
  parent-owned.
- `Models/ChatGPTOAuth.swift`: single-flight refresh per token-store generation;
  strict stored/returned account pin; stale supplied snapshots rejected; generation
  and current-store equality checks across suspension and immediately before
  commit/return; deadline checks; bounded token exchange; refresh error bodies
  removed from logs/errors. The legacy convenience fallback no longer returns a
  captured credential after the store changes.

The token store was not globally actor-isolated: its existing synchronous
Slingshot credential reader still uses `load()`. Mutation methods and generation
are explicitly MainActor-owned. `save`/`clear` invalidate pending refreshes before
Keychain writes/deletion, even if those operations fail. The new bridge owns no
mutable state and adds no unchecked Sendable escape hatch. The new token bundle
is an immutable Sendable value.

No agent edits to lib.rs, Cargo, connection.rs, ffi/shared.rs, submodule,
Environment integration, scoped FS, iSH policy, UI reducer, or device state were
made. The standalone test workspace has its own ignored manifest/cache; it does
not change repository dependency manifests or locks.

## Deadline and credential behavior

Core's actual `app-server/src/external_auth.rs` uses a 10-second deadline.
From receipt of the server request, Rust limits callback work to 7 seconds and
response delivery to 9 seconds, reserving headroom for Core's earlier start.
The native request receives at most a 6-second exchange budget. Expired queued
work does not start a callback. A disconnected/stalled response channel is
bounded; the dispatcher makes one reply attempt, not duplicate success/error
attempts. Transport failure cannot guarantee delivery to a disconnected peer.

Native refreshes share one rotation and one commit for the same generation.
Logout, account switch, and same-token re-save during the await invalidate that
result. A newer generation can refresh independently; an old completion cannot
clear the newer flight or overwrite its credentials. The owning refresh flight has an absolute structured deadline that cancels its
async exchange and prevents late commit. A joined caller also enforces its own
deadline; an independently owned shared flight may continue for another waiter. No API-key fallback is used
by this callback path. Callback errors and Rust diagnostics contain no token or
account values; token Debug output is redacted.

## Validation performed

- `python3 tools/alma-ios-lab/auth_refresh_regression/run_rust.py`: **7 passed**.
  Compiles the actual production dispatcher and UniFFI async callback with
  source-derived upstream wire DTOs and an offline dummy reply transport. Covers
  success/serialization, remote denial without provider invocation, missing/error
  providers, account/empty-token rejection, 7-second callback timeout, expired
  queue work, 9-second reply timeout, disconnect and provider removal. Tokio's
  paused test clock avoids waiting in real time. See `rust-output.txt` and
  `rust-evidence.json`.
- `run_swift.py`: **passes Swift 5 targeted and Swift 6 complete concurrency**,
  with warnings as errors. Actual refresh/coordinator/provider source runs with
  in-memory Keychain and controlled async exchange fixtures. Covers account pins,
  logout, account change, ABA saves, concurrent coalescing/single commit, old/new
  flight ordering, deadline failures, stale convenience fallback, missing stored
  credentials and typed callback failure. No real Keychain/network functions are
  compiled into this executable. See the Swift output/evidence files.
- `check_swift_ios.py`: **passes** for the complete production ChatGPTOAuth and
  native provider Swift files against the real iOS SDK, Swift 5 targeted mode,
  warnings as errors. Generated binding signatures/logger are stand-ins. This is
  a type-check, not a generated-binding/app link or runtime test.
- The actual Keychain store declaration separately type-checks in Swift 5 targeted
  mode without executing Security APIs (`swift-real-store-typecheck.txt`).
- `check_ios_module.py`: **passes** for the actual production Rust module,
  UniFFI async trait, and copied registration methods against cached actual iOS
  protocol/Tokio/UniFFI dependencies. This metadata-only root is separate from
  the not-yet-wired mobile root; no substitute protocol types are used here.
- Request-route audit confirms auth interception before raw notification/logging,
  local Codex eligibility, current-session checks and typed native boundaries.
  See `integration-evidence.json`. `git diff --check` passes.

Project settings were checked in both `apps/ios/project.yml` and generated
`.pbxproj`: Swift 5.9, targeted concurrency, no configured newer default-isolation
or approachable-concurrency switches. Swift code uses compatible MainActor/Task
constructs, not Swift 6.2-only isolated conformances or `@concurrent`.

All credentials, account IDs and transport payloads used in execution tests are
artificial. No real accounts, network endpoints, Keychain entries or devices
were accessed.

## Actual full mobile check and parent integration

The requested actual check was run once after M4 edits, max two jobs; it waited
for the parent's shared target lock rather than running a competing full build:

```sh
bash tools/alma-ios-lab/cargo_ios.sh check --locked --offline \
  -p codex-mobile-client --lib --target aarch64-apple-ios \
  --profile ios-dev --no-default-features -j 2
```

That initial agent-run check exited 101 at six references to the not-yet-declared
module (`cargo-check-ios-pending-parent.log`, retained as historical evidence).
The parent subsequently added the module, implemented runtime-specific rejection,
and ran the real full check successfully. The archived final
`cargo-check-ios-local-6.log` reports **0 errors, 31 warnings, 16.03s**. No duplicate
large build was run by this agent after the parent took over compilation.

[Exact parent wiring and correction](PARENT_HANDOFF.md):

1. **Done by parent:** `pub mod auth_refresh;` in lib.rs.
2. **Done by parent:** `reject_for_runtime` and shared strict response routing:
   known mapped route, Codex-only primary fallback, unknown route SendFailed.
   Both success and error replies use that policy.
3. **Remaining:** production Swift binding generation/static archive link and
   native app qualification. No new Cargo dependency or ffi/shared change is
   required by this dispatcher.

**No upstream auth-delivery patch is required.** An early investigation found a
reject guard in `AppServerClient::start`, but tracing the actual local path showed
that mobile calls `codex_app_server::in_process::start` directly, forwards events,
and already routes Resolve/Reject through its sender. The earlier proposed
upstream prerequisite was explicitly withdrawn. Do not remove that unrelated
wrapper guard for this work.

Rust integration is compile-qualified; a real account refresh has not been run
and is not claimed. Production generated bindings/native qualification are still
pending in the parent task. Other platforms without a registered native provider fail
explicitly; no fallback is invented. M1's pending Environment wiring and optional
UI/remote capability limits remain separate from M4.

## Exact generated callback interface evidence

`generate_callback_evidence.py` builds only a small isolated metadata fixture
from the actual production auth module and runs UniFFI 0.31 against its library.
It uses a separate target and offline dependencies, not a full host mobile build.
`generated-error-enum.swift.txt` is copied from actual generated Swift. Its cases
are `Unavailable`, `TimedOut`, `AccountChanged`, `RefreshFailed`, and
`UnsupportedServer`, all unit cases with no message parameter. The production
native provider passed Swift 5 targeted-concurrency type-checking against this
actual generated interface, with only the OAuth-owner implementation stubbed.
The raw generated interface hash, source hash, commands and result are recorded
in `generated-callback-evidence.json`.

Reusable CLI:
`tools/alma-ios-lab/auth_refresh_regression/.build/rust/target/debug/auth-refresh-bindgen-evidence`.
Run from a Cargo workspace so library-mode metadata lookup succeeds. The parent
can reuse this binary for the production `.a`; do not copy fixture bindings into
the app. Full production bindings remain parent-owned.
