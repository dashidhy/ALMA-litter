//! Unintegrated Codex 0.166 adapter for the opt-in owned-job iSH API.
//!
//! Requires patches/ish-lifecycle plus a trusted, enforcing policy/lease provider.
//! No production policy implementation, environment bootstrap or filesystem gate
//! is supplied here. Never log argv, env, input, output or policy data.

use codex_exec_server::{ExecBackend, ExecBackendFuture, ExecOutputStream, ExecParams, ExecProcess,
    ExecProcessEvent, ExecProcessEventLog, ExecProcessEventReceiver, ExecProcessFuture, ExecServerError,
    ProcessId, ProcessOutputChunk, ProcessSignal, ReadResponse, StartedExecProcess, WriteResponse,
    WriteStatus};
use ish_embed_host::{IshInstance, IshSession, SpawnOpts, Stream, WorkspaceGrant, WriteStatus as IshWriteStatus};
use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::{Notify, watch};

const OUTPUT_BYTES: usize = 1024 * 1024;
const OUTPUT_CHUNKS: usize = 4096;
const CHUNK_BYTES: usize = 8192;
const STDIN_BYTES: usize = 1024 * 1024;
const ACTIVE_PROCESSES: usize = 64;
const START_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

fn error(message: &'static str) -> ExecServerError { ExecServerError::Protocol(message.into()) }
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Static categories prevent accidental plaintext policy/request disclosure.
#[derive(Debug, Clone, Copy)]
pub enum PolicyError { Denied, Unsupported, NotReady, UnsupportedContext(&'static str) }

/// The provider must actually enforce sandbox, network, guest mapping and env
/// policy before returning. It must reject unknown/unsupported intent. Cancellation
/// of prepare must not leave a permissive lease or reusable dirty workspace.
/// A callback returning Ok is not evidence that enforcement was implemented.
pub trait ExecutionPolicy: Send + Sync {
    fn prepare<'a>(&'a self, request: &'a ExecParams)
        -> Pin<Box<dyn Future<Output = Result<PreparedExecution, PolicyError>> + Send + 'a>>;
}

pub struct PreparedExecution {
    pub options: SpawnOpts,
    /// An opaque host-issued grant; required by the sealed policy boot mode.
    pub grant: Option<Arc<WorkspaceGrant>>,
    pub lease: Box<dyn ExecutionLease>,
}

/// A host-owned exclusive attempt lease. Drop alone must NEVER authorize reuse.
/// complete is called only after mode-3 Closed; on error, quarantine is called.
/// quarantine must preserve the deny/reuse barrier beyond this object's lifetime.
pub trait ExecutionLease: Send + Sync {
    fn not_started(self: Box<Self>);
    fn complete(&mut self) -> Result<(), PolicyError>;
    fn quarantine(self: Box<Self>);
}

pub struct IshExecBackend {
    instance: Arc<IshInstance>,
    policy: Arc<dyn ExecutionPolicy>,
    cleanup_timeout: Duration,
    active: Arc<Mutex<HashSet<String>>>,
    stdin_budget: usize,
    output_budget: usize,
    output_chunks: usize,
    consumed_output: bool,
}

impl IshExecBackend {
    /// Trusted attempt controller observation; this does not cancel or admit work.
    pub fn active_process_count(&self) -> usize { lock(&self.active).len() }
    pub fn new(instance: Arc<IshInstance>, policy: Arc<dyn ExecutionPolicy>, cleanup_timeout: Duration)
        -> Result<Self, ExecServerError> {
        if !instance.owned_jobs_enabled() { return Err(error("owned iSH supervisor is not ready")); }
        if cleanup_timeout.is_zero() || cleanup_timeout > Duration::from_secs(120) {
            return Err(error("invalid owned cleanup deadline"));
        }
        Ok(Self { instance, policy, cleanup_timeout, active: Arc::default(), stdin_budget: STDIN_BYTES, output_budget: OUTPUT_BYTES, output_chunks: OUTPUT_CHUNKS, consumed_output: false })
    }
    /// A provider protocol may carry bounded HTTP response bytes over owned
    /// stdin. Keep the default shell limit and opt in explicitly for that lane.
    pub fn with_stdin_budget(mut self, bytes: usize) -> Result<Self, ExecServerError> {
        if !(STDIN_BYTES..=32 * 1024 * 1024).contains(&bytes) {
            return Err(error("invalid stdin submission budget"));
        }
        self.stdin_budget = bytes;
        Ok(self)
    }
    pub fn with_output_budget(mut self, bytes: usize) -> Result<Self, ExecServerError> {
        if !(OUTPUT_BYTES..=32 * 1024 * 1024).contains(&bytes) {
            return Err(error("invalid output retention budget"));
        }
        self.output_budget = bytes;
        self.output_chunks = OUTPUT_CHUNKS.max(bytes / 1024);
        Ok(self)
    }
    /// Opt-in protocol lane with one authoritative reader. Each read cursor
    /// acknowledges previously delivered output, freeing its retained storage.
    /// Rewinding after acknowledgment is rejected. Shell replay keeps the default.
    pub fn with_consumed_output(mut self) -> Self {
        self.consumed_output = true;
        self
    }
}

struct Reservation { active: Arc<Mutex<HashSet<String>>>, id: String, armed: bool }
impl Drop for Reservation {
    fn drop(&mut self) { if self.armed { lock(&self.active).remove(&self.id); } }
}

fn supported(params: &ExecParams) -> Result<(), ExecServerError> {
    if params.argv.first().is_none_or(String::is_empty) || params.argv.iter().any(|s| s.contains('\0'))
        || params.arg0.as_ref().is_some_and(|s| s.contains('\0')) {
        return Err(error("invalid guest argv"));
    }
    // Pinned supervisor uses execve, not PATH search. Require the guest executable
    // explicitly (normally /bin/bash from ShellInfo) rather than running a cwd file.
    if !std::path::Path::new(&params.argv[0]).is_absolute() {
        return Err(error("absolute guest executable is required"));
    }
    // iSH arg0 selects an executable path, unlike Core’s argv0 override. Refuse
    // it rather than accidentally executing a different program. PTY, snapshot
    // and executor proxy launch are also outside this initial adapter.
    if params.arg0.is_some() || params.tty || params.shell_snapshot.is_some() || params.network_proxy.is_some() {
        return Err(error("unsupported iSH execution capability"));
    }
    if params.enforce_managed_network && params.managed_network.is_none() {
        return Err(error("managed-network enforcement context is missing"));
    }
    Ok(())
}

fn validate_prepared(params: &ExecParams, options: &SpawnOpts) -> Result<(), ExecServerError> {
    let cwd = params.cwd.to_abs_path().map_err(|_| error("unsupported guest cwd"))?;
    if options.argv != params.argv || options.arg0 != params.arg0 || options.tty
        || options.size.is_some() || options.pipe_stdin != params.pipe_stdin
        || options.cwd.as_deref() != Some(cwd.as_path()) {
        return Err(error("policy provider changed command execution intent"));
    }
    let env = options.envp.as_ref().ok_or_else(|| error("explicit guest environment is required"))?;
    let mut names = HashSet::new();
    for (name, value) in env {
        if name.is_empty() || name.contains(['=', '\0']) || value.contains('\0') || !names.insert(name) {
            return Err(error("invalid prepared guest environment"));
        }
    }
    for (key, value) in &params.env {
        if !env.iter().any(|(k, v)| k == key && v == value) {
            return Err(error("policy provider dropped an explicit environment value"));
        }
    }
    Ok(())
}

impl ExecBackend for IshExecBackend {
    fn start(&self, params: ExecParams) -> ExecBackendFuture<'_> {
        Box::pin(async move {
            supported(&params)?;
            if tokio::runtime::Handle::try_current().is_err() { return Err(error("Tokio runtime is required")); }
            if !self.instance.owned_jobs_enabled() { return Err(error("owned iSH supervisor is not ready")); }
            let id = params.process_id.as_str().to_owned();
            if id.is_empty() || id.len() > 128 { return Err(error("invalid process id")); }
            {
                let mut active = lock(&self.active);
                if active.contains(&id) { return Err(error("process id is already owned")); }
                if active.len() >= ACTIVE_PROCESSES { return Err(error("owned process capacity exhausted")); }
                active.insert(id.clone());
            }
            let mut reservation = Reservation { active: self.active.clone(), id, armed: true };
            let events = ExecProcessEventLog::bounded(self.output_chunks + 4, self.output_budget + 4096)?;
            let prepared = self.policy.prepare(&params).await
                .map_err(|reason| error(match reason {
                    PolicyError::Denied => "execution policy denied",
                    PolicyError::Unsupported => "execution policy unsupported",
                    PolicyError::NotReady => "execution policy not ready",
                    PolicyError::UnsupportedContext(label) => label,
                }))?;
            if let Err(e) = validate_prepared(&params, &prepared.options) {
                prepared.lease.not_started(); return Err(e);
            }
            if !self.instance.owned_jobs_enabled() {
                prepared.lease.not_started(); return Err(error("owned iSH supervisor is no longer ready"));
            }
            // No await between spawn and guard/pump ownership transfer. Dropping the
            // start future later drops Process, which requests confirmed cleanup.
            let spawned = match prepared.grant.as_ref() {
                Some(grant) => self.instance.spawn_with_grant(prepared.options, grant),
                None => self.instance.spawn(prepared.options),
            };
            let session = match spawned {
                Ok(session) => session,
                Err(_) => { prepared.lease.not_started(); return Err(error("iSH spawn was not queued")); }
            };
            let (wake, _) = watch::channel(0u64);
            let (startup, mut ready) = watch::channel(Startup::Pending);
            let runtime = Arc::new(Runtime {
                id: params.process_id.clone(), session, lease: Mutex::new(Some(prepared.lease)),
                state: Mutex::new(State::default()), events, wake, startup,
                cancel: AtomicBool::new(false), cancel_notify: Notify::new(),
                cleanup_timeout: self.cleanup_timeout, active: self.active.clone(),
                pipe_stdin: params.pipe_stdin,
                stdin_budget: self.stdin_budget,
                output_budget: self.output_budget,
                output_chunks: self.output_chunks,
                consumed_output: self.consumed_output,
            });
            let process = Arc::new(Process { runtime: runtime.clone() });
            reservation.armed = false;
            // Subscribe before taking the authoritative initial status/read snapshot.
            let receiver = runtime.session.subscribe();
            tokio::spawn(runtime.clone().pump(receiver));
            let started = tokio::time::timeout(START_TIMEOUT, async {
                loop {
                    match *ready.borrow_and_update() {
                        Startup::Opened => return Ok(()),
                        Startup::Failed => return Err(error("iSH command failed during startup")),
                        Startup::Pending => {},
                    }
                    ready.changed().await.map_err(|_| error("iSH startup observer closed"))?;
                }
            }).await.map_err(|_| error("iSH startup deadline exceeded"))?;
            started?;
            Ok(StartedExecProcess { process, sandbox_type: None })
        })
    }
}

#[derive(Clone, Copy)]
enum Startup { Pending, Opened, Failed }
#[derive(Default)]
struct State {
    chunks: VecDeque<ProcessOutputChunk>,
    bytes: usize,
    stdin_bytes: usize,
    next_seq: u64,
    exited: bool,
    exit_code: Option<i32>,
    closed: bool,
    failure: Option<String>,
    cleanup_failed: bool,
    acknowledged_output: u64,
    delivered_output: u64,
}
impl State {
    fn sequence(&mut self) -> u64 { self.next_seq += 1; self.next_seq }
    fn read(&mut self, after: u64, cap: usize, consumed_output: bool) -> Result<ReadResponse, ExecServerError> {
        if consumed_output {
            if after < self.acknowledged_output || after > self.delivered_output {
                return Err(error("invalid acknowledged output cursor"));
            }
            while self.chunks.front().is_some_and(|chunk| chunk.seq <= after) {
                let chunk = self.chunks.pop_front().expect("front was present");
                self.bytes -= chunk.chunk.0.len();
            }
            self.acknowledged_output = after;
        }
        let mut chunks = Vec::new();
        let mut bytes = 0;
        let mut last = after;
        let mut more = false;
        for chunk in self.chunks.iter().filter(|c| c.seq > after) {
            if !chunks.is_empty() && bytes + chunk.chunk.0.len() > cap { more = true; break; }
            bytes += chunk.chunk.0.len(); last = chunk.seq; chunks.push(chunk.clone());
        }
        let next_seq = if more { last + 1 } else { self.next_seq + 1 };
        self.delivered_output = self.delivered_output.max(next_seq - 1);
        Ok(ReadResponse {
            chunks, next_seq,
            exited: self.exited, exit_code: self.exit_code, closed: self.closed,
            failure: self.failure.clone(), sandbox_denied: false,
        })
    }
}

struct Runtime {
    id: ProcessId,
    session: Arc<IshSession>,
    lease: Mutex<Option<Box<dyn ExecutionLease>>>,
    state: Mutex<State>,
    events: ExecProcessEventLog,
    wake: watch::Sender<u64>,
    startup: watch::Sender<Startup>,
    cancel: AtomicBool,
    cancel_notify: Notify,
    cleanup_timeout: Duration,
    active: Arc<Mutex<HashSet<String>>>,
    pipe_stdin: bool,
    stdin_budget: usize,
    output_budget: usize,
    output_chunks: usize,
    consumed_output: bool,
}
impl Runtime {
    fn wake(&self) { self.wake.send_modify(|n| *n = n.wrapping_add(1)); }
    fn request_cancel(&self) { self.cancel.store(true, Ordering::Release); self.cancel_notify.notify_one(); }
    fn fail(&self, message: &'static str) {
        let mut state = lock(&self.state);
        if state.failure.is_none() {
            state.failure = Some(message.into());
            let _ = self.events.try_publish(ExecProcessEvent::Failed(message.into()));
        }
        self.startup.send_if_modified(|s| {
            if matches!(*s, Startup::Pending) { *s = Startup::Failed; true } else { false }
        });
        self.wake();
    }
    fn output(&self, stream: Stream, bytes: &[u8]) -> Result<(), ()> {
        let mut state = lock(&self.state);
        let count = bytes.len().div_ceil(CHUNK_BYTES);
        if state.bytes.saturating_add(bytes.len()) > self.output_budget || state.chunks.len() + count > self.output_chunks {
            return Err(());
        }
        let stream = match stream { Stream::Stdout => ExecOutputStream::Stdout,
            Stream::Stderr => ExecOutputStream::Stderr, Stream::Pty => ExecOutputStream::Pty };
        for bytes in bytes.chunks(CHUNK_BYTES) {
            let chunk = ProcessOutputChunk { seq: state.sequence(), stream: stream.clone(), chunk: bytes.to_vec().into() };
            state.bytes += bytes.len(); state.chunks.push_back(chunk.clone());
            self.events.try_publish(ExecProcessEvent::Output(chunk)).map_err(|_| ())?;
        }
        self.wake(); Ok(())
    }
    fn exited(&self, code: i32, signal: Option<i32>) {
        let mut state = lock(&self.state);
        if state.exited { return; }
        // iSH reports -1 plus the guest signal; expose the conventional shell code.
        let code = signal.filter(|s| *s > 0).map_or(code, |s| 128 + s);
        state.exited = true; state.exit_code = Some(code);
        let seq = state.sequence();
        let _ = self.events.try_publish(ExecProcessEvent::Exited { seq, exit_code: code, sandbox_denied: None });
        self.wake();
    }
    fn finish_owned(&self) {
        let lease = lock(&self.lease).take();
        if let Some(mut lease) = lease {
            if lease.complete().is_err() {
                lease.quarantine(); lock(&self.state).cleanup_failed = true;
                self.fail("owned lease finalization failed"); return;
            }
        }
        lock(&self.active).remove(self.id.as_str());
        let mut state = lock(&self.state);
        if !state.closed {
            state.closed = true;
            let seq = state.sequence();
            let _ = self.events.try_publish(ExecProcessEvent::Closed { seq });
        }
        self.wake();
    }
    fn quarantine_unconfirmed(&self) {
        if let Some(lease) = lock(&self.lease).take() { lease.quarantine(); }
        lock(&self.state).cleanup_failed = true;
        // Keep the process ID reserved when cleanup cannot be established.
        self.wake();
    }
    async fn cleanup_failure(&self, message: &'static str) {
        self.fail(message);
        let acknowledged = self.session.terminate_owned(self.cleanup_timeout).await.is_ok();
        let status = self.session.status();
        // Failure and Closed can coexist (failed exec). Mode-3 Closed still proves
        // ownership cleanup, but the execution failure remains visible to Core.
        if acknowledged || status.closed {
            if let Some(code) = status.exit_code { self.exited(code, status.term_signal); }
            self.finish_owned();
        } else {
            self.quarantine_unconfirmed();
        }
    }
    async fn pump(self: Arc<Self>, mut receiver: tokio::sync::broadcast::Receiver<ish_embed_host::SessionEvent>) {
        let mut ish_after = 0u64;
        let mut cancellation_sent = false;
        loop {
            if self.cancel.load(Ordering::Acquire) && !cancellation_sent {
                cancellation_sent = true;
                if self.session.terminate_owned(self.cleanup_timeout).await.is_err() && !self.session.status().closed {
                    self.fail("owned cancellation was not acknowledged");
                    self.quarantine_unconfirmed(); return;
                }
            }
            let page = match self.session.read(Some(ish_after), Some(64 * 1024), Some(0)).await {
                Ok(page) => page,
                Err(_) => { self.cleanup_failure("iSH output transport failed").await; return; }
            };
            if page.missed_older_bytes {
                self.cleanup_failure("iSH retained output was lost before collection").await; return;
            }
            let had_output = !page.chunks.is_empty();
            for chunk in page.chunks {
                if chunk.seq <= ish_after { continue; }
                if self.output(chunk.stream, &chunk.bytes).is_err() {
                    self.cleanup_failure("iSH output budget exceeded").await; return;
                }
                ish_after = chunk.seq;
            }
            let status = self.session.status();
            if status.failure.is_some() {
                self.cleanup_failure("iSH session reported failure").await; return;
            }
            if status.opened { self.startup.send_replace(Startup::Opened); }
            if let Some(code) = status.exit_code { self.exited(code, status.term_signal); }
            // iSH next_seq is the global output cursor, even for a partial page.
            // Advance only by chunks actually read, never directly to that cursor.
            if page.closed && ish_after >= page.next_seq.saturating_sub(1) {
                if !status.opened || status.exit_code.is_none() {
                    self.cleanup_failure("iSH closed without a valid startup and exit status").await; return;
                }
                self.finish_owned(); return;
            }
            if had_output { tokio::task::yield_now().await; continue; }
            tokio::select! {
                _ = self.cancel_notify.notified() => {},
                event = receiver.recv() => match event {
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {},
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        if !self.session.status().closed {
                            self.cleanup_failure("iSH event channel closed unexpectedly").await; return;
                        }
                    }
                },
                _ = tokio::time::sleep(POLL_INTERVAL) => {},
            }
        }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        // Runtime shutdown/pump cancellation cannot release an unconfirmed lease.
        if let Some(lease) = self.lease.get_mut().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
            lease.quarantine();
        }
    }
}

struct Process { runtime: Arc<Runtime> }
impl Drop for Process {
    fn drop(&mut self) { if !lock(&self.runtime.state).closed { self.runtime.request_cancel(); } }
}
impl ExecProcess for Process {
    fn process_id(&self) -> &ProcessId { &self.runtime.id }
    fn subscribe_wake(&self) -> watch::Receiver<u64> { self.runtime.wake.subscribe() }
    fn subscribe_events(&self) -> ExecProcessEventReceiver { self.runtime.events.subscribe() }
    fn read(&self, after_seq: Option<u64>, max_bytes: Option<usize>, wait_ms: Option<u64>) -> ExecProcessFuture<'_, ReadResponse> {
        Box::pin(async move {
            let after = after_seq.unwrap_or(0);
            if after == u64::MAX { return Err(error("invalid output cursor")); }
            let cap = max_bytes.unwrap_or(64 * 1024).clamp(1, 64 * 1024);
            let mut wake = self.runtime.wake.subscribe();
            let collect = || lock(&self.runtime.state).read(after, cap, self.runtime.consumed_output);
            let page = collect()?;
            if !page.chunks.is_empty() || page.closed || page.failure.is_some() || page.next_seq > after + 1 { return Ok(page); }
            if let Some(ms) = wait_ms.filter(|m| *m != 0) {
                let _ = tokio::time::timeout(Duration::from_millis(ms.min(60_000)), wake.changed()).await;
            }
            collect()
        })
    }
    fn write(&self, chunk: Vec<u8>) -> ExecProcessFuture<'_, WriteResponse> {
        Box::pin(async move {
            if !self.runtime.pipe_stdin || lock(&self.runtime.state).exited || self.runtime.cancel.load(Ordering::Acquire) {
                return Ok(WriteResponse { status: WriteStatus::StdinClosed });
            }
            if chunk.len() > 32 * 1024 { return Err(error("stdin chunk exceeds supported budget")); }
            {
                let mut state = lock(&self.runtime.state);
                if state.stdin_bytes.saturating_add(chunk.len()) > self.runtime.stdin_budget {
                    return Err(error("stdin submission budget exceeded"));
                }
                // No delivery acknowledgment exists. Charge before enqueueing so
                // concurrent/cancelled writes cannot grow the host queue unboundedly.
                state.stdin_bytes += chunk.len();
            }
            let status = self.runtime.session.write(&chunk).await.map_err(|_| error("iSH stdin request failed"))?;
            Ok(WriteResponse { status: match status {
                IshWriteStatus::Accepted => WriteStatus::Accepted, IshWriteStatus::Starting => WriteStatus::Starting,
                IshWriteStatus::UnknownSession => WriteStatus::UnknownProcess, IshWriteStatus::StdinClosed => WriteStatus::StdinClosed,
            } })
        })
    }
    fn signal(&self, signal: ProcessSignal) -> ExecProcessFuture<'_, ()> {
        Box::pin(async move {
            if lock(&self.runtime.state).exited { return Err(error("process already exited")); }
            match signal { ProcessSignal::Interrupt => self.runtime.session.signal(2).await
                .map_err(|_| error("iSH interrupt request failed")) }
        })
    }
    fn terminate(&self) -> ExecProcessFuture<'_, ()> {
        Box::pin(async move {
            let mut wake = self.runtime.wake.subscribe();
            self.runtime.request_cancel();
            tokio::time::timeout(self.runtime.cleanup_timeout + Duration::from_secs(1), async {
                loop {
                    { let state = lock(&self.runtime.state);
                      if state.closed { return Ok(()); }
                      if state.cleanup_failed { return Err(error("owned cleanup could not be confirmed")); }
                    }
                    wake.changed().await.map_err(|_| error("cleanup observer closed"))?;
                }
            }).await.map_err(|_| error("owned cleanup deadline exceeded"))?
        })
    }
}
