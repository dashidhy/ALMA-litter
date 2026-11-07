//! Both production adapters run unchanged. The iSH session and mount/scope
//! boundary remain explicit doubles, so these tests make no kernel claim.
use crate::ish_exec_backend::{
    ExecutionLease, ExecutionPolicy, IshExecBackend, PolicyError, PreparedExecution,
};
use crate::kimi_backend::KimiBackend;
use crate::provider_scope::GuestScope;
use codex_exec_server::{ExecBackend, ExecParams, ExecProcess, GuestPath, WriteStatus};
use ish_embed_host::{IshInstance, Scenario, SpawnOpts, Stream};
use serde_json::{Value, json};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

const KIMI_BUDGET: usize = 16 * 1024 * 1024;
const FRAME_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Default)]
struct Counts {
    complete: AtomicUsize,
    quarantined: AtomicUsize,
}
struct Lease(Arc<Counts>);
impl ExecutionLease for Lease {
    fn not_started(self: Box<Self>) {}
    fn complete(&mut self) -> Result<(), PolicyError> {
        self.0.complete.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn quarantine(self: Box<Self>) {
        self.0.quarantined.fetch_add(1, Ordering::SeqCst);
    }
}
struct Policy(Arc<Counts>);
impl ExecutionPolicy for Policy {
    fn prepare<'a>(
        &'a self,
        request: &'a ExecParams,
    ) -> Pin<Box<dyn Future<Output = Result<PreparedExecution, PolicyError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(PreparedExecution {
                options: SpawnOpts {
                    argv: request.argv.clone(),
                    envp: Some(request.env.clone().into_iter().collect()),
                    cwd: Some(request.cwd.0.clone()),
                    tty: false,
                    size: None,
                    pipe_stdin: true,
                    arg0: None,
                },
                grant: None,
                lease: Box::new(Lease(self.0.clone())),
            })
        })
    }
}
fn params() -> ExecParams {
    ExecParams {
        process_id: "kimi-owned-regression".into(),
        argv: vec!["/usr/bin/node".into()],
        cwd: GuestPath("/fixture".into()),
        env: Default::default(),
        env_policy: None,
        sandbox: None,
        enforce_managed_network: false,
        managed_network: None,
        network_proxy: None,
        shell_snapshot: None,
        tty: false,
        pipe_stdin: true,
        arg0: None,
    }
}
struct Rig {
    backend: IshExecBackend,
    instance: Arc<IshInstance>,
    counts: Arc<Counts>,
}
impl Rig {
    fn new(kimi: bool) -> Self {
        let instance = IshInstance::fixture(Scenario::Held);
        let counts = Arc::new(Counts::default());
        let mut backend = IshExecBackend::new(
            instance.clone(),
            Arc::new(Policy(counts.clone())),
            Duration::from_secs(1),
        )
        .unwrap();
        if kimi {
            backend = backend
                .with_stdin_budget(2 * KIMI_BUDGET)
                .unwrap()
                .with_output_budget(KIMI_BUDGET)
                .unwrap();
        }
        Self {
            backend,
            instance,
            counts,
        }
    }
    async fn process(&self) -> Arc<dyn ExecProcess> {
        self.backend.start(params()).await.unwrap().process
    }
    fn frame(&self, frame: Value) -> usize {
        let bytes = format!("__ALMA_KIMI__{frame}\n").into_bytes();
        let length = bytes.len();
        for chunk in bytes.chunks(8192) {
            self.instance.last().inject(Stream::Stdout, chunk.to_vec());
        }
        length
    }
}
fn attempt() -> Value {
    json!({"providerID":"kimi", "attemptID":"owned-attempt", "inference":{"modelID":"kimi-for-coding","reasoningEffortID":"high"},
        "requiredAbilities":["prompt.inline_text"]})
}
async fn terminal(backend: &KimiBackend) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = backend.next_event().await.unwrap();
            if frame["done"] == true {
                return frame["terminal"].clone();
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn kimi_consumer_acknowledges_long_owned_output_before_terminal() {
    let mut rig = Rig::new(true);
    rig.backend = rig.backend.with_consumed_output();
    let process = rig.process().await;
    let scope = GuestScope::new(process);
    let backend = KimiBackend::start(scope.clone(), attempt(), Arc::from("fixture-key"))
        .await.unwrap();
    for sequence in 1..=128 {
        // SDK log traffic and protocol frames share the owned stdout channel.
        let mut log = vec![b'x'; 256 * 1024];
        log.push(b'\n');
        for chunk in log.chunks(8192) {
            rig.instance.last().inject(Stream::Stdout, chunk.to_vec());
        }
        rig.frame(json!({"kind":"event", "event":{"kind":"activity",
            "attemptID":"owned-attempt", "sequence":sequence}}));
        let received = tokio::time::timeout(Duration::from_secs(5), backend.next_event())
            .await.unwrap().unwrap();
        assert_eq!(received["event"]["sequence"], sequence);
    }
    rig.frame(json!({"kind":"terminal", "terminal":{"kind":"end_turn",
        "finalMessageID":"m", "finalText":"done"}}));
    let result = terminal(&backend).await;
    assert_eq!(result["kind"], "end_turn", "{result}");
    assert_eq!(backend.close().await.unwrap()["terminal"]["kind"], "end_turn");
    assert_eq!(*scope.finishes.lock().unwrap(), [true]);
    assert_eq!(rig.backend.active_process_count(), 0);
}

#[tokio::test]
async fn configured_owned_transport_handles_large_start_multimegabyte_output_and_live_terminal() {
    let rig = Rig::new(true);
    let process = rig.process().await;
    let scope = GuestScope::new(process.clone());
    let mut input = attempt();
    // Within the TAH prompt text budget, with envelope bytes taking stdin above 1 MiB.
    input["prompt"] =
        json!([{"authority":"action_instruction", "text":"x".repeat(1024 * 1024 - 10)}]);
    let backend = KimiBackend::start(scope.clone(), input, Arc::from("fixture-real-key"))
        .await
        .unwrap();
    assert!(rig.instance.last().writes.load(Ordering::SeqCst) > 32);
    let final_text = "\n".repeat(900_000);
    let mut sequence = 1;
    let mut output_bytes = rig.frame(
        json!({"kind":"event", "event":{"kind":"message_started", "attemptID":"owned-attempt",
        "sequence":sequence, "messageID":"m", "role":"final_answer"}}),
    );
    for text in final_text.as_bytes().chunks(8192) {
        sequence += 1;
        output_bytes += rig.frame(
            json!({"kind":"event", "event":{"kind":"message_delta", "attemptID":"owned-attempt",
            "sequence":sequence, "messageID":"m", "text":std::str::from_utf8(text).unwrap()}}),
        );
    }
    sequence += 1;
    output_bytes += rig.frame(
        json!({"kind":"event", "event":{"kind":"message_completed", "attemptID":"owned-attempt",
        "sequence":sequence, "messageID":"m"}}),
    );
    // The terminal is a single escaped JSON line above 1 MiB but below 2 MiB.
    let expected_terminal =
        json!({"kind":"end_turn", "finalMessageID":"m", "finalText":final_text});
    let terminal_bytes = rig.frame(json!({"kind":"terminal", "terminal":expected_terminal}));
    assert!(terminal_bytes > 1024 * 1024 && terminal_bytes < FRAME_LIMIT);
    output_bytes += terminal_bytes;
    assert!(output_bytes > 3 * 1024 * 1024 && output_bytes < KIMI_BUDGET);
    assert!(!rig.instance.last().status().closed);
    assert_eq!(rig.instance.last().terms.load(Ordering::SeqCst), 0);
    assert!(scope.finishes.lock().unwrap().is_empty());

    let received = tokio::time::timeout(Duration::from_secs(5), async {
        for expected_sequence in 1..=sequence {
            let event = backend.next_event().await.unwrap();
            assert_eq!(event["done"], false);
            assert_eq!(event["event"]["sequence"], expected_sequence);
        }
        backend.next_event().await.unwrap()
    })
    .await
    .unwrap();
    assert_eq!(received, json!({"done":true,"terminal":expected_terminal}));
    assert!(rig.instance.last().status().closed);
    assert_eq!(rig.instance.last().terms.load(Ordering::SeqCst), 1);
    assert_eq!(rig.backend.active_process_count(), 0);
    assert_eq!(rig.counts.complete.load(Ordering::SeqCst), 1);
    assert_eq!(rig.counts.quarantined.load(Ordering::SeqCst), 0);
    assert_eq!(*scope.finishes.lock().unwrap(), [true]);
    let receipt = backend.close().await.unwrap();
    assert_eq!(receipt["terminal"], expected_terminal);
    assert_eq!(receipt["scopeQuiescent"], true);
    assert_eq!(rig.instance.last().terms.load(Ordering::SeqCst), 1);
    assert!(
        process
            .read(None, None, None)
            .await
            .unwrap()
            .failure
            .is_none()
    );
}

#[tokio::test]
async fn frame_above_two_megabytes_fails_with_proven_owned_cleanup() {
    let rig = Rig::new(true);
    let scope = GuestScope::new(rig.process().await);
    let backend = KimiBackend::start(scope.clone(), attempt(), Arc::from("fixture-real-key"))
        .await
        .unwrap();
    rig.frame(json!({"kind":"terminal", "terminal":{"kind":"end_turn", "finalMessageID":"m", "finalText":"x".repeat(FRAME_LIMIT)}}));
    let result = terminal(&backend).await;
    assert_eq!(result["failure"]["code"], "kimi_frame_limit");
    assert!(rig.instance.last().status().closed);
    assert_eq!(rig.backend.active_process_count(), 0);
    assert_eq!(*scope.finishes.lock().unwrap(), [true]);
    assert!(backend.close().await.is_ok());
}

#[tokio::test]
async fn default_shell_stdin_and_output_budgets_remain_one_megabyte() {
    let rig = Rig::new(false);
    let process = rig.process().await;
    for _ in 0..32 {
        assert_eq!(
            process.write(vec![b'x'; 32768]).await.unwrap().status,
            WriteStatus::Accepted
        );
    }
    assert!(process.write(vec![b'x']).await.is_err());
    for _ in 0..33 {
        rig.instance
            .last()
            .inject(Stream::Stdout, vec![b'x'; 32768]);
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut wake = process.subscribe_wake();
        loop {
            if process
                .read(None, None, None)
                .await
                .unwrap()
                .failure
                .is_some()
            {
                break;
            }
            wake.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    process.terminate().await.unwrap();
    let mut after = 0;
    let mut bytes = 0;
    loop {
        let page = process
            .read(Some(after), Some(64 * 1024), None)
            .await
            .unwrap();
        if page.chunks.is_empty() {
            assert!(page.closed);
            break;
        }
        for chunk in page.chunks {
            after = chunk.seq;
            bytes += chunk.chunk.0.len();
        }
    }
    assert_eq!(bytes, 1024 * 1024);
    assert_eq!(rig.backend.active_process_count(), 0);
}

#[tokio::test]
async fn configured_kimi_stdin_stops_at_thirty_two_and_output_at_sixteen_megabytes() {
    let rig = Rig::new(true);
    let process = rig.process().await;
    for _ in 0..2 * KIMI_BUDGET / 32768 {
        assert_eq!(
            process.write(vec![b'x'; 32768]).await.unwrap().status,
            WriteStatus::Accepted
        );
    }
    assert!(process.write(vec![b'x']).await.is_err());
    let mut wake = process.subscribe_wake();
    for _ in 0..=KIMI_BUDGET / 32768 {
        rig.instance
            .last()
            .inject(Stream::Stdout, vec![b'x'; 32768]);
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if process
                .read(None, None, None)
                .await
                .unwrap()
                .failure
                .is_some()
            {
                break;
            }
            wake.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    process.terminate().await.unwrap();
    let mut after = 0;
    let mut bytes = 0;
    loop {
        let page = process
            .read(Some(after), Some(64 * 1024), None)
            .await
            .unwrap();
        if page.chunks.is_empty() {
            assert!(page.closed);
            break;
        }
        for chunk in page.chunks {
            after = chunk.seq;
            bytes += chunk.chunk.0.len();
        }
    }
    assert_eq!(bytes, KIMI_BUDGET);
    assert_eq!(rig.counts.complete.load(Ordering::SeqCst), 1);
    assert_eq!(rig.backend.active_process_count(), 0);
}
