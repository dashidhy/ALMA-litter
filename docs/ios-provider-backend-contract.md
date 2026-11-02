# iOS ProviderBackend contract — source design

2026-11-01 · `dev/ios` · Proposal only; no implementation or runtime acceptance claimed.
Scope: full normal TAH inside the same iOS App, with a fresh immutable execution context for every attempt.
No App exit/relaunch, Mac controller, remote executor, new harness, or API-key fallback is part of production.
Main owns portable-JS investigation, TAH integration, other files, and source write-scope confirmation.

## Boundary and ownership

```text
TAHFramework → ProviderAdapter → ProviderBackend → embedded Codex App Server
                                                    ↓ EnvironmentManager
                                  scoped native files + owned iSH execution
```

Preserve the [Mac semantic contract](../../ALMA/docs/alma_tah_provider_contract_v1.md), especially frozen inputs, exact model/effort, normalized events, terminal authority, and cleanup before outcome admission.
Its VM destruction is a Mac implementation mechanism; this design replaces that mechanism with explicit iOS scope disposal and quiescence, without claiming VM-equivalent containment.

| Owner | Responsibilities |
| --- | --- |
| TAHFramework | Guardian/Actor orchestration, instructions, user choices, accepted history, ledger, retries, Critic, outcome validation and publication. |
| ProviderAdapter | Native ability/config mapping, prompt projection, exact model validation, account/catalog/usage interpretation, event/error/terminal normalization, native cancellation requests. Reuse Mac TS semantics where portable. |
| ProviderBackend (Rust) | RPC transport/correlation, auth credential access and refresh plumbing, runtime ownership, immutable scope construction, capability I/O, resource bounds, admission, cancellation/drain/disposal receipts. No TAH role/schema/ledger decisions. |
| Swift | UI, platform credential persistence/OAuth presentation, platform permissions/lifecycle, and thin typed UniFFI callbacks per [AGENTS](../AGENTS.md). No upstream JSON parsing or duplicate workflow/reducer. |

App Server stays the Codex boundary: `initialize`, account/model RPCs, `thread/start`, `turn/start`, notifications/server requests, `turn/interrupt`, and runtime close.
Do not substitute direct Core model calls, a shell-driven Codex CLI, or `tah_runner` observations for that contract.
Native tool execution stays behind App Server's injected `ExecBackend`/`ExecutorFileSystem`; backend APIs are trusted construction ports, never model tools.

## Proposed native surface

Names below are design signatures, not claims of existing APIs; the JS engine/binding is main's choice.
Handles are typed, opaque, owner/generation-bound, and unusable after closure. Native paths/descriptors never enter Framework DTOs.

```text
ProviderBackend
  openScope(FrozenExecutionSpec, MaterialCapabilities) -> ExecutionContext
  openRuntime(context, AuthLease, FrozenNativeConfig) -> RpcConnection
  auth.acquire(provider, expectedAccountGeneration) -> AuthLease

RpcConnection
  request(method, boundedParams) -> bounded native result/error
  notify(method, boundedParams)
  events() -> ordered bounded native notifications/server requests
  respond(serverRequestHandle, result | error)
  close() -> RuntimeCloseReceipt                 // idempotent, awaitable

ExecutionContext
  closeAdmission()                             // one-way, idempotent
  drain(deadline) -> QuiescenceReceipt
  capture(readCapability, limits) -> bounded file snapshot
  dispose() -> DisposalReceipt                  // after drain/capture
```

`FrozenExecutionSpec` contains identity, logical RO/RW roots, explicit guest cwd/home/tmp/env, enforceable network policy and limits; it contains no Guardian rules or revision naming policy.
`FrozenNativeConfig` is Adapter-produced Codex configuration; the backend validates that resolved permissions/environment match its issued scope and cannot widen it.
Materials arrive from trusted in-App capabilities with byte/path/digest bounds; no `Documents/inbound-attempt.json` dependency remains.
`capture` is generic bounded file collection; Framework decides which candidates satisfy its outcome schema and whether to publish them.
Backend failures describe transport/auth/execution/resource/cleanup facts; Adapter maps those into the existing normalized failure family. No success, ALLOW/BLOCK, or readiness receipt is inferred from generic RPC success.
RPC handles preserve native error codes and server-request identity privately; Framework/UI receive only Adapter-normalized data. Queue overflow is explicit, never silent terminal-event loss.
Auth operations use the same RPC/runtime boundary with an empty model workspace and no inference/tool admission.

## Immutable context factory and one sealed instance

1. Bootstrap one owned `Arc<IshInstance>` with `boot_workspace_policy_with_workspace`, mounting a private workspace container at `/workspace` before sealing. Keep its mount, supervisor and root identities fixed; the supervisor's cwd must be a stable bootstrap directory, never a disposable attempt directory.
2. Retain a backend-owned operation lease across preparation, execution, drain, capture and disposal. Initially serialize operations on this instance; source-work parallelism does not require concurrent model attempts.
3. Only while the prior operation is quiescent, allocate never-reused `attempts/<opaque-id>/{view,scratch}` beneath that container. Copy only supplied materials/seeds; do not mount auth, controller storage or ledger.
4. Construct a new immutable `WorkspaceScope`, `ExecutionFence`, `WorkspacePolicy`, `IshExecBackend`, scoped filesystem and `EnvironmentInfo` for this attempt. Reuse the sealed instance, not the old authority objects.
5. After strict resolved-config validation, call `EnvironmentManager::from_embedded(backend, filesystem, info, config.http_client_factory())`; inject the resulting fresh `Arc` through `InProcessStartArgs.environment_manager`.
6. Start a fresh App Server runtime and one ephemeral thread/turn. The Adapter verifies actual receipts against frozen model/effort/cwd and disables fallback. A later attempt starts another runtime/context inside the same App.

The internal environment ID may remain `embedded`: each manager is distinct. Never replace a live manager's entry or mutate a shared “current attempt” pointer to redirect existing requests.
No native `local` fallback or host-process escape path is registered. Keep strict projectless config, ambient features disabled, and the existing embedded network-policy/HTTP factory plumbing.
Provider Web is an Adapter-mapped native grant, independent of the guest's `DenyDirect` sockets. Backend does not choose abilities or infer network authority from tool events.
Creating the next child directory is a trusted filesystem operation under an already sealed mount, not a remount. No backing-root replacement, aliasing, directory rename, or topology mutation occurs while leases are live.
Immutability covers authority/configuration and input materials; permitted candidate/scratch contents and lifecycle counters remain mutable.

## Capability I/O and shared authentication

Use `ScopedFiles` directory capabilities and `ScopedExecutorFileSystem::with_readonly_ancestors(...).with_fence(...)`: RO attempt view plus explicitly writable child roots and private scratch.
Retain descriptor-relative `O_NOFOLLOW` traversal, nested-root inode checks, whole-batch mutation preflight and per-operation authorization. Match the same roots in iSH grants; neither guest paths nor prefixes alone authorize native file I/O.
All provider-accessible filesystem operations and command preparations participate in the attempt fence. Native writes hold permits through completion, including streaming writes; multi-step patch work also needs tracked ownership through completion/cancellation.
Retain bounded stdout/stderr, stdin, event queues, file bytes, directory depth and candidate count. Existing limits are starting implementation bounds, not new TAH semantic choices.
After drain, capture through a separate trusted RO capability; do not reopen the closed model-I/O fence. Verify immutable inputs and collect only authorized candidate roots before disposal.
Retained read snapshots may outlive their I/O, but must not retain writable authority or be routed to another attempt.

Auth is an App/provider service outside `/workspace`, shared across operations; attempt contexts hold opaque, account-generation-bound leases, never token copies in materials, env, prompts, logs or JS DTOs.
Keep each operation's controller/config/session home private and fresh outside the guest mount; sharing auth does not share thread history, mutable config or prior execution state. Deliver credentials through the native auth service and dispose operation-local state after drain.
Reuse the platform credential owner and Rust `auth_refresh::AuthRefreshDispatcher` plumbing. Keep refresh responses bound to their originating runtime/request/account generation; late refresh callbacks cannot authenticate the next scope.
Adapter owns native login/account semantics and auth-invalid classification; Rust owns secret delivery and persistence coordination. Token material crosses only the existing trusted credential boundary.
Logout/account replacement closes relevant admission and drains/revokes outstanding leases before the next account is admitted; normal attempt disposal does not log out or delete shared credentials.
Retain `enable_codex_api_key_env: false` for iOS. No fallback to environment API keys, Mac credentials, or alternate providers.
Resolve host controller/auth storage explicitly in config; do not repoint process `CODEX_HOME`, cwd, `SSH_HOME` or `CURL_HOME` per attempt. TLS roots/client identity may be initialized once as App infrastructure.
Upstream currently constructs its own AuthManager during bootstrap; a shared auth service does not imply an already-existing injectable AuthManager argument.

## Normal teardown and admission proof

Lifecycle: `Prepared → Running → AdmissionClosed → Draining → Quiescent → Captured/Discarded → Disposed`.

1. Adapter observes an authoritative terminal, or asks for cancellation. Backend closes new RPC/work admission and the one-way execution/file fence; cancellation, server-request completion and drain controls remain usable.
2. Cancel pending preparations and prevent queued starts from crossing closure. Track bridge request tasks, server work and callbacks by context, including work that has not yet acquired a filesystem/process permit.
3. Drain native notifications through the Adapter's tail validation, settle/reject pending RPCs, and request actual App Server shutdown. Join owned runtime/bridge/Code Mode tasks; do not detach them by dropping a handle.
4. Retain process handles in the backend registry; request `terminate_owned`/`ExecProcess::terminate` where needed and await owned-job `Closed` plus complete output drain. An exit code or interrupt acknowledgement alone is insufficient.
5. Require the closed fence to reach zero permits, no pending starts or owned processes, released grants/leases, no live mutation tasks/callbacks, and no quarantine. Record these observations in a context-bound quiescence receipt.
6. Capture bounded immutable-input/candidate snapshots only now. Framework performs admission/publication separately; failed/cancelled attempts publish no partial outcome.
7. Dispose App Server state, scope handles, descriptors, scratch and attempt backing files after snapshot handoff; release the operation lease only after disposal. Boot resources and shared auth stay alive for the next attempt.

The shared lease spans both native I/O and guest work. Per-policy `Semaphore(1)` alone is insufficient when multiple policy instances exist; the factory owns the cross-context lease and quarantine latch.
`ExecutionLease::complete` remains conditional on confirmed owned cleanup. Drop, zero `Arc` references, an empty event queue, or a closed fence alone do not prove quiescence.
If bounded cleanup cannot establish quiescence, preserve the instance/operation admission barrier and report cleanup failure; do not admit another context or claim successful publication. Exception recovery is deferred, not a normal restart requirement.
Runtime close and scope disposal are separate facts. iOS returns a typed quiescence/close receipt, never a fabricated process-exit code or VM-destruction receipt.

## Existing seams and required refactors

Paths below are relative to `shared/rust-bridge/codex-mobile-client/src/` unless stated otherwise.

| Existing source/API | Exact extension or ownership change |
| --- | --- |
| `embedded_runtime.rs`: `register`, `installed`, `EmbeddedRuntime::manager` | Replace attempt-bearing `RUNTIME: OnceLock` registration with a factory returning immutable context handles; retain validation and `from_embedded` construction per context. |
| `alma_workspace.rs`: `bootstrap_attempt`, `WorkspaceScope::attempt`, `WorkspacePolicy::with_scope`, `scope_config`, `validate_scope_config` | Separate boot-once from prepare-many; accept generic frozen scope data instead of `PreparedAttempt` business fields; inject instance/operation lease and return owned backend/policy/filesystem/info. |
| `alma_workspace.rs`: `ATTEMPT_EXECUTION`, `attempt_health`, `close_attempt_admission` | Move health/fence/quarantine observations onto context handles; share instance-level admission/quarantine across contexts. |
| `ish_exec_backend.rs`: `ExecutionPolicy::prepare`, `ExecutionLease`, `IshExecBackend::new`, `active_process_count`, `Runtime::finish_owned` | Retain enforcement and confirmed cleanup; extend ID-only active registry to owned cancellable process/preparation tracking with awaitable drain, without weakening Drop quarantine. |
| `execution_fence.rs`: `acquire`, `close`, `drained` | Reuse one-way semantics; add awaitable drain/notifications and track preparations/batch owners so closure cannot miss queued work. Never reopen a fence. |
| `scoped_executor_fs.rs`: constructors, `with_fence`, `preflight_mutations` | Reuse capability views; bind every operation to its context and keep batch lifecycle ownership through all writes. `ScopedFiles` remains authority-scoped, not global. |
| `tah_attempt.rs`: `prepare`, `CURRENT`, `install/current`, `capture_candidates` | Extract generic bounded materialization/capture accepting explicit handles; remove singleton and external manifest transport from production. Role allowlists, `revision_v0..2`, Guardian schemas and prompt rendering belong above backend. |
| `tah_runner.rs`: `ATTEMPT_USED`, `context`, `rpc`, `inspect/discover/run`, `frame` | Replace process-global one-shot/report runner with per-runtime transport ownership; reuse direct App Server RPC plumbing. Mac Adapter remains native normalization/model/prompt authority, not a second Rust TAH implementation. |
| `session/connection.rs`: `InProcessConfig`, `ServerSession::connect_local` | Add internal explicit context/auth-service injection; remove `installed()` lookup and per-connect process env/cwd mutation. Keep guest cwd, strict config and resolved HTTP policy explicit. |
| `session/connection.rs`: local `SessionCommand` worker, `disconnect_inner` | Track spawned requests, retain runtime handle, add awaitable close receipt and event drain; current 100ms sleep + worker abort is not runtime cleanup. |
| `lib.rs`: `tah_qualification_execute` | Replace qualification-only global polling/report composition in production; remove `requiresExternalProcessExitVerification` dependency. Expose narrow typed Rust handles through the existing single UniFFI surface. |
| `ish_runtime.rs`: `INSTANCE`, `bootstrap` | Keep one sealed instance; remove production selection by `--run-tah-attempt` and repeated boot coupling. Legacy terminal/bootstrap paths must not bypass granted execution. |
| `ffi/shared.rs`: `SHARED_RUNTIME`, `SHARED_MOBILE_CLIENT`; `auth_refresh.rs`: dispatcher `INSTANCE` | App-level Tokio/client/auth infrastructure may stay shared. No singleton may select an attempt's authority; refresh routing must retain runtime/account identity. |

Other globals: `scoped_files::NEXT_TEMP` and request-ID counters may remain uniqueness utilities; they must not grant authority. `WorkspacePolicy::gate` and `quarantined` are currently per-policy, so their reuse barrier needs the shared owner described above.

## Mac Adapter / upstream bridge compatibility

Mac references: `ALMA/app/TAH/src/guest/runtime/adapter.ts` (`GuestProviderAdapterV1.run/cancel`), `providers/codex/adapter/src/{guest-adapter,control-adapter,auth-driver,process-facade}.ts`.
`CodexGuestAdapterOptionsV1.appServer` and `CodexGuestControlAdapterOptionsV1.appServer` already inject `CodexAppServerFacadeV1`; `createCodexAuthDriver` also accepts a facade. This is the native transport seam to preserve.
`CodexAppServerConnectionV1` exposes `request/notify/events/close`; stdio framing, Node child launcher, executable paths and environment construction are desktop mechanisms below that seam.
Node filesystem/auth guards and the process-specific `{code, signal}` close receipt also need explicit platform ports; replacing the launcher alone does not make the Adapter portable. Main owns TS/JS composition.

Upstream paths are under `shared/third_party/codex/codex-rs/`:

- `exec-server/src/environment/embedded.rs`: existing `EnvironmentManager::from_embedded` creates one `embedded` environment and no native fallback; reuse unchanged unless a concrete missing requirement appears.
- `app-server/src/in_process.rs`: existing `InProcessStartArgs.environment_manager` is the injection point; `InProcessClientSender` has request/notify/respond/fail-server-request primitives.
- `start()`/`start_with_code_mode_provider()` currently consume initialize/initialized and discard the successful initialize receipt. Mac Adapter sends and validates those itself. Proposed extension: expose an uninitialized entry using private `start_uninitialized_with_provider`, preserving pre-start rules validation, so the same actual handshake crosses the facade exactly once.
- `InProcessClientHandle::shutdown(self)` currently drops the event receiver, may abort timed-out tasks and returns `Ok(())`. Proposed extension: separate shutdown request from event drain/join and return explicit graceful/forced status; include ownership of detached processor work. Do not manufacture a clean receipt from today's `Ok`.
- `InProcessStartArgs` has no AuthManager injection field; reuse the credential service through current account RPC/refresh paths, and propose an injection change only if needed to preserve that ownership.

The portable facade must preserve real initialize/model/thread/turn receipts and native event order. Native auth-refresh requests are privately handled by the trusted auth service; unsupported server requests are rejected explicitly and remain visible to Adapter policy as appropriate.
No Mac source changes are authorized here. A future transport-neutral close type must keep Mac exit evidence and iOS quiescence evidence distinguishable while satisfying the same cleanup semantic gate.

## Delivery and narrow validation plan

This pass writes only this document (under 200 lines); no builds, models, phone work, network, secrets, commits, or source edits.
After main confirms source scope, implement factory/handle ownership and explicit runtime close first, then connect main's reused Adapter/Framework path.
Use existing test locations for meaningful lifecycle checks: two sequential contexts in one App/runtime host, distinct immutable scopes, old-handle denial, normal owned drain/capture/disposal, and shared auth surviving that transition.
Main's normal-flow acceptance should cover inspection and the ordinary Guardian → Actor → Critic/publication flow wholly on phone, including the next fresh attempt without relaunch. No parallel harness or exception matrix is requested.
Source proves the singleton, handshake and shutdown refactor needs above. It does not prove a P0 feasibility blocker; portable-JS suitability and full same-App acceptance remain work to establish, not blockers asserted from uncertainty.
