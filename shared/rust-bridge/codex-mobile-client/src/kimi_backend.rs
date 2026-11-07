//! Owned Kimi guest and native HTTPS transport. Credentials never enter guest IO.
//! The guest owns SDK/TAH semantics. This module owns transport admission, bounded
//! FIFO delivery and the process/HTTP drain required before scope capture.

use crate::provider_scope::GuestScope;
use base64::Engine;
use codex_exec_server::{ExecOutputStream, ExecProcess, WriteStatus};
use futures::StreamExt;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderName, HeaderValue};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use tokio::task::{AbortHandle, JoinHandle, JoinSet};

const PREFIX: &[u8] = b"__ALMA_KIMI__";
const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
// SSE framing repeats JSON metadata per token and can exceed a fetched page's
// byte limit well before the model has generated one long document.
const MAX_MODEL_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_EVENTS: usize = 256;
const MAX_EVENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_REQUESTS: u64 = 128;
const MAX_ACTIVE_REQUESTS: usize = 4;
const CHUNK_BYTES: usize = 8192;
const WRITE_BYTES: usize = 32 * 1024;
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const ACK_TIMEOUT: Duration = Duration::from_secs(30);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(20);
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(30 * 60);
type Result<T> = io::Result<T>;
type TransportResult<T> = std::result::Result<T, &'static str>;

fn error(category: &'static str) -> io::Error {
    io::Error::other(category)
}

fn process_failure_category(message: &str) -> &'static str {
    match message {
        "iSH output budget exceeded" => "kimi_process_output_limit",
        "iSH retained output was lost before collection" => "kimi_process_output_lost",
        "iSH output transport failed" => "kimi_process_output_transport_failed",
        "iSH session reported failure" => "kimi_process_session_failed",
        "iSH closed without a valid startup and exit status" => "kimi_process_invalid_close",
        "owned cancellation was not acknowledged" => "kimi_process_cancel_unacknowledged",
        "owned lease finalization failed" => "kimi_process_lease_failed",
        _ => "kimi_process_failed",
    }
}

fn failed(category: &'static str) -> Value {
    let family = if category == "kimi_cleanup_incomplete" { "cleanup" } else { "provider_availability" };
    json!({"kind":"failed", "failure": {"family":family,
        "code":category, "message":"Kimi transport could not complete the attempt.", "retryable":true}})
}

struct RetainedEvent {
    event: Value,
    _budget: OwnedSemaphorePermit,
}

#[derive(Clone)]
struct Completion {
    terminal: Value,
    complete: bool,
}

pub(crate) struct KimiBackend {
    events: Mutex<mpsc::Receiver<RetainedEvent>>,
    stop: watch::Sender<bool>,
    result: watch::Receiver<Option<Completion>>,
    owner: Mutex<Option<JoinHandle<()>>>,
}

impl KimiBackend {
    pub(crate) async fn start(
        scope: Arc<GuestScope>,
        attempt: Value,
        credential: Arc<str>,
    ) -> Result<Arc<Self>> {
        let prepared = Self::prepare(&scope, &attempt, &credential);
        let (policy, client, authorization, initial) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                // Nothing was spawned, so the saved scope can be safely released.
                let _ = scope.finish(true).await;
                return Err(error);
            }
        };
        let mut env = scope.layout().shell_environment.clone();
        env.insert(
            "KIMI_CODE_HOME".into(),
            format!("{}/home", scope.layout().scratch_root),
        );
        // The SDK's transport binding is installed by the trusted runtime.
        env.insert("ALMA_KIMI_FETCH_BINDINGS".into(), "node-fetch".into());
        let process = match scope
            .spawn(
                vec![
                    "/usr/bin/node".into(),
                    "/workspace/.runtime/kimi/guest.mjs".into(),
                ],
                env,
            )
            .await
        {
            Ok(process) => process,
            Err(_) => {
                // A failed spawn has no owned handle with which to prove closure.
                let _ = scope.finish(false).await;
                return Err(error("kimi_spawn_failed"));
            }
        };
        Self::start_owned(scope, process, policy, client, authorization, initial).await
    }

    fn prepare(
        scope: &GuestScope,
        attempt: &Value,
        credential: &str,
    ) -> Result<(RequestPolicy, reqwest::Client, HeaderValue, Vec<u8>)> {
        let policy = RequestPolicy::new(&attempt).map_err(error)?;
        if credential.is_empty() || credential.len() > 4096 {
            return Err(error("kimi_credential_invalid"));
        }
        let mut authorization = HeaderValue::from_str(&format!("Bearer {credential}"))
            .map_err(|_| error("kimi_credential_invalid"))?;
        authorization.set_sensitive(true);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| error("kimi_http_unavailable"))?;
        let initial = encode(&json!({"kind":"start", "attempt":attempt,
            "workspaceRoot":scope.layout().workspace_root, "scratchRoot":scope.layout().scratch_root}))
            .map_err(error)?;
        Ok((policy, client, authorization, initial))
    }

    async fn start_owned(
        scope: Arc<GuestScope>,
        process: Arc<dyn ExecProcess>,
        policy: RequestPolicy,
        client: reqwest::Client,
        authorization: HeaderValue,
        initial: Vec<u8>,
    ) -> Result<Arc<Self>> {
        let (event_tx, events) = mpsc::channel(MAX_EVENTS);
        let (stop, stopped) = watch::channel(false);
        let (result_tx, result) = watch::channel(None);
        let (ready_tx, ready) = oneshot::channel();
        // No await between obtaining the process and transferring ownership.
        let owner = tokio::spawn(async move {
            let mut actor = Actor::new(process, event_tx, stopped, policy, client, authorization);
            let started = actor.write(&initial).await;
            let _ = ready_tx.send(started);
            let outcome = match started {
                Ok(()) => actor.run().await,
                Err(category) => Err(category),
            };
            let mut terminal = outcome.unwrap_or_else(failed);
            let drained = actor.drain().await;
            let complete = scope.finish(drained).await.is_ok() && drained;
            if !complete {
                terminal = failed("kimi_cleanup_incomplete");
            }
            result_tx.send_replace(Some(Completion { terminal, complete }));
            // Dropping the actor closes the event stream only after the result.
        });
        let backend = Arc::new(Self {
            events: Mutex::new(events),
            stop,
            result,
            owner: Mutex::new(Some(owner)),
        });
        match ready.await {
            Ok(Ok(())) => Ok(backend),
            _ => {
                let _ = backend.close().await;
                Err(error("kimi_start_failed"))
            }
        }
    }

    /// Cancellation-safe FIFO receive. EOF always carries the authoritative terminal.
    pub(crate) async fn next_event(&self) -> Result<Value> {
        if let Some(event) = self.events.lock().await.recv().await {
            return Ok(json!({"done":false, "event":event.event}));
        }
        let terminal = self
            .result
            .borrow()
            .as_ref()
            .map(|result| result.terminal.clone())
            .unwrap_or_else(|| failed("kimi_owner_failed"));
        Ok(json!({"done":true, "terminal":terminal}))
    }

    /// Returns only after native transport/process owners have finished cleanup.
    pub(crate) async fn cancel(&self) -> Result<()> {
        self.stop.send_replace(true);
        self.join().await.map(|_| ())
    }

    pub(crate) async fn close(&self) -> Result<Value> {
        self.stop.send_replace(true);
        let result = self.join().await?;
        Ok(
            json!({"kind":"owned_guest", "runtimeClosed":true, "requestsJoined":true,
            "eventsRetained":true, "scopeQuiescent":true, "terminal":result.terminal}),
        )
    }

    async fn join(&self) -> Result<Completion> {
        let mut owner = self.owner.lock().await;
        // Await by reference so cancellation of close does not detach the join handle.
        if let Some(task) = owner.as_mut() {
            let joined = task.await;
            owner.take();
            joined.map_err(|_| error("kimi_owner_failed"))?;
        }
        self.result
            .borrow()
            .clone()
            .filter(|result| result.complete)
            .ok_or_else(|| error("kimi_cleanup_incomplete"))
    }
}

impl Drop for KimiBackend {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

struct RequestPolicy {
    attempt_id: String,
    model: String,
    effort: String,
    web: bool,
}

impl RequestPolicy {
    fn new(attempt: &Value) -> TransportResult<Self> {
        let model = attempt["inference"]["modelID"]
            .as_str()
            .ok_or("kimi_profile_invalid")?;
        let effort = attempt["inference"]["reasoningEffortID"]
            .as_str()
            .ok_or("kimi_profile_invalid")?;
        let attempt_id = attempt["attemptID"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .ok_or("kimi_profile_invalid")?;
        if attempt["providerID"] != "kimi"
            || !matches!(
                model,
                "kimi-for-coding"
                    | "k3-256k"
                    | "k3"
                    | "k3.1-pro"
                    | "k3.1-pro-highspeed"
                    | "kimi-for-coding-highspeed"
            )
            || !matches!(effort, "low" | "high" | "max" | "on")
            || (model == "kimi-for-coding-highspeed") != (effort == "on")
            || attempt["inference"].get("contextWindowTokens").is_some()
        {
            return Err("kimi_profile_invalid");
        }
        let abilities = attempt["requiredAbilities"]
            .as_array()
            .ok_or("kimi_profile_invalid")?;
        Ok(Self {
            attempt_id: attempt_id.into(),
            model: model.into(),
            effort: effort.into(),
            web: abilities.iter().any(|ability| ability == "web"),
        })
    }

    fn request(
        &self,
        frame: &Value,
        client: &reqwest::Client,
        authorization: &HeaderValue,
    ) -> TransportResult<reqwest::Request> {
        let raw_url = frame["url"].as_str().ok_or("kimi_target_denied")?;
        if raw_url.len() > 256 {
            return Err("kimi_target_denied");
        }
        let url = reqwest::Url::parse(raw_url).map_err(|_| "kimi_target_denied")?;
        // Exact textual URL admission also excludes normalized dot segments,
        // percent-encoded paths, fragments, userinfo and explicit port variants.
        let path = raw_url
            .strip_prefix("https://api.kimi.com")
            .ok_or("kimi_target_denied")?;
        let model_route = matches!(path, "/coding/v1/chat/completions" | "/coding/v1/messages");
        if !model_route && !(self.web && matches!(path, "/coding/v1/search" | "/coding/v1/fetch")) {
            return Err("kimi_target_denied");
        }
        if frame["method"] != "POST" {
            return Err("kimi_method_denied");
        }
        let body = frame["body"].as_str().ok_or("kimi_body_invalid")?;
        if body.len() > MAX_BODY_BYTES {
            return Err("kimi_body_limit");
        }
        if model_route {
            let body: Value = serde_json::from_str(body).map_err(|_| "kimi_body_invalid")?;
            let thinking = &body["thinking"];
            if body["model"] != self.model
                || thinking["type"] != "enabled"
                || (self.effort == "on" && thinking.get("effort").is_some())
                || (self.effort != "on" && thinking["effort"] != self.effort)
                || body
                    .get("reasoning_effort")
                    .is_some_and(|effort| effort != &self.effort)
                || body
                    .get("output_config")
                    .is_some_and(|config| config["effort"] != self.effort)
            {
                return Err("kimi_inference_drift");
            }
        }
        let raw_headers = frame["headers"].as_object().ok_or("kimi_headers_invalid")?;
        if raw_headers.len() > 64 {
            return Err("kimi_headers_limit");
        }
        let mut headers = HeaderMap::new();
        let mut size = 0usize;
        for (name, value) in raw_headers {
            let value = value.as_str().ok_or("kimi_headers_invalid")?;
            size += name.len() + value.len();
            if size > MAX_HEADER_BYTES {
                return Err("kimi_headers_limit");
            }
            let name =
                HeaderName::from_bytes(name.as_bytes()).map_err(|_| "kimi_headers_invalid")?;
            let value = HeaderValue::from_str(value).map_err(|_| "kimi_headers_invalid")?;
            // Credential, proxy, cookie, hop-by-hop and framing headers are host-owned.
            if matches!(
                name.as_str(),
                "content-type"
                    | "accept"
                    | "user-agent"
                    | "anthropic-version"
                    | "anthropic-beta"
                    | "x-msh-tool-call-id"
            ) {
                headers.insert(name, value);
            }
        }
        headers.insert(AUTHORIZATION, authorization.clone());
        client
            .post(url)
            .headers(headers)
            .body(body.to_owned())
            .build()
            .map_err(|_| "kimi_request_invalid")
    }
}

struct Operation {
    ack: mpsc::Sender<()>,
    abort: AbortHandle,
    awaiting_ack: bool,
}

struct Outgoing {
    id: u64,
    frame: Value,
    delivered: oneshot::Sender<TransportResult<()>>,
}

struct Actor {
    process: Arc<dyn ExecProcess>,
    wake: watch::Receiver<u64>,
    stopped: watch::Receiver<bool>,
    events: mpsc::Sender<RetainedEvent>,
    budget: Arc<Semaphore>,
    policy: RequestPolicy,
    client: reqwest::Client,
    authorization: HeaderValue,
    operations: HashMap<u64, Operation>,
    tasks: JoinSet<u64>,
    outgoing: mpsc::Sender<Outgoing>,
    incoming: mpsc::Receiver<Outgoing>,
    lines: Lines,
    after: u64,
    last_request: u64,
    request_count: u64,
    event_sequence: u64,
    terminal: Option<Value>,
    stderr_tail: Vec<u8>,
    stderr_category: Option<&'static str>,
}

impl Actor {
    fn new(
        process: Arc<dyn ExecProcess>,
        events: mpsc::Sender<RetainedEvent>,
        stopped: watch::Receiver<bool>,
        policy: RequestPolicy,
        client: reqwest::Client,
        authorization: HeaderValue,
    ) -> Self {
        let (outgoing, incoming) = mpsc::channel(MAX_ACTIVE_REQUESTS);
        Self {
            wake: process.subscribe_wake(),
            process,
            stopped,
            events,
            budget: Arc::new(Semaphore::new(MAX_EVENT_BYTES)),
            policy,
            client,
            authorization,
            operations: HashMap::new(),
            tasks: JoinSet::new(),
            outgoing,
            incoming,
            lines: Lines::default(),
            after: 0,
            last_request: 0,
            request_count: 0,
            event_sequence: 0,
            terminal: None,
            stderr_tail: Vec::new(),
            stderr_category: None,
        }
    }

    fn observe_stderr(&mut self, bytes: &[u8]) {
        // Classify bounded startup/runtime failures without retaining log bodies
        // in public events, disk diagnostics, or error strings.
        let keep = bytes.len().min(4096);
        self.stderr_tail.extend_from_slice(&bytes[bytes.len() - keep..]);
        if self.stderr_tail.len() > 4096 {
            self.stderr_tail.drain(..self.stderr_tail.len() - 4096);
        }
        let text = String::from_utf8_lossy(&self.stderr_tail);
        for (pattern, category) in [
            ("EACCES", "kimi_guest_fs_denied"),
            ("Permission denied", "kimi_guest_fs_denied"),
            ("ERR_MODULE_NOT_FOUND", "kimi_guest_module_missing"),
            ("Cannot find module", "kimi_guest_module_missing"),
            ("WebAssembly is not defined", "kimi_guest_wasm_unavailable"),
            ("heap out of memory", "kimi_guest_heap_exhausted"),
            ("SyntaxError", "kimi_guest_syntax_error"),
        ] {
            if text.contains(pattern) { self.stderr_category = Some(category); }
        }
    }

    async fn write(&mut self, bytes: &[u8]) -> TransportResult<()> {
        if *self.stopped.borrow() {
            return Err("kimi_cancelled");
        }
        tokio::select! {
            biased;
            _ = self.stopped.changed() => Err("kimi_cancelled"),
            result = tokio::time::timeout(WRITE_TIMEOUT, write_bytes(self.process.as_ref(), bytes)) =>
                result.map_err(|_| "kimi_stdin_timeout")?,
        }
    }

    async fn run(&mut self) -> TransportResult<Value> {
        let deadline = tokio::time::sleep(ATTEMPT_TIMEOUT);
        tokio::pin!(deadline);
        let mut read_ready = true;
        loop {
            if *self.stopped.borrow() {
                return Ok(json!({"kind":"cancelled"}));
            }
            tokio::select! {
                biased;
                _ = self.stopped.changed() => return Ok(json!({"kind":"cancelled"})),
                _ = &mut deadline => return Err("kimi_attempt_timeout"),
                joined = self.tasks.join_next(), if !self.tasks.is_empty() => {
                    match joined {
                        Some(Ok(id)) => { self.operations.remove(&id); },
                        Some(Err(error)) if error.is_cancelled() => {},
                        _ => return Err("kimi_http_task_failed"),
                    }
                },
                outgoing = self.incoming.recv() => {
                    let outgoing = outgoing.ok_or("kimi_http_channel_closed")?;
                    let Some(operation) = self.operations.get_mut(&outgoing.id) else { continue; };
                    if outgoing.frame["kind"] == "chunk" {
                        if operation.awaiting_ack { return Err("kimi_ack_invalid"); }
                        operation.awaiting_ack = true;
                    }
                    let result = self.write(&encode(&outgoing.frame)?).await;
                    let _ = outgoing.delivered.send(result);
                    result?;
                },
                page = self.process.read(Some(self.after), Some(64 * 1024), None), if read_ready => {
                    let page = page.map_err(|_| "kimi_process_read_failed")?;
                    if page.sandbox_denied { return Err("kimi_process_sandbox_denied"); }
                    if let Some(failure) = page.failure.as_deref() {
                        return Err(process_failure_category(failure));
                    }
                    read_ready = !page.chunks.is_empty();
                    for chunk in page.chunks {
                        if chunk.seq <= self.after { return Err("kimi_output_sequence_invalid"); }
                        self.after = chunk.seq;
                        match chunk.stream {
                            ExecOutputStream::Stdout => {
                                for frame in self.lines.push(&chunk.chunk.0)? { self.frame(frame)?; }
                            },
                            ExecOutputStream::Stderr => self.observe_stderr(&chunk.chunk.0),
                            ExecOutputStream::Pty => return Err("kimi_unexpected_pty"),
                        }
                    }
                    if let Some(terminal) = self.terminal.take() { return Ok(terminal); }
                    // Closed can accompany a partial retained page. Read all pages
                    // before accepting closure, using the last consumed chunk cursor.
                    if !read_ready {
                        self.after = self.after.max(page.next_seq.saturating_sub(1));
                        if page.closed {
                            return Err(self.stderr_category.unwrap_or(match page.exit_code {
                                Some(1) => "kimi_guest_exit_1",
                                Some(126) => "kimi_guest_not_executable",
                                Some(127) => "kimi_guest_command_missing",
                                Some(134) => "kimi_guest_aborted",
                                Some(137) => "kimi_guest_killed",
                                Some(139) => "kimi_guest_memory_fault",
                                _ => "kimi_terminal_missing",
                            }));
                        }
                    }
                },
                changed = self.wake.changed() => {
                    changed.map_err(|_| "kimi_process_observer_closed")?;
                    read_ready = true;
                },
            }
        }
    }

    fn frame(&mut self, frame: Value) -> TransportResult<()> {
        if self.terminal.is_some() {
            return Err("kimi_frame_after_terminal");
        }
        match frame["kind"].as_str() {
            Some("event") => {
                let event = frame
                    .get("event")
                    .filter(|event| event.is_object())
                    .ok_or("kimi_event_invalid")?;
                if event["attemptID"] != self.policy.attempt_id
                    || event["sequence"].as_u64() != Some(self.event_sequence + 1)
                {
                    return Err("kimi_event_sequence_invalid");
                }
                let size = serde_json::to_vec(event)
                    .map_err(|_| "kimi_event_invalid")?
                    .len();
                let permit = self
                    .budget
                    .clone()
                    .try_acquire_many_owned(size.try_into().map_err(|_| "kimi_event_limit")?)
                    .map_err(|_| "kimi_event_limit")?;
                self.events
                    .try_send(RetainedEvent {
                        event: event.clone(),
                        _budget: permit,
                    })
                    .map_err(|_| "kimi_event_limit")?;
                self.event_sequence += 1;
            }
            Some("terminal") => {
                let terminal = frame.get("terminal").ok_or("kimi_terminal_invalid")?;
                if !matches!(
                    terminal["kind"].as_str(),
                    Some(
                        "end_turn" | "refused" | "maximum_output_reached" | "cancelled" | "failed"
                    )
                ) {
                    return Err("kimi_terminal_invalid");
                }
                self.terminal = Some(terminal.clone());
            }
            Some("http") => {
                let id = request_id(&frame)?;
                if id <= self.last_request
                    || self.request_count >= MAX_REQUESTS
                    || self.operations.len() >= MAX_ACTIVE_REQUESTS
                {
                    return Err("kimi_request_limit");
                }
                let request = self
                    .policy
                    .request(&frame, &self.client, &self.authorization)?;
                let timeout = request_timeout(&request);
                self.last_request = id;
                self.request_count += 1;
                let (ack, acknowledgements) = mpsc::channel(1);
                let client = self.client.clone();
                let outgoing = self.outgoing.clone();
                let abort = self.tasks.spawn(async move {
                    let result = tokio::time::timeout(
                        timeout,
                        http_request(id, client, request, &outgoing, acknowledgements),
                    )
                    .await
                    .unwrap_or(Err("kimi_http_timeout"));
                    if let Err(category) = result {
                        let _ = deliver(
                            &outgoing,
                            id,
                            json!({"kind":"error", "id":id, "message":category}),
                        )
                        .await;
                    }
                    id
                });
                self.operations.insert(
                    id,
                    Operation {
                        ack,
                        abort,
                        awaiting_ack: false,
                    },
                );
            }
            Some("httpAck") => {
                if let Some(operation) = self.operations.get_mut(&request_id(&frame)?) {
                    if !operation.awaiting_ack {
                        return Err("kimi_ack_invalid");
                    }
                    operation.awaiting_ack = false;
                    operation.ack.try_send(()).map_err(|_| "kimi_ack_invalid")?;
                }
            }
            Some("httpCancel") => {
                if let Some(operation) = self.operations.remove(&request_id(&frame)?) {
                    operation.abort.abort();
                }
            }
            _ => return Err("kimi_frame_invalid"),
        }
        Ok(())
    }

    async fn drain(&mut self) -> bool {
        // Every request task is aborted AND joined before process/scope teardown.
        self.tasks.abort_all();
        while self.tasks.join_next().await.is_some() {}
        self.operations.clear();
        self.incoming.close();
        while self.incoming.try_recv().is_ok() {}
        let process = self.process.clone();
        let drain = async {
            let terminated = process.terminate().await.is_ok();
            loop {
                let page = process
                    .read(Some(self.after), Some(64 * 1024), None)
                    .await
                    .map_err(|_| ())?;
                if let Some(last) = page.chunks.last() {
                    if last.seq <= self.after {
                        return Err(());
                    }
                    self.after = last.seq;
                    continue;
                }
                if page.closed {
                    return Ok(());
                }
                if !terminated || page.failure.is_some() {
                    return Err(());
                }
                self.wake.changed().await.map_err(|_| ())?;
            }
        };
        matches!(tokio::time::timeout(DRAIN_TIMEOUT, drain).await, Ok(Ok(())))
    }
}

fn request_id(frame: &Value) -> TransportResult<u64> {
    frame["id"]
        .as_u64()
        .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
        .ok_or("kimi_request_id_invalid")
}

fn encode(frame: &Value) -> TransportResult<Vec<u8>> {
    let mut bytes = serde_json::to_vec(frame).map_err(|_| "kimi_frame_invalid")?;
    if bytes.len() >= MAX_FRAME_BYTES {
        return Err("kimi_frame_limit");
    }
    bytes.push(b'\n');
    Ok(bytes)
}

async fn write_bytes(process: &dyn ExecProcess, bytes: &[u8]) -> TransportResult<()> {
    for chunk in bytes.chunks(WRITE_BYTES) {
        let result = process
            .write(chunk.to_vec())
            .await
            .map_err(|_| "kimi_stdin_failed")?;
        if result.status != WriteStatus::Accepted {
            return Err("kimi_stdin_closed");
        }
    }
    Ok(())
}

#[derive(Default)]
struct Lines {
    bytes: Vec<u8>,
}

impl Lines {
    fn push(&mut self, bytes: &[u8]) -> TransportResult<Vec<Value>> {
        let mut frames = Vec::new();
        for part in bytes.split_inclusive(|byte| *byte == b'\n') {
            if self.bytes.len() + part.len() > MAX_FRAME_BYTES {
                return Err("kimi_frame_limit");
            }
            self.bytes.extend_from_slice(part);
            if part.last() == Some(&b'\n') {
                if let Some(payload) = self.bytes.strip_prefix(PREFIX) {
                    frames.push(serde_json::from_slice(payload).map_err(|_| "kimi_frame_invalid")?);
                }
                self.bytes.clear();
            }
        }
        Ok(frames)
    }
}

async fn deliver(outgoing: &mpsc::Sender<Outgoing>, id: u64, frame: Value) -> TransportResult<()> {
    let (delivered, receipt) = oneshot::channel();
    outgoing
        .send(Outgoing {
            id,
            frame,
            delivered,
        })
        .await
        .map_err(|_| "kimi_http_channel_closed")?;
    receipt.await.map_err(|_| "kimi_http_channel_closed")?
}

fn request_timeout(request: &reqwest::Request) -> Duration {
    // Model streams can remain productive beyond one Web request's total limit.
    // Read inactivity remains bounded by the client, and the attempt owns the
    // overall deadline across all model steps, retries and tools.
    if is_model_request(request) { ATTEMPT_TIMEOUT } else { REQUEST_TIMEOUT }
}

fn is_model_request(request: &reqwest::Request) -> bool {
    matches!(request.url().path(), "/coding/v1/messages" | "/coding/v1/chat/completions")
}

fn http_failure_category(error: reqwest::Error) -> &'static str {
    if error.is_timeout() { "kimi_http_timeout" } else { "kimi_http_failed" }
}

async fn http_request(
    id: u64,
    client: reqwest::Client,
    request: reqwest::Request,
    outgoing: &mpsc::Sender<Outgoing>,
    mut acknowledgements: mpsc::Receiver<()>,
) -> TransportResult<()> {
    let response_limit = if is_model_request(&request) { MAX_MODEL_RESPONSE_BYTES } else { MAX_RESPONSE_BYTES };
    let response = client
        .execute(request)
        .await
        .map_err(http_failure_category)?;
    if response.status().is_redirection() {
        return Err("kimi_redirect_denied");
    }
    if response.headers().len() > 64
        || response
            .headers()
            .iter()
            .map(|(name, value)| name.as_str().len() + value.len())
            .sum::<usize>()
            > MAX_HEADER_BYTES
    {
        return Err("kimi_headers_limit");
    }
    if response
        .content_length()
        .is_some_and(|length| length > response_limit as u64)
    {
        return Err("kimi_response_limit");
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream");
    deliver(
        outgoing,
        id,
        json!({"kind":"headers", "id":id, "status":response.status().as_u16(),
        "headers":{"content-type":content_type}}),
    )
    .await?;
    let mut stream = response.bytes_stream();
    let mut received = 0usize;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(http_failure_category)?;
        received = received
            .checked_add(chunk.len())
            .ok_or("kimi_response_limit")?;
        if received > response_limit {
            return Err("kimi_response_limit");
        }
        for chunk in chunk.chunks(CHUNK_BYTES) {
            deliver(
                outgoing,
                id,
                json!({"kind":"chunk", "id":id,
                "data":base64::engine::general_purpose::STANDARD.encode(chunk)}),
            )
            .await?;
            tokio::time::timeout(ACK_TIMEOUT, acknowledgements.recv())
                .await
                .map_err(|_| "kimi_ack_timeout")?
                .ok_or("kimi_http_cancelled")?;
        }
    }
    deliver(outgoing, id, json!({"kind":"end", "id":id})).await
}

#[cfg(test)]
#[path = "../../../../tools/alma-ios-lab/kimi_backend_regression/transport_tests.rs"]
mod transport_tests;
