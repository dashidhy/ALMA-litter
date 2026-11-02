//! Thin native object/DTO facade for the trusted JS host. This is not a UniFFI
//! export and does not parse a TAH attempt, build prompts, normalize events,
//! implement authentication, or select a native profile. The host supplies the
//! validated ScopeSpec and PreparedRuntimeConfig from those owners.

use crate::auth_refresh::ChatgptAuthRefreshTokens;
use crate::provider_backend::{
    BackendError, ProviderBackend, ProviderExecutionScope, ScopeCloseReceipt,
};
use crate::provider_runtime_config::{self, PreparedRuntimeConfig, RuntimeConfigError};
use crate::provider_scope::{
    BoundScope, PreparedScope, ProviderScopeFactory, ScopeLayout, ScopeSpec,
};
use base64::Engine;
use codex_app_server::in_process::InProcessServerEvent;
use codex_app_server_protocol::{JSONRPCErrorError, RequestId, ServerRequest};
use codex_code_mode_protocol::CodeModeSessionProvider;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::io::{self, Write};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore, mpsc, watch};
use tokio::task::JoinHandle;

const MAX_RETAINED_EVENTS: usize = 256;
const MAX_RETAINED_BYTES: usize = 16 * 1024 * 1024;
const EVENT_DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);
const NATIVE_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const PUMP_JOIN_TIMEOUT: Duration = Duration::from_secs(15);
type PumpResult = std::result::Result<(), BackendError>;

#[derive(Debug)]
pub(crate) enum BridgeError {
    UnknownHandle,
    NotReady,
    Scope,
    RuntimeConfig(RuntimeConfigError),
    Backend(BackendError),
}
type Result<T> = std::result::Result<T, BridgeError>;

/// Native-only server-request interception, e.g. account-bound token refresh.
/// None leaves the unchanged request for the Adapter. A handled response goes
/// straight back to this runtime and can never enter a JS event/result DTO.
pub(crate) trait NativeServerRequestHandler: Send + Sync {
    fn handle<'a>(
        &'a self,
        handle: &'a str,
        request: &'a ServerRequest,
    ) -> Pin<
        Box<dyn Future<Output = Option<std::result::Result<Value, JSONRPCErrorError>>> + Send + 'a>,
    >;
}

struct Entry {
    prepared: Option<PreparedScope>,
    scope: Option<Arc<BoundScope>>,
    runtime: Option<Arc<PumpedRuntime>>,
    starting: bool,
}

pub(crate) struct NativeProviderBridge {
    factory: ProviderScopeFactory,
    entries: Mutex<HashMap<String, Entry>>,
    native_requests: Option<Arc<dyn NativeServerRequestHandler>>,
}

impl NativeProviderBridge {
    pub(crate) fn new(factory: ProviderScopeFactory) -> Self {
        Self {
            factory,
            entries: Mutex::new(HashMap::new()),
            native_requests: None,
        }
    }

    pub(crate) fn with_native_request_handler(
        mut self,
        handler: Arc<dyn NativeServerRequestHandler>,
    ) -> Self {
        self.native_requests = Some(handler);
        self
    }

    /// Exact four-field result expected by mobile-provider.ts scopeSchema. The
    /// outer host has already validated attempt/inputFiles/credentialHandle and
    /// translated material metadata to this generic ScopeSpec.
    pub(crate) async fn prepare(&self, spec: ScopeSpec) -> Result<Value> {
        let prepared = self
            .factory
            .prepare(spec)
            .await
            .map_err(|_| BridgeError::Scope)?;
        let layout = prepared.layout();
        let handle = layout.scope_id.clone();
        let result = json!({ "handle": handle, "workspaceRoot": layout.workspace_root,
            "controllerHome": layout.controller_home, "scratchRoot": layout.scratch_root });
        let mut entries = self.entries.lock().map_err(|_| BridgeError::Scope)?;
        if entries.contains_key(&handle) {
            return Err(BridgeError::Scope);
        }
        entries.insert(
            handle,
            Entry {
                prepared: Some(prepared),
                scope: None,
                runtime: None,
                starting: false,
            },
        );
        Ok(result)
    }

    /// Native config/auth builder access; no secret is returned to JS.
    pub(crate) fn layout(&self, handle: &str) -> Result<ScopeLayout> {
        let entries = self.entries.lock().map_err(|_| BridgeError::Scope)?;
        let entry = entries.get(handle).ok_or(BridgeError::UnknownHandle)?;
        if let Some(prepared) = &entry.prepared {
            return Ok(prepared.layout().clone());
        }
        entry
            .scope
            .as_ref()
            .map(|scope| scope.layout().clone())
            .ok_or(BridgeError::NotReady)
    }

    /// `profile.permissionProfileID` is supplied separately by the host. Bind the
    /// resolved config first, then construct StartArgs using that exact scope's
    /// execution context. The builder uses layout() for cwd/controller/grants/env.
    pub(crate) async fn start(
        &self,
        handle: &str,
        permission_profile_id: String,
        prepared_config: PreparedRuntimeConfig,
        code_mode: Arc<dyn CodeModeSessionProvider>,
    ) -> Result<()> {
        let scope = {
            let mut entries = self.entries.lock().map_err(|_| BridgeError::Scope)?;
            let entry = entries.get_mut(handle).ok_or(BridgeError::UnknownHandle)?;
            if entry.starting || entry.runtime.is_some() || entry.scope.is_some() {
                return Err(BridgeError::NotReady);
            }
            let prepared = entry.prepared.take().ok_or(BridgeError::NotReady)?;
            let scope = prepared
                .bind(
                    permission_profile_id,
                    prepared_config.config(),
                    prepared_config.cli_overrides(),
                )
                .map_err(|_| BridgeError::Scope)?;
            entry.starting = true;
            entry.scope = Some(scope.clone());
            scope
        };
        let started = match prepared_config.into_start_args(scope.execution()) {
            Ok(args) => ProviderBackend::start_scoped(scope.clone(), args, code_mode)
                .await
                .map_err(BridgeError::Backend),
            Err(error) => Err(BridgeError::RuntimeConfig(error)),
        };
        let mut entries = self.entries.lock().map_err(|_| BridgeError::Scope)?;
        let entry = entries.get_mut(handle).ok_or(BridgeError::UnknownHandle)?;
        entry.starting = false;
        // Start the sole native reader before returning to the caller: initial
        // initialize/account/model RPCs must not depend on JS polling events.
        entry.runtime = Some(Arc::new(PumpedRuntime::start(
            handle.to_owned(),
            Arc::new(started?),
            scope,
            self.native_requests.clone(),
        )));
        Ok(())
    }

    /// Native-only credential delivery; no token or login receipt enters JS.
    /// The host calls this after forwarding actual initialized and before
    /// acknowledging that notify to JS or admitting account/model requests.
    pub(crate) async fn install_native_tokens(
        &self,
        handle: &str,
        tokens: ChatgptAuthRefreshTokens,
    ) -> Result<()> {
        let runtime = self.runtime(handle)?;
        provider_runtime_config::install_native_tokens(runtime.as_ref(), tokens)
            .await
            .map_err(BridgeError::RuntimeConfig)
    }

    fn runtime(&self, handle: &str) -> Result<Arc<ProviderBackend>> {
        Ok(self.pumped_runtime(handle)?.backend.clone())
    }

    fn pumped_runtime(&self, handle: &str) -> Result<Arc<PumpedRuntime>> {
        self.entries
            .lock()
            .map_err(|_| BridgeError::Scope)?
            .get(handle)
            .ok_or(BridgeError::UnknownHandle)?
            .runtime
            .clone()
            .ok_or(BridgeError::NotReady)
    }

    pub(crate) async fn request(&self, handle: &str, method: &str, params: Value) -> Result<Value> {
        match self.runtime(handle)?.request(method, params).await {
            Ok(value) => Ok(json!({ "value": value })),
            Err(BackendError::Rpc(error)) => Ok(json!({ "error": error })),
            Err(error) => Err(BridgeError::Backend(error)),
        }
    }

    pub(crate) async fn notify(&self, handle: &str, method: &str, params: Value) -> Result<()> {
        self.runtime(handle)?
            .notify(method, (!params.is_null()).then_some(params))
            .await
            .map_err(BridgeError::Backend)
    }

    /// Native auth refresh helper calls this for a genuine connection-local
    /// request ID. Token responses never pass through the JS DTO facade.
    pub(crate) async fn respond_native(
        &self,
        handle: &str,
        id: RequestId,
        result: std::result::Result<Value, JSONRPCErrorError>,
    ) -> Result<()> {
        self.runtime(handle)?
            .respond(id, result)
            .await
            .map_err(BridgeError::Backend)
    }

    pub(crate) async fn next_event(&self, handle: &str) -> Result<Value> {
        let runtime = self.pumped_runtime(handle)?;
        match runtime.next_event().await.map_err(BridgeError::Backend)? {
            Some(event) => Ok(json!({ "done": false, "event": event })),
            None => Ok(json!({ "done": true })),
        }
    }

    pub(crate) async fn close(&self, handle: &str) -> Result<Value> {
        let runtime = self.pumped_runtime(handle)?;
        // The pump runs independently throughout native shutdown. Always join
        // it, including a failed native close, before considering any receipt.
        let native_close = runtime.backend.close().await;
        let pump_close = runtime.join_pump().await;
        if native_close.is_err() || pump_close.is_err() {
            runtime.scope.runtime_closed(false);
        }
        let receipt = native_close.map_err(BridgeError::Backend)?;
        pump_close.map_err(BridgeError::Backend)?;
        if !receipt.is_complete()
            || !matches!(&receipt.scope,
            ScopeCloseReceipt::Quiescent { scope_id } if scope_id == handle)
        {
            runtime.scope.runtime_closed(false);
            return Err(BridgeError::Scope);
        }
        runtime.close_confirmed.store(true, Ordering::Release);
        Ok(json!({ "kind": "in_process", "runtimeClosed": true,
            "requestsJoined": receipt.bridge_requests_joined,
            "eventsRetained": receipt.events_retained, "scopeQuiescent": true }))
    }

    pub(crate) fn capture(&self, handle: &str) -> Result<Value> {
        let entries = self.entries.lock().map_err(|_| BridgeError::Scope)?;
        let entry = entries.get(handle).ok_or(BridgeError::UnknownHandle)?;
        if !entry
            .runtime
            .as_ref()
            .is_some_and(|runtime| runtime.close_confirmed.load(Ordering::Acquire))
        {
            return Err(BridgeError::NotReady);
        }
        let scope = entry.scope.as_ref().ok_or(BridgeError::NotReady)?;
        let snapshot = scope.capture().map_err(|_| BridgeError::Scope)?;
        let mut captured = snapshot
            .directories
            .into_iter()
            .map(|path| {
                json!({
                    "relativePath": path, "kind": "directory", "byteLength": null, "base64": null,
                })
            })
            .collect::<Vec<_>>();
        for file in snapshot.files {
            captured.push(json!({ "relativePath": file.relative_path,
            "kind": "file", "byteLength": file.bytes.len(),
            "base64": base64::engine::general_purpose::STANDARD.encode(file.bytes) }));
        }
        captured.sort_by(|a, b| a["relativePath"].as_str().cmp(&b["relativePath"].as_str()));
        Ok(json!({ "scopeID": handle, "quiescent": true, "entries": captured }))
    }

    /// Safe to repeat after disposal; an active/uncertain runtime is not released.
    /// Auth owner must finish its operation-local credential removal first.
    pub(crate) fn release(&self, handle: &str) -> Result<()> {
        let mut entries = self.entries.lock().map_err(|_| BridgeError::Scope)?;
        if let Some(entry) = entries.get(handle) {
            if entry.starting {
                return Err(BridgeError::NotReady);
            }
            if entry
                .runtime
                .as_ref()
                .is_some_and(|runtime| !runtime.close_confirmed.load(Ordering::Acquire))
            {
                return Err(BridgeError::NotReady);
            }
            if let Some(scope) = &entry.scope {
                scope.dispose().map_err(|_| BridgeError::Scope)?;
            }
        }
        entries.remove(handle);
        Ok(())
    }
}

/// Owns the native reader, its ordered bounded retention, and join evidence.
/// Only this task calls backend.next_event; JS only reads retained events.
struct PumpedRuntime {
    backend: Arc<ProviderBackend>,
    scope: Arc<BoundScope>,
    events: AsyncMutex<mpsc::Receiver<RetainedEvent>>,
    pump: AsyncMutex<Option<JoinHandle<()>>>,
    result: watch::Receiver<Option<PumpResult>>,
    close_confirmed: AtomicBool,
}

struct RetainedEvent {
    bytes: Vec<u8>,
    _budget: OwnedSemaphorePermit,
}

impl PumpedRuntime {
    fn start(
        handle: String,
        backend: Arc<ProviderBackend>,
        scope: Arc<BoundScope>,
        native_requests: Option<Arc<dyn NativeServerRequestHandler>>,
    ) -> Self {
        let (event_tx, events) = mpsc::channel(MAX_RETAINED_EVENTS);
        let budget = Arc::new(Semaphore::new(MAX_RETAINED_BYTES));
        let (result_tx, result) = watch::channel(None);
        let pump_backend = backend.clone();
        let pump_scope = scope.clone();
        let pump = tokio::spawn(async move {
            let result = pump_events(
                &handle,
                &pump_backend,
                native_requests.as_deref(),
                &event_tx,
                &budget,
            )
            .await;
            if result.is_err() {
                // A failed intercept/delivery never becomes a clean close merely
                // because the backend itself can stop. Preserve the reuse barrier.
                pump_scope.close_admission();
                let _ = pump_backend.close().await;
                pump_scope.runtime_closed(false);
            }
            // The retained tail remains readable. EOF has an authoritative
            // success/error state before the queue's only sender disappears.
            result_tx.send_replace(Some(result));
            drop(event_tx);
        });
        Self {
            backend,
            scope,
            events: AsyncMutex::new(events),
            pump: AsyncMutex::new(Some(pump)),
            result,
            close_confirmed: AtomicBool::new(false),
        }
    }

    async fn next_event(&self) -> std::result::Result<Option<Value>, BackendError> {
        if let Some(event) = self.events.lock().await.recv().await {
            return serde_json::from_slice(&event.bytes)
                .map(Some)
                .map_err(|_| BackendError::InvalidMessage);
        }
        match self.result.borrow().as_ref() {
            Some(Ok(())) => Ok(None),
            Some(Err(error)) => Err(error.clone()),
            None => Err(BackendError::Transport),
        }
    }

    async fn join_pump(&self) -> PumpResult {
        let mut pump = self.pump.lock().await;
        if let Some(task) = pump.as_mut() {
            let joined = tokio::time::timeout(PUMP_JOIN_TIMEOUT, &mut *task).await;
            let failed = match joined {
                Ok(result) => result.is_err(),
                Err(_) => {
                    task.abort();
                    let _ = (&mut *task).await;
                    true
                }
            };
            pump.take();
            if failed {
                return Err(BackendError::Transport);
            }
        }
        self.result
            .borrow()
            .clone()
            .unwrap_or(Err(BackendError::Transport))
    }
}

async fn pump_events(
    handle: &str,
    backend: &ProviderBackend,
    native_requests: Option<&dyn NativeServerRequestHandler>,
    events: &mpsc::Sender<RetainedEvent>,
    budget: &Arc<Semaphore>,
) -> PumpResult {
    while let Some(event) = backend.next_event().await? {
        if let InProcessServerEvent::ServerRequest(request) = &event {
            if let Some(handler) = native_requests {
                let response =
                    tokio::time::timeout(NATIVE_REQUEST_TIMEOUT, handler.handle(handle, request))
                        .await
                        .map_err(|_| BackendError::RequestTimeout)?;
                if let Some(response) = response {
                    backend.respond(request.id().clone(), response).await?;
                    continue;
                }
            }
        }
        let bytes = encode_event(event)?;
        // Bound both event count and serialized bytes. Wait for a consumer,
        // without replacing/dropping an event to make room. Failure to retain
        // within the deadline fails the operation; it can never attest delivery.
        tokio::time::timeout(EVENT_DELIVERY_TIMEOUT, async {
            let permit = budget
                .clone()
                .acquire_many_owned(bytes.len().max(1) as u32)
                .await
                .map_err(|_| BackendError::Closed)?;
            events
                .send(RetainedEvent {
                    bytes,
                    _budget: permit,
                })
                .await
                .map_err(|_| BackendError::Closed)
        })
        .await
        .map_err(|_| BackendError::Overloaded)??;
    }
    Ok(())
}

fn encode_event(event: InProcessServerEvent) -> std::result::Result<Vec<u8>, BackendError> {
    let (kind, value) = match event {
        InProcessServerEvent::ServerNotification(notification) => {
            ("notification", serde_json::to_value(notification))
        }
        InProcessServerEvent::ServerRequest(request) => {
            ("server_request", serde_json::to_value(request))
        }
        InProcessServerEvent::Lagged { .. } => return Err(BackendError::Transport),
    };
    let mut value = value.map_err(|_| BackendError::InvalidMessage)?;
    value
        .as_object_mut()
        .ok_or(BackendError::InvalidMessage)?
        .insert("kind".into(), json!(kind));
    struct LimitedBytes(Vec<u8>);
    impl Write for LimitedBytes {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > MAX_RETAINED_BYTES.saturating_sub(self.0.len()) {
                return Err(io::Error::other("native event exceeds retention budget"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut bytes = LimitedBytes(Vec::new());
    serde_json::to_writer(&mut bytes, &value).map_err(|_| BackendError::MessageTooLarge)?;
    Ok(bytes.0)
}
