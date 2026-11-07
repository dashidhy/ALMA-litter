use crate::kimi_backend::KimiBackend;
use crate::provider_scope::GuestScope;
use codex_exec_server::*;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Notify, watch};

struct MockProcess {
    id: ProcessId,
    chunks: Mutex<Vec<ProcessOutputChunk>>,
    stdin: Mutex<Vec<Vec<u8>>>,
    wake: watch::Sender<u64>,
    closed: AtomicBool,
    fail_write: AtomicBool,
    fail_terminate: AtomicBool,
    block_write: AtomicBool,
    wrote: Notify,
    terminated: AtomicUsize,
    reads: AtomicUsize,
    page_chunks: usize,
}
impl MockProcess {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            id: "test".into(),
            chunks: Mutex::new(vec![]),
            stdin: Mutex::new(vec![]),
            wake: watch::channel(0).0,
            closed: AtomicBool::new(false),
            fail_write: AtomicBool::new(false),
            fail_terminate: AtomicBool::new(false),
            block_write: AtomicBool::new(false),
            wrote: Notify::new(),
            terminated: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            page_chunks: 1,
        })
    }
    fn bytes(&self, stream: ExecOutputStream, bytes: Vec<u8>) {
        let mut chunks = self.chunks.lock().unwrap();
        let seq = chunks.last().map_or(1, |chunk| chunk.seq + 1);
        chunks.push(ProcessOutputChunk {
            seq,
            stream,
            chunk: bytes.into(),
        });
        self.wake.send_modify(|version| *version += 1);
    }
    fn frame(&self, frame: Value) {
        self.bytes(
            ExecOutputStream::Stdout,
            format!("__ALMA_KIMI__{frame}\n").into_bytes(),
        );
    }
}
impl ExecProcess for MockProcess {
    fn process_id(&self) -> &ProcessId {
        &self.id
    }
    fn subscribe_wake(&self) -> watch::Receiver<u64> {
        self.wake.subscribe()
    }
    fn subscribe_events(&self) -> ExecProcessEventReceiver {
        ExecProcessEventReceiver::empty()
    }
    fn read(
        &self,
        after: Option<u64>,
        _: Option<usize>,
        _: Option<u64>,
    ) -> ExecProcessFuture<'_, ReadResponse> {
        Box::pin(async move {
            self.reads.fetch_add(1, Ordering::SeqCst);
            let all = self.chunks.lock().unwrap();
            let chunks = all
                .iter()
                .filter(|chunk| chunk.seq > after.unwrap_or(0))
                .take(self.page_chunks)
                .cloned()
                .collect();
            Ok(ReadResponse {
                chunks,
                next_seq: all.last().map_or(1, |chunk| chunk.seq + 1),
                exited: self.closed.load(Ordering::SeqCst),
                exit_code: Some(0),
                closed: self.closed.load(Ordering::SeqCst),
                failure: None,
                sandbox_denied: false,
            })
        })
    }
    fn write(&self, chunk: Vec<u8>) -> ExecProcessFuture<'_, WriteResponse> {
        Box::pin(async move {
            assert!(chunk.len() <= 32 * 1024);
            self.stdin.lock().unwrap().push(chunk);
            self.wrote.notify_one();
            if self.block_write.load(Ordering::SeqCst) {
                std::future::pending::<()>().await;
            }
            if self.fail_write.load(Ordering::SeqCst) {
                return Err(ExecServerError::Protocol("private write failure".into()));
            }
            Ok(WriteResponse {
                status: WriteStatus::Accepted,
            })
        })
    }
    fn signal(&self, _: ProcessSignal) -> ExecProcessFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    fn terminate(&self) -> ExecProcessFuture<'_, ()> {
        Box::pin(async move {
            self.terminated.fetch_add(1, Ordering::SeqCst);
            if self.fail_terminate.load(Ordering::SeqCst) {
                return Err(ExecServerError::Protocol("private cleanup failure".into()));
            }
            self.closed.store(true, Ordering::SeqCst);
            self.wake.send_modify(|version| *version += 1);
            Ok(())
        })
    }
}
fn attempt() -> Value {
    json!({"providerID":"kimi", "attemptID":"test-attempt", "inference":{"modelID":"kimi-for-coding", "reasoningEffortID":"high"},
        "requiredAbilities":["prompt.inline_text"]})
}
fn event(seq: u64) -> Value {
    json!({"kind":"event", "event":{"kind":"activity", "attemptID":"test-attempt", "sequence":seq}})
}
async fn start(scope: Arc<GuestScope>) -> Arc<KimiBackend> {
    KimiBackend::start(scope, attempt(), Arc::from("fixture-real-key"))
        .await
        .unwrap()
}
async fn done(backend: &KimiBackend) -> Value {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let result = backend.next_event().await.unwrap();
            if result["done"] == true {
                return result;
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn ordered_split_frames_and_terminal_survive_closed_partial_pages() {
    let process = MockProcess::new();
    process.bytes(
        ExecOutputStream::Stderr,
        b"private stderr must disappear\n".to_vec(),
    );
    process.bytes(
        ExecOutputStream::Stdout,
        b"private stdout log\n__ALMA_".to_vec(),
    );
    process.bytes(
        ExecOutputStream::Stdout,
        format!("KIMI__{}\n", event(1)).into_bytes(),
    );
    process.frame(event(2));
    process.frame(json!({"kind":"terminal", "terminal":{"kind":"end_turn", "finalMessageID":"m", "finalText":"done"}}));
    process.closed.store(true, Ordering::SeqCst);
    let scope = GuestScope::new(process.clone());
    let backend = start(scope.clone()).await;
    assert_eq!(backend.next_event().await.unwrap()["event"]["sequence"], 1);
    assert_eq!(backend.next_event().await.unwrap()["event"]["sequence"], 2);
    let result = done(&backend).await;
    assert_eq!(result["terminal"]["kind"], "end_turn");
    assert_eq!(backend.next_event().await.unwrap(), result);
    assert_eq!(
        backend.close().await.unwrap()["terminal"],
        result["terminal"]
    );
    assert_eq!(*scope.finishes.lock().unwrap(), [true]);
    assert!(process.reads.load(Ordering::SeqCst) >= 6);
}

#[tokio::test]
async fn large_start_is_chunked_and_host_key_stays_out_of_stdin() {
    let process = MockProcess::new();
    let scope = GuestScope::new(process.clone());
    let mut input = attempt();
    input["prompt"] = json!("z".repeat(100_000));
    let backend = KimiBackend::start(scope, input.clone(), Arc::from("fixture-real-key"))
        .await
        .unwrap();
    let bytes = process.stdin.lock().unwrap().concat();
    assert!(!String::from_utf8_lossy(&bytes).contains("fixture-real-key"));
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["attempt"],
        input
    );
    assert!(process.stdin.lock().unwrap().len() > 3);
    backend.cancel().await.unwrap();
    assert_eq!(done(&backend).await["terminal"]["kind"], "cancelled");
}

#[tokio::test]
async fn failed_initial_write_is_drained_before_start_returns() {
    let process = MockProcess::new();
    process.fail_write.store(true, Ordering::SeqCst);
    let scope = GuestScope::new(process.clone());
    let error = KimiBackend::start(scope.clone(), attempt(), Arc::from("fixture-real-key"))
        .await
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "kimi_start_failed");
    assert!(process.closed.load(Ordering::SeqCst));
    assert_eq!(*scope.finishes.lock().unwrap(), [true]);
}

#[tokio::test]
async fn preflight_failure_finishes_an_unstarted_scope() {
    let process = MockProcess::new();
    let scope = GuestScope::new(process);
    let mut input = attempt();
    input["inference"]["modelID"] = json!("arbitrary-model");
    assert!(
        KimiBackend::start(scope.clone(), input, Arc::from("fixture-real-key"))
            .await
            .is_err()
    );
    assert!(!scope.spawned.load(Ordering::SeqCst));
    assert_eq!(*scope.finishes.lock().unwrap(), [true]);
}

#[tokio::test]
async fn cleanup_failure_quarantines_and_refuses_closure_receipt() {
    let process = MockProcess::new();
    process.fail_terminate.store(true, Ordering::SeqCst);
    let scope = GuestScope::new(process);
    let backend = start(scope.clone()).await;
    assert_eq!(
        backend.close().await.err().unwrap().to_string(),
        "kimi_cleanup_incomplete"
    );
    assert_eq!(*scope.finishes.lock().unwrap(), [false]);
    assert_eq!(
        done(&backend).await["terminal"]["failure"]["code"],
        "kimi_cleanup_incomplete"
    );
}

#[tokio::test]
async fn dropped_start_future_retains_cleanup_owner() {
    let process = MockProcess::new();
    process.block_write.store(true, Ordering::SeqCst);
    let scope = GuestScope::new(process.clone());
    let task = tokio::spawn(KimiBackend::start(
        scope.clone(),
        attempt(),
        Arc::from("fixture-real-key"),
    ));
    process.wrote.notified().await;
    task.abort();
    let _ = task.await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while scope.finishes.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(process.closed.load(Ordering::SeqCst));
    assert_eq!(*scope.finishes.lock().unwrap(), [true]);
}

#[tokio::test]
async fn close_is_concurrent_idempotent_and_retains_events() {
    let process = MockProcess::new();
    process.frame(event(1));
    let scope = GuestScope::new(process.clone());
    let backend = start(scope.clone()).await;
    assert_eq!(backend.next_event().await.unwrap()["event"]["sequence"], 1);
    let (left, right) = tokio::join!(backend.close(), backend.close());
    assert_eq!(left.unwrap(), right.unwrap());
    assert_eq!(process.terminated.load(Ordering::SeqCst), 1);
    assert_eq!(*scope.finishes.lock().unwrap(), [true]);
}

#[tokio::test]
async fn bounded_events_fail_with_retained_prefix() {
    let process = MockProcess::new();
    for seq in 1..=257 {
        process.frame(event(seq));
    }
    let scope = GuestScope::new(process);
    let backend = start(scope.clone()).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while scope.finishes.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    for seq in 1..=256 {
        assert_eq!(
            backend.next_event().await.unwrap()["event"]["sequence"],
            seq
        );
    }
    assert_eq!(
        done(&backend).await["terminal"]["failure"]["code"],
        "kimi_event_limit"
    );
}

#[tokio::test]
async fn process_closed_without_guest_terminal_is_failed() {
    let process = MockProcess::new();
    process.closed.store(true, Ordering::SeqCst);
    let backend = start(GuestScope::new(process)).await;
    assert_eq!(
        done(&backend).await["terminal"]["failure"]["code"],
        "kimi_terminal_missing"
    );
}

#[tokio::test]
async fn wake_driven_reader_does_not_poll_idle_process() {
    let process = MockProcess::new();
    let backend = start(GuestScope::new(process.clone())).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    let reads = process.reads.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(process.reads.load(Ordering::SeqCst), reads);
    process.frame(json!({"kind":"terminal", "terminal":{"kind":"cancelled"}}));
    assert_eq!(done(&backend).await["terminal"]["kind"], "cancelled");
}

#[tokio::test]
async fn malformed_and_out_of_order_protocol_is_static_failure() {
    for frame in [event(2), json!({"kind":"bad", "secret":"private data"})] {
        let process = MockProcess::new();
        process.frame(frame);
        let backend = start(GuestScope::new(process)).await;
        let result = done(&backend).await;
        assert_eq!(result["terminal"]["kind"], "failed");
        assert!(!result.to_string().contains("private data"));
    }
}

#[tokio::test]
async fn endpoint_and_inference_denials_never_reach_http() {
    let valid = json!({"kind":"http","id":1,"url":"https://api.kimi.com/coding/v1/chat/completions","method":"POST","headers":{},
        "body":json!({"model":"kimi-for-coding", "thinking":{"type":"enabled", "effort":"high"}}).to_string()});
    let mut cases = Vec::new();
    for url in [
        "https://example.com/coding/v1/messages",
        "https://api.kimi.com/coding/v1/models",
        "https://api.kimi.com/coding/v1/search",
        "https://api.kimi.com/coding/v1/fetch",
        "https://api.kimi.com/coding/v1/messages?x=1",
        "https://api.kimi.com/coding/v1/messages#x",
        "https://api.kimi.com:443/coding/v1/messages",
        "https://api.kimi.com/coding/v1/../v1/messages",
    ] {
        let mut frame = valid.clone();
        frame["url"] = json!(url);
        cases.push(frame);
    }
    for body in [
        json!({"model":"k3", "thinking":{"type":"enabled","effort":"high"}}),
        json!({"model":"kimi-for-coding", "thinking":{"type":"enabled","effort":"low"}}),
        json!({"model":"kimi-for-coding", "thinking":{"type":"disabled"}}),
    ] {
        let mut frame = valid.clone();
        frame["body"] = json!(body.to_string());
        cases.push(frame);
    }
    for frame in cases {
        let process = MockProcess::new();
        process.frame(frame);
        let backend = start(GuestScope::new(process)).await;
        let result = done(&backend).await;
        assert_eq!(result["terminal"]["kind"], "failed");
        assert!(
            ["kimi_target_denied", "kimi_inference_drift"]
                .contains(&result["terminal"]["failure"]["code"].as_str().unwrap())
        );
    }
}
