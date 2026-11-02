#!/usr/bin/env python3
"""Generate the additive patch from the current local Codex stack; never apply it.

Staged Rust files live only in this directory for syntax/format verification.
This is a patch authoring tool, not a runtime or acceptance harness.
"""
from pathlib import Path
import difflib
import hashlib
import json

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SOURCE = ROOT / "shared/third_party/codex"
changes = {}


def replace(text, before, after):
    assert text.count(before) == 1, before[:120]
    return text.replace(before, after, 1)


path = "codex-rs/app-server/src/request_processors/thread_processor.rs"
old = (SOURCE / path).read_text()
new = replace(old, """    pub(crate) async fn drain_background_tasks(&self) {
        self.background_tasks.close();""", """    pub(crate) async fn drain_background_tasks(&self) {
        let _ = self.drain_background_tasks_with_report().await;
    }

    pub(crate) async fn drain_background_tasks_with_report(&self) -> bool {
        self.background_tasks.close();""")
new = replace(new, """            warn!("timed out waiting for background tasks to shut down; proceeding");
        }
    }""", """            warn!("timed out waiting for background tasks to shut down; proceeding");
            return false;
        }
        true
    }""")
new = replace(new, """    pub(crate) async fn shutdown_threads(&self) {
        let report = self""", """    pub(crate) async fn shutdown_threads(&self) {
        let _ = self.shutdown_threads_with_report().await;
    }

    pub(crate) async fn shutdown_threads_with_report(&self) -> bool {
        let report = self""")
new = replace(new, """        for thread_id in report.submit_failed {""", """        let complete = report.submit_failed.is_empty() && report.timed_out.is_empty();
        for thread_id in report.submit_failed {""")
new = replace(new, """            warn!("timed out waiting for thread {thread_id} to shut down");
        }
    }""", """            warn!("timed out waiting for thread {thread_id} to shut down");
        }
        complete
    }""")
changes[path] = (old, new)

# These workers can retain auth/config without an outgoing-message sender; output
# channel closure alone cannot prove they stopped. Preserve synchronous cancel
# for legacy callers and add an awaitable ownership path for runtime shutdown.
for leaf in ("models_refresh_worker.rs", "turn_cost_worker.rs"):
    path = "codex-rs/app-server/src/" + leaf
    old = (SOURCE / path).read_text()
    new = replace(old, "    _task: JoinHandle<()>,", "    _task: tokio::sync::Mutex<Option<JoinHandle<()>>>,")
    new = replace(new, "_task: task,", "_task: tokio::sync::Mutex::new(Some(task)),")
    new = replace(new, """    pub(crate) fn shutdown(&self) {
        self.shutdown.cancel();
    }""", """    pub(crate) fn shutdown(&self) {
        self.shutdown.cancel();
    }

    pub(crate) async fn shutdown_and_wait(&self) -> bool {
        self.shutdown();
        let mut task = self._task.lock().await;
        let Some(handle) = task.as_mut() else { return true; };
        let joined = handle.await.is_ok();
        task.take();
        joined
    }""")
    changes[path] = (old, new)

path = "codex-rs/app-server/src/message_processor.rs"
old = (SOURCE / path).read_text()
new = replace(old, """    pub(crate) async fn drain_background_tasks(&self) {
        self.models_refresh_worker.shutdown();""", """    pub(crate) async fn drain_background_tasks(&self) {
        let _ = self.drain_background_tasks_with_report().await;
    }

    pub(crate) async fn drain_background_tasks_with_report(&self) -> bool {
        self.models_refresh_worker.shutdown();""")
new = replace(new, """        self.thread_processor.drain_background_tasks().await;
    }""", """        let models = self.models_refresh_worker.shutdown_and_wait().await;
        let costs = match &self.turn_cost_worker {
            Some(worker) => worker.shutdown_and_wait().await,
            None => true,
        };
        let threads = self.thread_processor.drain_background_tasks_with_report().await;
        models && costs && threads
    }""")
new = replace(new, """    pub(crate) async fn shutdown_threads(&self) {
        self.thread_processor.shutdown_threads().await;
    }""", """    pub(crate) async fn shutdown_threads(&self) {
        let _ = self.shutdown_threads_with_report().await;
    }

    pub(crate) async fn shutdown_threads_with_report(&self) -> bool {
        self.thread_processor.shutdown_threads_with_report().await
    }""")
new = replace(new, """    pub(crate) async fn connection_closed(
        &self,
        connection_id: ConnectionId,
        session_state: &ConnectionSessionState,
    ) {
        session_state.rpc_gate.close().await;""", """    pub(crate) async fn connection_closed(
        &self,
        connection_id: ConnectionId,
        session_state: &ConnectionSessionState,
    ) {
        let _ = self.connection_closed_with_report(connection_id, session_state).await;
    }

    pub(crate) async fn connection_closed_with_report(
        &self,
        connection_id: ConnectionId,
        session_state: &ConnectionSessionState,
    ) -> bool {
        session_state.rpc_gate.close().await;""")
new = replace(new, """        if timeout(
            CONNECTION_RPC_DRAIN_TIMEOUT,
            session_state.rpc_gate.shutdown(),
        )
        .await
        .is_err()
        {""", """        let requests_drained = timeout(
            CONNECTION_RPC_DRAIN_TIMEOUT,
            session_state.rpc_gate.shutdown(),
        ).await.is_ok();
        if !requests_drained {""")
new = replace(new, """        self.thread_processor.connection_closed(connection_id).await;
    }""", """        self.thread_processor.connection_closed(connection_id).await;
        requests_drained
    }""")
changes[path] = (old, new)

path = "codex-rs/app-server/src/in_process.rs"
old = (SOURCE / path).read_text()
new = replace(old, """    runtime_handle: tokio::task::JoinHandle<()>,""", """    runtime_handle: tokio::task::JoinHandle<InProcessShutdownReceipt>,""")
marker = "/// Handle used by an in-process client to call app-server and consume events."
new = replace(new, marker, """/// Observations from in-process shutdown, not a process-exit or sandbox receipt.
/// This covers connection RPCs, tracked startup tasks, Core thread shutdown,
/// and transport queues. The embedder must separately drain its execution scope.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InProcessShutdownReceipt {
    pub connection_requests_drained: bool,
    pub background_tasks_drained: bool,
    pub threads_shutdown: bool,
    pub processor_joined: bool,
    pub outbound_joined: bool,
    pub events_drained: bool,
    pub messages_lost: bool,
}

impl InProcessShutdownReceipt {
    pub fn is_complete(&self) -> bool {
        self.connection_requests_drained && self.background_tasks_drained
            && self.threads_shutdown && self.processor_joined
            && self.outbound_joined && self.events_drained && !self.messages_lost
    }
}

""" + marker)
marker = """    pub fn sender(&self) -> InProcessClientSender {"""
new = replace(new, marker, """    /// Close while delivering the actual tail, then join the runtime. A failed
    /// callback marks delivery incomplete but never skips native cleanup.
    /// Unlike legacy shutdown(), forced termination cannot yield a clean receipt.
    pub async fn shutdown_with_events(
        self,
        mut on_event: impl FnMut(InProcessServerEvent) -> IoResult<()> + Send,
    ) -> IoResult<InProcessShutdownReceipt> {
        let client = self.client;
        let mut event_rx = self.event_rx;
        let mut runtime_handle = self.runtime_handle;
        let (done_tx, _done_rx) = oneshot::channel();
        let mut delivery_failed = false;
        let close = async {
            let send = client.client_tx.send(InProcessClientMessage::Shutdown { done_tx });
            tokio::pin!(send);
            loop {
                tokio::select! {
                    result = &mut send => {
                        result.map_err(|_| IoError::new(ErrorKind::BrokenPipe, "runtime closed before shutdown"))?;
                        break;
                    }
                    event = event_rx.recv() => match event {
                        Some(event) => delivery_failed |= on_event(event).is_err(),
                        None => return Err(IoError::new(ErrorKind::BrokenPipe, "event stream closed before shutdown")),
                    }
                }
            }
            while let Some(event) = event_rx.recv().await {
                delivery_failed |= on_event(event).is_err();
            }
            let mut receipt = (&mut runtime_handle).await
                .map_err(|_| IoError::other("in-process runtime did not join normally"))?;
            receipt.messages_lost |= delivery_failed;
            Ok(receipt)
        };
        match timeout(Duration::from_secs(65), close).await {
            Ok(Ok(receipt)) => Ok(receipt),
            result => {
                // Never detach the top-level runtime or claim a successful close.
                if !runtime_handle.is_finished() {
                    runtime_handle.abort();
                    let _ = runtime_handle.await;
                }
                match result {
                    Ok(Err(error)) => Err(error),
                    _ => Err(IoError::new(ErrorKind::TimedOut, "in-process drain deadline exceeded")),
                }
            }
        }
    }

""" + marker)
# Move warning preparation below both entry points; do not synthesize initialize.
warning = """    if let Ok(Some(err)) = check_execpolicy_for_warnings(&args.config.config_layer_stack).await {
        let (path, range) = crate::exec_policy_warning_location(&err);
        args.config_warnings.push(ConfigWarningNotification {
            summary: "Error parsing rules; custom rules not applied.".to_string(),
            details: Some(err.to_string()),
            path,
            range,
        });
    }
"""
new = replace(new, warning, "")
new = replace(new, """async fn start_with_optional_code_mode_provider(
    mut args: InProcessStartArgs,""", """async fn start_with_optional_code_mode_provider(
    args: InProcessStartArgs,""")
new = replace(new, "start_uninitialized_with_provider(args, code_mode_provider)).await?", "start_uninitialized_with_provider(args, code_mode_provider, false)).await?")
new = replace(new, """#[cfg(test)]
async fn start_uninitialized(args: InProcessStartArgs) -> IoResult<InProcessClientHandle> {
    start_uninitialized_with_provider(args, None).await
}""", """/// Starts without sending initialize/initialized; the caller performs the real
/// handshake through typed request/notify. All server notifications use bounded
/// backpressure. InProcessStartArgs.initialize is unused on this entry point.
pub async fn start_uninitialized(args: InProcessStartArgs) -> IoResult<InProcessClientHandle> {
    start_uninitialized_with_provider(args, None, true).await
}

pub async fn start_uninitialized_with_code_mode_provider(
    args: InProcessStartArgs,
    provider: Arc<dyn codex_code_mode::CodeModeSessionProvider>,
) -> IoResult<InProcessClientHandle> {
    start_uninitialized_with_provider(args, Some(provider), true).await
}""")
new = replace(new, """async fn start_uninitialized_with_provider(
    mut args: InProcessStartArgs,
    code_mode_provider: Option<Arc<dyn codex_code_mode::CodeModeSessionProvider>>,
) -> IoResult<InProcessClientHandle> {
""", """async fn start_uninitialized_with_provider(
    mut args: InProcessStartArgs,
    code_mode_provider: Option<Arc<dyn codex_code_mode::CodeModeSessionProvider>>,
    lossless_events: bool,
) -> IoResult<InProcessClientHandle> {
""" + warning)
new = replace(new, """            _ = &mut shutdown_rx => break,""", """            _ = &mut shutdown_rx => {
                outgoing_rx.close();
                while let Some(envelope) = outgoing_rx.recv().await {
                    route_outgoing_envelope(&mut outbound_connections, envelope).await;
                }
                break;
            },""")
new = replace(new, """            processor
                .connection_closed(IN_PROCESS_CONNECTION_ID, &session)
                .await;
            processor.clear_all_thread_listeners().await;
            processor.drain_background_tasks().await;
            processor.shutdown_threads().await;""", """            let requests_drained = processor
                .connection_closed_with_report(IN_PROCESS_CONNECTION_ID, &session).await;
            processor.clear_all_thread_listeners().await;
            let background_drained = processor.drain_background_tasks_with_report().await;
            let threads_shutdown = processor.shutdown_threads_with_report().await;
            (requests_drained, background_drained, threads_shutdown)""")
new = replace(new, """        let mut shutdown_ack = None;""", """        let mut shutdown_ack = None;
        let mut messages_lost = false;""")
new = replace(new, 'if server_notification_requires_delivery(&notification) {', 'if lossless_events || server_notification_requires_delivery(&notification) {')
for message in ["dropping in-process client notification (queue full)", "dropping in-process server notification (queue full)"]:
    new = replace(new, f'warn!("{message}");', f'messages_lost = true;\n                                    warn!("{message}");')
new = replace(new, """                                let (error, inner) = match send_error {""", """                                messages_lost = true;
                                let (error, inner) = match send_error {""")
begin = new.index("        drop(pending_event);\n")
end = new.index("\n    });\n\n    Ok(InProcessClientHandle", begin)
new = new[:begin] + """        // Keep consuming the actual output while processor shutdown runs.
        // Dropping writer_rx here would lose the native tail and unblock writers
        // without proving delivery. A receipt records every incomplete stage.
        client_rx.close();
        drop(processor_tx);
        outgoing_message_sender.cancel_all_requests(Some(internal_error(
            "in-process app-server runtime is shutting down",
        ))).await;
        for (_, response_tx) in pending_request_responses {
            let _ = response_tx.send(Err(internal_error("in-process runtime is shutting down")));
        }
        drop(outgoing_message_sender);
        let mut receipt = InProcessShutdownReceipt { messages_lost, ..Default::default() };
        let mut processor_finished = false;
        let mut outbound_finished = false;
        let mut outbound_shutdown_tx = Some(outbound_shutdown_tx);
        let mut writer_open = true;
        let mut replies_open = true;
        let drain = async {
            if let Some((event, written)) = pending_event.take() {
                if event_tx.send(event).await.is_err() { receipt.messages_lost = true; }
                else if let Some(written) = written { let _ = written.send(()); }
            }
            while !processor_finished || !outbound_finished || writer_open || replies_open {
                tokio::select! {
                    result = &mut processor_handle, if !processor_finished => {
                        processor_finished = true;
                        if let Ok((requests, background, threads)) = result {
                            receipt.processor_joined = true;
                            receipt.connection_requests_drained = requests;
                            receipt.background_tasks_drained = background;
                            receipt.threads_shutdown = threads;
                        }
                        if let Some(stop) = outbound_shutdown_tx.take() { let _ = stop.send(()); }
                    }
                    result = &mut outbound_handle, if processor_finished && !outbound_finished => {
                        outbound_finished = true;
                        receipt.outbound_joined = result.is_ok();
                    }
                    message = writer_rx.recv(), if writer_open => match message {
                        Some(message) => receipt.messages_lost |= !deliver_shutdown_message(message, &event_tx).await,
                        None => writer_open = false,
                    },
                    message = process_reply_rx.recv(), if replies_open => match message {
                        Some(OutgoingEnvelope::ToConnection { message, write_complete_tx, .. }) => {
                            receipt.messages_lost |= !deliver_shutdown_message(
                                QueuedOutgoingMessage { message, write_complete_tx }, &event_tx,
                            ).await;
                        }
                        Some(OutgoingEnvelope::Broadcast { .. }) => receipt.messages_lost = true,
                        None => replies_open = false,
                    },
                }
            }
            receipt.events_drained = true;
        };
        if timeout(SHUTDOWN_ACK_TIMEOUT, drain).await.is_err() {
            if !processor_finished { processor_handle.abort(); let _ = processor_handle.await; }
            if !outbound_finished { outbound_handle.abort(); let _ = outbound_handle.await; }
        }
        // Diagnostics must not turn a completed execution drain into an unbounded wait.
        let _ = timeout(Duration::from_secs(25), analytics_events_flush_client.flush()).await;
        if let Some(done_tx) = shutdown_ack { let _ = done_tx.send(()); }
        receipt""" + new[end:]
# Both normal and shutdown paths acknowledge only delivered messages.
marker = "#[cfg(test)]\nmod tests {"
new = replace(new, marker, """async fn deliver_shutdown_message(
    queued: QueuedOutgoingMessage,
    events: &mpsc::Sender<InProcessServerEvent>,
) -> bool {
    let delivered = match queued.message {
        OutgoingMessage::AppServerNotification(envelope) => events.send(
            InProcessServerEvent::ServerNotification(Box::new(envelope.notification)),
        ).await.is_ok(),
        OutgoingMessage::Request(request) => {
            // The request cannot be answered once admission closes. Preserve the
            // observation, but never attest complete delivery/response semantics.
            let _ = events.send(InProcessServerEvent::ServerRequest(Box::new(request))).await;
            false
        }
        // Pending RPC callers were explicitly rejected before the drain.
        OutgoingMessage::Response(_) | OutgoingMessage::Error(_) => true,
    };
    if delivered {
        if let Some(written) = queued.write_complete_tx { let _ = written.send(()); }
    }
    delivered
}

""" + marker)
# Existing synthetic legacy-shutdown test now joins the receipt-bearing task.
new = replace(new, """            runtime_completed.store(true, Ordering::Release);
            let _ = done_tx.send(());
        });""", """            runtime_completed.store(true, Ordering::Release);
            let _ = done_tx.send(());
            InProcessShutdownReceipt::default()
        });""")
new = replace(new, """    async fn start_test_client_with_options(
        session_source: SessionSource,
        channel_capacity: usize,
        capabilities: Option<codex_app_server_protocol::InitializeCapabilities>,
    ) -> InProcessClientHandle {
        let codex_home = TempDir::new().expect("temp dir");""", """    async fn start_test_client_with_options(
        session_source: SessionSource,
        channel_capacity: usize,
        capabilities: Option<codex_app_server_protocol::InitializeCapabilities>,
    ) -> InProcessClientHandle {
        start_test_client_with_handshake(session_source, channel_capacity, capabilities, true).await
    }

    async fn start_test_client_with_handshake(
        session_source: SessionSource,
        channel_capacity: usize,
        capabilities: Option<codex_app_server_protocol::InitializeCapabilities>,
        initialize: bool,
    ) -> InProcessClientHandle {
        let codex_home = TempDir::new().expect("temp dir");""")
new = replace(new, """        let mut client = start(args).await.expect("in-process runtime should start");""", """        let mut client = if initialize { start(args).await } else { start_uninitialized(args).await }
            .expect("in-process runtime should start");""")
marker = """    #[tokio::test]
    async fn in_process_start_initializes_and_handles_typed_v2_request() {"""
new = replace(new, marker, """    /// Two fresh native runtimes in one process, without inference or an external
    /// controller. The real initialize receipt and observed drain are mandatory.
    #[tokio::test]
    async fn raw_handshake_and_drain_support_two_sequential_runtimes() {
        let mut previous_home = None;
        for _ in 0..2 {
            let client = start_test_client_with_handshake(
                SessionSource::Cli, DEFAULT_IN_PROCESS_CHANNEL_CAPACITY, None, false,
            ).await;
            let home = client._test_codex_home.as_ref().unwrap().path().to_owned();
            assert_ne!(previous_home.as_ref(), Some(&home));
            let response = client.request(ClientRequest::Initialize {
                request_id: RequestId::Integer(1),
                params: InitializeParams {
                    client_info: ClientInfo {
                        name: "codex-in-process-test".into(), title: None, version: "0.0.0".into(),
                    },
                    capabilities: None,
                },
            }).await.unwrap().unwrap();
            let _: codex_app_server_protocol::InitializeResponse = serde_json::from_value(response).unwrap();
            client.notify(ClientNotification::Initialized).unwrap();
            let response = client.request(ClientRequest::ConfigRequirementsRead {
                request_id: RequestId::Integer(2), params: None,
            }).await.unwrap().unwrap();
            let _: ConfigRequirementsReadResponse = serde_json::from_value(response).unwrap();
            let receipt = client.shutdown_with_events(|event| {
                assert!(!matches!(event, InProcessServerEvent::Lagged { .. }));
                Ok(())
            }).await.unwrap();
            assert!(receipt.is_complete(), "incomplete drain: {receipt:?}");
            previous_home = Some(home);
        }
    }

""" + marker)
changes[path] = (old, new)

patch = []
hashes = {}
for path, (before, after) in changes.items():
    staged = HERE / ".staging" / path
    staged.parent.mkdir(parents=True, exist_ok=True)
    staged.write_text(after)
    hashes[path] = hashlib.sha256(before.encode()).hexdigest()
    patch.extend(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                    fromfile="a/" + path, tofile="b/" + path))
(HERE / "provider-backend.patch").write_text("".join(patch))
(HERE / "base-sha256.json").write_text(json.dumps(hashes, indent=2) + "\n")
print(f"Generated unapplied patch for {len(changes)} upstream files.")
