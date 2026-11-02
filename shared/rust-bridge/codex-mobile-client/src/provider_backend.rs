//! Private native App Server transport below the ProviderAdapter.
//!
//! Requires patches/codex-provider-backend and the existing iOS Code Mode feature.
//! Main supplies a fresh immutable execution context, resolved App Server args,
//! and the existing official V8-backed CodeModeSessionProvider. No process-global
//! execution selection, process environment changes, handshake synthesis, or TAH
//! decisions occur here. Scope admission and guest/native I/O quiescence remain
//! the scope owner's responsibility; close proves only the listed runtime stages.

use crate::embedded_runtime::EmbeddedRuntime;
use codex_app_server::in_process::{
    InProcessClientHandle, InProcessServerEvent, InProcessShutdownReceipt, InProcessStartArgs,
    start_uninitialized_with_code_mode_provider,
};
use codex_app_server_protocol::{ClientNotification, ClientRequest, JSONRPCErrorError, RequestId};
use codex_code_mode_protocol::CodeModeSessionProvider;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::future::Future;
use std::io::{self, Write};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use tokio::task::{JoinHandle, JoinSet};

const MAX_PENDING: usize = 32;
const MAX_EVENTS: usize = 256;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

type Result<T> = std::result::Result<T, BackendError>;

#[derive(Clone, Debug)]
pub(crate) enum BackendError {
    Closed,
    Overloaded,
    InvalidMessage,
    MessageTooLarge,
    UnknownServerRequest,
    RequestTimeout,
    Transport,
    Configuration,
    Rpc(JSONRPCErrorError),
    CloseIncomplete(RuntimeCloseReceipt),
}

/// This is deliberately not a process exit code or an execution-scope receipt.
/// The Adapter must still consume/validate retained tail events. The scope owner
/// must separately close its fence and establish guest/file-operation quiescence.
#[derive(Clone, Debug)]
pub(crate) struct RuntimeCloseReceipt {
    pub app_server: InProcessShutdownReceipt,
    pub bridge_requests_joined: bool,
    pub events_retained: bool,
    pub scope: ScopeCloseReceipt,
}

#[derive(Clone, Debug)]
pub(crate) enum ScopeCloseReceipt {
    /// Foundation transport only; this cannot authorize workspace capture/reuse.
    NotAttached,
    Quiescent {
        scope_id: String,
    },
    Incomplete,
}

/// A trusted capability owner, implemented by the standalone scope factory.
/// Runtime outcome and execution quiescence are separate observations. The owner
/// must retain its admission/reuse barrier after any incomplete runtime close.
pub(crate) trait ProviderExecutionScope: Send + Sync {
    fn claim_runtime(&self) -> io::Result<()>;
    fn execution(&self) -> Arc<EmbeddedRuntime>;
    fn close_admission(&self);
    fn runtime_closed(&self, complete: bool);
    fn drain(&self) -> Pin<Box<dyn Future<Output = io::Result<String>> + Send + '_>>;
}

impl RuntimeCloseReceipt {
    pub(crate) fn is_complete(&self) -> bool {
        self.app_server.is_complete()
            && self.bridge_requests_joined
            && self.events_retained
            && !matches!(self.scope, ScopeCloseReceipt::Incomplete)
    }
}

enum Command {
    Request {
        request: ClientRequest,
        reply: oneshot::Sender<Result<Value>>,
        budget: OwnedSemaphorePermit,
    },
    Notify {
        notification: ClientNotification,
        reply: oneshot::Sender<Result<()>>,
        _budget: OwnedSemaphorePermit,
    },
    Respond {
        request_id: RequestId,
        response: std::result::Result<Value, JSONRPCErrorError>,
        reply: oneshot::Sender<Result<()>>,
        _budget: OwnedSemaphorePermit,
    },
}

struct QueuedEvent {
    event: InProcessServerEvent,
    _budget: OwnedSemaphorePermit,
}

/// One connection, one event consumer, one immutable context. Share with Arc if
/// needed; do not share a sender or context across independently started runtimes.
pub(crate) struct ProviderBackend {
    commands: mpsc::Sender<Command>,
    events: Mutex<mpsc::Receiver<QueuedEvent>>,
    command_budget: Arc<Semaphore>,
    next_id: AtomicI64,
    closing: watch::Sender<bool>,
    closed: watch::Receiver<Option<Result<RuntimeCloseReceipt>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl ProviderBackend {
    /// No initialize request is sent here. args.initialize is unused by the raw
    /// upstream entry; the Adapter supplies real initialize/initialized messages.
    /// Config/auth/network loading is already complete in the caller's args.
    pub(crate) async fn start(
        execution: Arc<EmbeddedRuntime>,
        args: InProcessStartArgs,
        code_mode: Arc<dyn CodeModeSessionProvider>,
    ) -> Result<Self> {
        Self::start_inner(execution, args, code_mode, None).await
    }

    /// Production entry: close admission, drain the actual native runtime, then
    /// require the same immutable scope's guest/native I/O quiescence evidence.
    pub(crate) async fn start_scoped(
        scope: Arc<dyn ProviderExecutionScope>,
        args: InProcessStartArgs,
        code_mode: Arc<dyn CodeModeSessionProvider>,
    ) -> Result<Self> {
        scope.claim_runtime().map_err(|_| BackendError::Closed)?;
        Self::start_inner(scope.execution(), args, code_mode, Some(scope)).await
    }

    async fn start_inner(
        execution: Arc<EmbeddedRuntime>,
        mut args: InProcessStartArgs,
        code_mode: Arc<dyn CodeModeSessionProvider>,
        scope: Option<Arc<dyn ProviderExecutionScope>>,
    ) -> Result<Self> {
        if args.enable_codex_api_key_env || !args.strict_config {
            return Err(BackendError::Configuration);
        }
        // Never trust an unrelated manager left in a reused StartArgs value.
        // This validates the resolved config and constructs a fresh manager from
        // exactly the supplied immutable execution/file view and HTTP factory.
        args.environment_manager = execution
            .manager(&args.config)
            .map_err(|_| BackendError::Configuration)?;
        // The bound context pins the complete mobile native profile, including
        // Code Mode, model and effort. Never append qualification overrides or
        // silently replace a caller's selected settings.
        if args.cli_overrides != execution.config_overrides() {
            return Err(BackendError::Configuration);
        }
        if args.channel_capacity == 0 || args.channel_capacity > MAX_EVENTS {
            return Err(BackendError::Configuration);
        }
        let handle = start_uninitialized_with_code_mode_provider(args, code_mode)
            .await
            .map_err(|_| BackendError::Transport)?;
        // There is no await between receiving ownership of the runtime and
        // transferring it to the worker. Cancelling later calls cannot detach it.
        let (commands, command_rx) = mpsc::channel(MAX_PENDING);
        let (event_tx, events) = mpsc::channel(MAX_EVENTS);
        let (closing, close_rx) = watch::channel(false);
        let (closed_tx, closed) = watch::channel(None);
        let worker = tokio::spawn(run(
            handle, execution, scope, command_rx, event_tx, close_rx, closed_tx,
        ));
        Ok(Self {
            commands,
            events: Mutex::new(events),
            command_budget: Arc::new(Semaphore::new(MAX_BYTES)),
            next_id: AtomicI64::new(1),
            closing,
            closed,
            worker: Mutex::new(Some(worker)),
        })
    }

    /// Method/params facade; deserialization uses the actual upstream enum.
    /// IDs are connection-owned and never reused, including cancelled requests.
    pub(crate) async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.admit()?;
        let request_id = self
            .next_id
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| BackendError::Overloaded)?;
        let wire = json!({ "id": request_id, "method": method, "params": params });
        let budget = charge(&self.command_budget, &wire)?;
        let request: ClientRequest =
            serde_json::from_value(wire).map_err(|_| BackendError::InvalidMessage)?;
        let (reply, result) = oneshot::channel();
        self.enqueue(Command::Request {
            request,
            reply,
            budget,
        })?;
        result.await.map_err(|_| BackendError::Closed)?
    }

    pub(crate) async fn notify(&self, method: &str, params: Option<Value>) -> Result<()> {
        self.admit()?;
        let wire = match params {
            Some(params) => json!({ "method": method, "params": params }),
            None => json!({ "method": method }),
        };
        let budget = charge(&self.command_budget, &wire)?;
        let notification: ClientNotification =
            serde_json::from_value(wire).map_err(|_| BackendError::InvalidMessage)?;
        let (reply, result) = oneshot::channel();
        self.enqueue(Command::Notify {
            notification,
            reply,
            _budget: budget,
        })?;
        result.await.map_err(|_| BackendError::Closed)?
    }

    /// Used only for an actual native server request observed on this connection.
    /// Auth token refresh plumbing uses this same private typed boundary.
    pub(crate) async fn respond(
        &self,
        request_id: RequestId,
        response: std::result::Result<Value, JSONRPCErrorError>,
    ) -> Result<()> {
        self.admit()?;
        let budget = charge(&self.command_budget, &response)?;
        let (reply, result) = oneshot::channel();
        self.enqueue(Command::Respond {
            request_id,
            response,
            reply,
            _budget: budget,
        })?;
        result.await.map_err(|_| BackendError::Closed)?
    }

    /// Ordered native events, with a single consumer; no business normalization.
    /// Continue polling alongside close() to consume the actual shutdown tail.
    pub(crate) async fn next_event(&self) -> Result<Option<InProcessServerEvent>> {
        let event = self.events.lock().await.recv().await;
        if let Some(event) = event {
            return Ok(Some(event.event));
        }
        match self.closed.borrow().as_ref() {
            Some(Ok(_)) => Ok(None),
            Some(Err(error)) => Err(error.clone()),
            None => Err(BackendError::Transport),
        }
    }

    /// Idempotent and cancellation-safe: the owned worker continues cleanup if a
    /// caller drops this future. Success requires evidence, never a synthetic 0.
    pub(crate) async fn close(&self) -> Result<RuntimeCloseReceipt> {
        self.closing.send_replace(true);
        let mut closed = self.closed.clone();
        let result = loop {
            if let Some(result) = closed.borrow_and_update().clone() {
                break result;
            }
            if closed.changed().await.is_err() {
                break Err(BackendError::Transport);
            }
        };
        let mut worker = self.worker.lock().await;
        if let Some(task) = worker.as_mut() {
            let joined = task.await;
            worker.take();
            if joined.is_err() {
                return Err(BackendError::Transport);
            }
        }
        result
    }

    fn admit(&self) -> Result<()> {
        if *self.closing.borrow() || self.closed.borrow().is_some() {
            Err(BackendError::Closed)
        } else {
            Ok(())
        }
    }

    fn enqueue(&self, command: Command) -> Result<()> {
        self.admit()?;
        self.commands
            .try_send(command)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => BackendError::Overloaded,
                mpsc::error::TrySendError::Closed(_) => BackendError::Closed,
            })
    }
}

impl Drop for ProviderBackend {
    fn drop(&mut self) {
        // Drop requests cleanup; only awaiting close() supplies a receipt.
        self.closing.send_replace(true);
    }
}

async fn run(
    mut handle: InProcessClientHandle,
    execution: Arc<EmbeddedRuntime>,
    scope: Option<Arc<dyn ProviderExecutionScope>>,
    mut commands: mpsc::Receiver<Command>,
    events: mpsc::Sender<QueuedEvent>,
    mut closing: watch::Receiver<bool>,
    closed: watch::Sender<Option<Result<RuntimeCloseReceipt>>>,
) {
    let sender = handle.sender();
    let event_budget = Arc::new(Semaphore::new(MAX_BYTES));
    let mut requests = JoinSet::new();
    let mut server_requests = HashSet::new();
    let mut bridge_ok = true;
    let mut events_ok = true;
    loop {
        if *closing.borrow() {
            break;
        }
        tokio::select! {
            biased;
            _ = closing.changed() => break,
            joined = requests.join_next(), if !requests.is_empty() => {
                if joined.is_some_and(|result| result.is_err()) { bridge_ok = false; break; }
            }
            command = commands.recv() => {
                // A close racing enqueue must not admit that queued command.
                if *closing.borrow() { break; }
                match command {
                    Some(Command::Request { request, mut reply, budget }) => {
                        if requests.len() >= MAX_PENDING {
                            let _ = reply.send(Err(BackendError::Overloaded));
                            continue;
                        }
                        let sender = sender.clone();
                        requests.spawn(async move {
                            let _budget = budget;
                            let result = tokio::select! {
                                _ = reply.closed() => return,
                                result = tokio::time::timeout(REQUEST_TIMEOUT, sender.request(request)) => {
                                    match result {
                                        Ok(Ok(Ok(value))) => bounded_size(&value).map(|_| value),
                                        Ok(Ok(Err(error))) => match bounded_size(&error) {
                                            Ok(_) => Err(BackendError::Rpc(error)),
                                            Err(error) => Err(error),
                                        },
                                        Ok(Err(_)) => Err(BackendError::Transport),
                                        Err(_) => Err(BackendError::RequestTimeout),
                                    }
                                }
                            };
                            let _ = reply.send(result);
                        });
                    }
                    Some(Command::Notify { notification, reply, .. }) => {
                        let result = sender.notify(notification).map_err(|_| BackendError::Transport);
                        let _ = reply.send(result);
                    }
                    Some(Command::Respond { request_id, response, reply, .. }) => {
                        let result = if server_requests.remove(&request_id) {
                            match response {
                                Ok(value) => sender.respond_to_server_request(request_id, value),
                                Err(error) => sender.fail_server_request(request_id, error),
                            }.map_err(|_| BackendError::Transport)
                        } else { Err(BackendError::UnknownServerRequest) };
                        let _ = reply.send(result);
                    }
                    None => break,
                }
            }
            event = handle.next_event() => {
                let Some(event) = event else { events_ok = false; break; };
                if let InProcessServerEvent::ServerRequest(request) = &event {
                    if server_requests.len() >= MAX_PENDING || !server_requests.insert(request.id().clone()) {
                        events_ok = false;
                        break;
                    }
                }
                if queue_event(event, &events, &event_budget).is_err() {
                    events_ok = false;
                    break;
                }
            }
        }
    }
    if let Some(scope) = &scope {
        scope.close_admission();
    }
    commands.close();
    // Reject queued calls explicitly. Request futures already sent to upstream
    // remain owned until shutdown settles them; no detached per-request tasks.
    while let Ok(command) = commands.try_recv() {
        match command {
            Command::Request { reply, .. } => {
                let _ = reply.send(Err(BackendError::Closed));
            }
            Command::Notify { reply, .. } | Command::Respond { reply, .. } => {
                let _ = reply.send(Err(BackendError::Closed));
            }
        }
    }
    drop(sender);
    let native_close = handle
        .shutdown_with_events(|event| {
            queue_event(event, &events, &event_budget).map_err(|_| {
                events_ok = false;
                io::Error::other("native event delivery incomplete")
            })
        })
        .await;
    // Native shutdown cancels outstanding responses. Also bound bridge-task
    // ownership if transport failure left a sender waiting for its response.
    let joined = tokio::time::timeout(Duration::from_secs(1), async {
        while let Some(result) = requests.join_next().await {
            bridge_ok &= result.is_ok();
        }
    })
    .await;
    if joined.is_err() {
        bridge_ok = false;
        requests.abort_all();
        while requests.join_next().await.is_some() {}
    }
    let runtime_complete = native_close
        .as_ref()
        .is_ok_and(|receipt| receipt.is_complete())
        && bridge_ok
        && events_ok;
    let scope_receipt = if let Some(scope) = &scope {
        scope.runtime_closed(runtime_complete);
        match scope.drain().await {
            Ok(scope_id) => ScopeCloseReceipt::Quiescent { scope_id },
            Err(_) => ScopeCloseReceipt::Incomplete,
        }
    } else {
        ScopeCloseReceipt::NotAttached
    };
    let result = native_close
        .map_err(|_| BackendError::Transport)
        .and_then(|app_server| {
            let receipt = RuntimeCloseReceipt {
                app_server,
                bridge_requests_joined: bridge_ok,
                events_retained: events_ok,
                scope: scope_receipt,
            };
            if receipt.is_complete() {
                Ok(receipt)
            } else {
                Err(BackendError::CloseIncomplete(receipt))
            }
        });
    drop(execution);
    // Publish before closing the event queue so EOF always has an explanation.
    closed.send_replace(Some(result));
    drop(events);
}

fn queue_event(
    event: InProcessServerEvent,
    events: &mpsc::Sender<QueuedEvent>,
    budget: &Arc<Semaphore>,
) -> Result<()> {
    let permit = match &event {
        InProcessServerEvent::ServerNotification(value) => charge(budget, value)?,
        InProcessServerEvent::ServerRequest(value) => charge(budget, value)?,
        InProcessServerEvent::Lagged { .. } => return Err(BackendError::Transport),
    };
    events
        .try_send(QueuedEvent {
            event,
            _budget: permit,
        })
        .map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => BackendError::Overloaded,
            mpsc::error::TrySendError::Closed(_) => BackendError::Closed,
        })
}

fn charge(budget: &Arc<Semaphore>, value: &impl Serialize) -> Result<OwnedSemaphorePermit> {
    let size = bounded_size(value)?.max(1);
    budget
        .clone()
        .try_acquire_many_owned(size as u32)
        .map_err(|_| BackendError::Overloaded)
}

/// Count with a bounded writer; never allocate a second complete wire payload.
fn bounded_size(value: &impl Serialize) -> Result<usize> {
    struct Counter(usize);
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > MAX_BYTES.saturating_sub(self.0) {
                return Err(io::Error::other("native message exceeds byte budget"));
            }
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value).map_err(|_| BackendError::MessageTooLarge)?;
    Ok(counter.0)
}
