use super::adapter::*;
use codex_exec_server::*;
use ish_embed_host::{IshInstance,Scenario,SpawnOpts,Stream};
use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};
use std::time::Duration;

#[derive(Default)] struct Counts { not_started:AtomicUsize,complete:AtomicUsize,quarantine:AtomicUsize }
struct Lease { counts:Arc<Counts>,fail:bool }
impl ExecutionLease for Lease {
 fn not_started(self:Box<Self>) {self.counts.not_started.fetch_add(1,Ordering::SeqCst);}
 fn complete(&mut self)->Result<(),PolicyError> {if self.fail{return Err(PolicyError::NotReady);}self.counts.complete.fetch_add(1,Ordering::SeqCst);Ok(())}
 fn quarantine(self:Box<Self>) {self.counts.quarantine.fetch_add(1,Ordering::SeqCst);}
}
struct Policy { counts:Arc<Counts>,bad_env:bool,fail_complete:bool,wait:bool }
impl ExecutionPolicy for Policy {
 fn prepare<'a>(&'a self,p:&'a ExecParams)->std::pin::Pin<Box<dyn std::future::Future<Output=Result<PreparedExecution,PolicyError>>+Send+'a>> {
  Box::pin(async move {
   if self.wait {std::future::pending::<()>().await;}
   // Test-only gate: no filesystem access, all commands synthetic. This is not
   // a production isolation implementation or a proof of network enforcement.
   if p.argv[0]!="/fixture/bin/synthetic" || p.cwd.0!=std::path::PathBuf::from("/fixture/owned") || p.sandbox.is_some() || p.managed_network.is_some() || p.env_policy.is_some() {return Err(PolicyError::Denied);}
   Ok(PreparedExecution {options:SpawnOpts {argv:p.argv.clone(),envp:if self.bad_env{None}else{Some(p.env.clone().into_iter().collect())},cwd:Some(p.cwd.0.clone()),tty:false,size:None,pipe_stdin:p.pipe_stdin,arg0:p.arg0.clone()},grant:None,lease:Box::new(Lease{counts:self.counts.clone(),fail:self.fail_complete})})
  })
 }
}
fn params(id:&str)->ExecParams {ExecParams {process_id:id.into(),argv:vec!["/fixture/bin/synthetic".into()],cwd:GuestPath("/fixture/owned".into()),env:Default::default(),env_policy:None,sandbox:None,enforce_managed_network:false,managed_network:None,network_proxy:None,shell_snapshot:None,tty:false,pipe_stdin:true,arg0:None}}
fn backend(scenario:Scenario)->(Arc<IshExecBackend>,Arc<IshInstance>,Arc<Counts>) {
 let i=IshInstance::fixture(scenario);let c=Arc::new(Counts::default());let p=Arc::new(Policy{counts:c.clone(),bad_env:false,fail_complete:false,wait:false});
 (Arc::new(IshExecBackend::new(i.clone(),p,Duration::from_millis(100)).unwrap()),i,c)
}
async fn settled(p:&Arc<dyn ExecProcess>)->ReadResponse {
 tokio::time::timeout(Duration::from_secs(2),async {
  loop {let r=p.read(None,None,Some(20)).await.unwrap();if r.closed||r.failure.is_some(){return r;}tokio::task::yield_now().await;}
 }).await.unwrap()
}

#[tokio::test]
async fn pre_subscribe_output_and_lifecycle_are_replayed_once_with_own_sequence() {
 let (b,_,c)=backend(Scenario::Completed(vec![(Stream::Stdout,b"out".to_vec()),(Stream::Stderr,b"err".to_vec())]));
 let p=b.start(params("a")).await.unwrap().process;let r=settled(&p).await;assert!(r.closed);assert_eq!(c.complete.load(Ordering::SeqCst),1);
 let mut events=p.subscribe_events();let mut seqs=vec![];
 for _ in 0..4 {let e=tokio::time::timeout(Duration::from_secs(1),events.recv()).await.unwrap().unwrap();seqs.push(match e {ExecProcessEvent::Output(c)=>c.seq,ExecProcessEvent::Exited{seq,..}|ExecProcessEvent::Closed{seq}=>seq,other=>panic!("{other:?}")});}
 assert_eq!(seqs,[1,2,3,4]);assert_eq!(r.chunks[1].stream,ExecOutputStream::Stderr);
 let first=p.read(None,Some(3),None).await.unwrap();assert_eq!(first.chunks.len(),1);assert_eq!(first.next_seq,2);
 let second=p.read(Some(first.next_seq-1),Some(3),None).await.unwrap();assert_eq!(second.chunks[0].chunk.0,b"err");assert_eq!(second.next_seq,5);
}
#[tokio::test]
async fn partial_ish_pages_do_not_jump_to_global_next_seq() {
 let (b,_,_)=backend(Scenario::Completed((0..8).map(|_|(Stream::Stdout,vec![b'x';32768])).collect()));
 let p=b.start(params("a")).await.unwrap().process;let done=settled(&p).await;assert!(done.closed);assert!(done.failure.is_none());
 let mut after=0;let mut total=0;let mut seqs=std::collections::HashSet::new();
 loop {let r=p.read(Some(after),Some(16384),None).await.unwrap();for chunk in &r.chunks {assert!(seqs.insert(chunk.seq));total+=chunk.chunk.0.len();}after=r.next_seq-1;if r.closed&&r.chunks.is_empty(){break;}}
 assert_eq!(total,8*32768);assert_eq!(seqs.len(),32);
}
#[tokio::test]
async fn authoritative_reads_recover_lagged_wake_events() {
 let (b,i,_)=backend(Scenario::Held);let p=b.start(params("a")).await.unwrap().process;
 for _ in 0..100 {i.last().inject(Stream::Stdout,b"x".to_vec());}i.last().close(0);
 let r=settled(&p).await;assert_eq!(r.chunks.len(),100);assert_eq!(r.next_seq,103);assert!(r.failure.is_none());
}
#[tokio::test]
async fn lost_ish_retention_fails_explicitly_and_cleans_up() {
 let (b,i,c)=backend(Scenario::Held);let p=b.start(params("a")).await.unwrap().process;i.last().lost.store(true,Ordering::SeqCst);
 let r=settled(&p).await;assert!(r.failure.is_some());p.terminate().await.unwrap();assert_eq!(c.complete.load(Ordering::SeqCst),1);
}
#[tokio::test]
async fn output_budget_is_bounded_and_never_silently_truncated() {
 let (b,_,c)=backend(Scenario::Completed((0..40).map(|_|(Stream::Stdout,vec![b'x';32768])).collect()));
 let p=b.start(params("a")).await.unwrap().process;let r=settled(&p).await;assert!(r.failure.is_some());assert!(r.chunks.iter().map(|c|c.chunk.0.len()).sum::<usize>()<=1024*1024);p.terminate().await.unwrap();assert_eq!(c.complete.load(Ordering::SeqCst),1);
}
#[tokio::test]
async fn dropped_start_after_spawn_requests_owned_cleanup() {
 let (b,i,c)=backend(Scenario::Pending);let bb=b.clone();let start=tokio::spawn(async move {bb.start(params("a")).await});i.started.notified().await;start.abort();let _=start.await;
 tokio::time::timeout(Duration::from_secs(1),async {while c.complete.load(Ordering::SeqCst)==0{tokio::time::sleep(Duration::from_millis(5)).await;}}).await.unwrap();assert!(i.last().terms.load(Ordering::SeqCst)>0);
}
#[tokio::test]
async fn dropped_policy_wait_never_spawns() {
 let i=IshInstance::fixture(Scenario::Held);let c=Arc::new(Counts::default());let policy=Arc::new(Policy{counts:c,wait:true,bad_env:false,fail_complete:false});let b=Arc::new(IshExecBackend::new(i.clone(),policy,Duration::from_millis(50)).unwrap());
 let task=tokio::spawn(async move {b.start(params("a")).await});tokio::task::yield_now().await;task.abort();let _=task.await;assert_eq!(i.starts.load(Ordering::SeqCst),0);
}
#[tokio::test]
async fn unacknowledged_termination_quarantines_and_keeps_process_id_reserved() {
 let (b,_,c)=backend(Scenario::NoAck);let p=b.start(params("a")).await.unwrap().process;assert!(p.terminate().await.is_err());let r=p.read(None,None,None).await.unwrap();assert!(!r.closed);assert!(r.failure.is_some());assert_eq!(c.complete.load(Ordering::SeqCst),0);assert_eq!(c.quarantine.load(Ordering::SeqCst),1);assert!(b.start(params("a")).await.is_err());
}
#[tokio::test]
async fn stdin_interrupt_and_confirmed_terminate_have_distinct_semantics() {
 let (b,i,c)=backend(Scenario::Held);let p=b.start(params("a")).await.unwrap().process;
 assert!(b.start(params("a")).await.is_err());assert_eq!(p.write(b"hello".to_vec()).await.unwrap().status,WriteStatus::Accepted);assert!(p.write(vec![0;32769]).await.is_err());
 p.signal(ProcessSignal::Interrupt).await.unwrap();assert_eq!(i.last().interrupts.load(Ordering::SeqCst),1);
 let start=tokio::time::Instant::now();p.terminate().await.unwrap();assert!(start.elapsed()>=Duration::from_millis(10));assert_eq!(c.complete.load(Ordering::SeqCst),1);assert_eq!(p.write(vec![]).await.unwrap().status,WriteStatus::StdinClosed);
}
#[tokio::test]
async fn startup_failure_before_subscription_is_not_a_fake_started_process() {
 let (b,_,_)=backend(Scenario::FailureBeforeSubscribe);assert!(b.start(params("a")).await.is_err());
}
#[tokio::test]
async fn lease_finalization_failure_is_quarantined_not_closed() {
 let i=IshInstance::fixture(Scenario::Completed(vec![]));let c=Arc::new(Counts::default());let policy=Arc::new(Policy{counts:c.clone(),wait:false,bad_env:false,fail_complete:true});let b=IshExecBackend::new(i,policy,Duration::from_millis(50)).unwrap();
 let p=b.start(params("a")).await.unwrap().process;assert!(p.terminate().await.is_err());assert!(!p.read(None,None,None).await.unwrap().closed);assert_eq!(c.quarantine.load(Ordering::SeqCst),1);
}
#[tokio::test]
async fn readiness_capability_policy_and_env_fail_before_spawn() {
 let (b,i,c)=backend(Scenario::Held);
 let mut p=params("a");p.tty=true;assert!(b.start(p).await.is_err());
 let mut p=params("a");p.argv[0]="sh".into();assert!(b.start(p).await.is_err());
 let mut p=params("a");p.arg0=Some("alias".into());assert!(b.start(p).await.is_err());
 let mut p=params("a");p.enforce_managed_network=true;assert!(b.start(p).await.is_err());
 let mut p=params("a");p.sandbox=Some(());assert!(b.start(p).await.is_err());
 let mut p=params("a");p.cwd=GuestPath("/fixture/other".into());assert!(b.start(p).await.is_err());
 i.ready.store(false,Ordering::SeqCst);assert!(b.start(params("a")).await.is_err());assert_eq!(i.starts.load(Ordering::SeqCst),0);
 let policy=Arc::new(Policy{counts:c.clone(),wait:false,bad_env:true,fail_complete:false});assert!(IshExecBackend::new(i.clone(),policy.clone(),Duration::from_millis(50)).is_err());i.ready.store(true,Ordering::SeqCst);
 let b=IshExecBackend::new(i.clone(),policy,Duration::from_millis(50)).unwrap();assert!(b.start(params("a")).await.is_err());assert_eq!(c.not_started.load(Ordering::SeqCst),1);assert_eq!(i.starts.load(Ordering::SeqCst),0);
}

#[test]
fn runtime_shutdown_quarantines_an_unconfirmed_lease() {
 let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
 let (b,_,c)=backend(Scenario::Held);let process=runtime.block_on(b.start(params("a"))).unwrap().process;
 drop(process);drop(runtime);
 assert_eq!(c.complete.load(Ordering::SeqCst),0);assert_eq!(c.quarantine.load(Ordering::SeqCst),1);
}

#[tokio::test]
async fn stdin_submission_budget_bounds_unacknowledged_queueing() {
 let (b,i,_)=backend(Scenario::Held);let p=b.start(params("a")).await.unwrap().process;
 for _ in 0..32 {assert_eq!(p.write(vec![b'x';32768]).await.unwrap().status,WriteStatus::Accepted);}
 assert!(p.write(vec![b'x']).await.is_err());assert_eq!(i.last().writes.load(Ordering::SeqCst),32);p.terminate().await.unwrap();
}

#[tokio::test]
async fn guest_protocol_budget_accepts_large_request_and_response_with_explicit_bounds() {
    let (backend, _, counts) = backend(Scenario::Completed(
        (0..64).map(|_| (Stream::Stdout, vec![b'x'; 32768])).collect()));
    let backend = match Arc::try_unwrap(backend) { Ok(value) => value, Err(_) => panic!("unique fixture backend") }
        .with_output_budget(4 * 1024 * 1024).unwrap();
    let process = backend.start(params("large-output")).await.unwrap().process;
    let mut after = 0;
    let mut bytes = 0;
    loop {
        let page = process.read(Some(after), Some(65536), Some(20)).await.unwrap();
        assert!(page.failure.is_none());
        let empty = page.chunks.is_empty();
        for chunk in page.chunks { after = chunk.seq; bytes += chunk.chunk.0.len(); }
        if page.closed && empty { break; }
        if empty { after = after.max(page.next_seq.saturating_sub(1)); }
        tokio::task::yield_now().await;
    }
    assert_eq!(bytes, 2 * 1024 * 1024);
    assert_eq!(counts.complete.load(Ordering::SeqCst), 1);

    let (backend, instance, _) = self::backend(Scenario::Held);
    let backend = match Arc::try_unwrap(backend) { Ok(value) => value, Err(_) => panic!("unique fixture backend") }
        .with_stdin_budget(2 * 1024 * 1024).unwrap();
    let process = backend.start(params("large-input")).await.unwrap().process;
    for _ in 0..40 { assert!(matches!(process.write(vec![0; 32768]).await.unwrap().status, WriteStatus::Accepted)); }
    assert_eq!(instance.last().writes.load(Ordering::SeqCst), 40);
    process.terminate().await.unwrap();
}
#[tokio::test]
async fn owned_capacity_is_bounded_before_spawning() {
 let (b,i,_)=backend(Scenario::Held);let mut processes=vec![];
 for id in 0..64 {processes.push(b.start(params(&format!("p{id}"))).await.unwrap().process);}
 assert!(b.start(params("overflow")).await.is_err());assert_eq!(i.starts.load(Ordering::SeqCst),64);
 for p in processes {p.terminate().await.unwrap();}
}

async fn next_output_page(process: &Arc<dyn ExecProcess>, after: u64, cap: usize) -> ReadResponse {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let page = process.read(Some(after), Some(cap), Some(20)).await.unwrap();
            assert!(page.failure.is_none(), "unexpected process failure: {:?}", page.failure);
            if !page.chunks.is_empty() {
                return page;
            }
            assert!(!page.closed, "process closed before expected output");
        }
    }).await.expect("output page deadline")
}

#[tokio::test]
async fn continuously_read_default_output_still_exhausts_cumulative_budget() {
    // Compile the production adapter unchanged. Only the iSH transport is a
    // double. Drain every 32 KiB before injecting more, ruling out reader lag.
    const BUDGET: usize = 16 * 1024 * 1024;
    const TRANSFER: usize = 32 * 1024;
    let (backend, instance, counts) = backend(Scenario::Held);
    let backend = Arc::try_unwrap(backend).unwrap_or_else(|_| panic!("unique fixture backend"))
        .with_output_budget(BUDGET).unwrap();
    let process = backend.start(params("cumulative-output")).await.unwrap().process;
    let mut after = 0;
    let mut delivered = 0;
    for _ in 0..BUDGET / TRANSFER {
        instance.last().inject(Stream::Stdout, vec![b'x'; TRANSFER]);
        let page = next_output_page(&process, after, TRANSFER).await;
        assert_eq!(page.chunks.iter().map(|chunk| chunk.chunk.0.len()).sum::<usize>(), TRANSFER);
        for chunk in page.chunks {
            assert_eq!(chunk.seq, after + 1);
            after = chunk.seq;
            delivered += chunk.chunk.0.len();
        }
    }
    assert_eq!(delivered, BUDGET);
    let caught_up = process.read(Some(after), None, None).await.unwrap();
    assert!(caught_up.chunks.is_empty());
    assert!(caught_up.failure.is_none());

    instance.last().inject(Stream::Stdout, vec![b'x']);
    let failed = settled(&process).await;
    assert_eq!(failed.failure.as_deref(), Some("iSH output budget exceeded"));
    assert!(!failed.sandbox_denied);
    process.terminate().await.unwrap();

    // Default readers can still replay from zero after consuming everything.
    let mut replay_after = 0;
    let mut replayed = 0;
    loop {
        let page = process.read(Some(replay_after), None, None).await.unwrap();
        if page.chunks.is_empty() {
            assert!(page.closed);
            break;
        }
        for chunk in page.chunks {
            replay_after = chunk.seq;
            replayed += chunk.chunk.0.len();
        }
    }
    assert_eq!(replayed, BUDGET);
    assert_eq!(counts.complete.load(Ordering::SeqCst), 1);
    assert_eq!(counts.quarantine.load(Ordering::SeqCst), 0);
    assert_eq!(backend.active_process_count(), 0);
}

fn consumed_output_backend(budget: usize) -> (IshExecBackend, Arc<IshInstance>, Arc<Counts>) {
    let (backend, instance, counts) = backend(Scenario::Held);
    let backend = Arc::try_unwrap(backend).unwrap_or_else(|_| panic!("unique fixture backend"))
        .with_output_budget(budget).unwrap()
        .with_consumed_output();
    (backend, instance, counts)
}

async fn receive_output_events(events: &mut ExecProcessEventReceiver, count: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        for _ in 0..count {
            assert!(matches!(events.recv().await.unwrap(), ExecProcessEvent::Output(_)));
        }
    }).await.expect("output event deadline");
}

#[tokio::test]
async fn consumed_output_streams_thirty_two_megabytes_with_sixteen_megabyte_retention() {
    const BUDGET: usize = 16 * 1024 * 1024;
    const TRANSFER: usize = 32 * 1024;
    let (backend, instance, counts) = consumed_output_backend(BUDGET);
    let process = backend.start(params("streaming-output")).await.unwrap().process;
    let mut after = 0;
    let mut delivered = 0;
    for _ in 0..2 * BUDGET / TRANSFER {
        instance.last().inject(Stream::Stdout, vec![b'x'; TRANSFER]);
        let page = next_output_page(&process, after, TRANSFER).await;
        assert_eq!(page.chunks.iter().map(|chunk| chunk.chunk.0.len()).sum::<usize>(), TRANSFER);
        for chunk in page.chunks {
            assert_eq!(chunk.seq, after + 1);
            after = chunk.seq;
            delivered += chunk.chunk.0.len();
        }
    }
    assert_eq!(delivered, 2 * BUDGET);
    let acknowledged = process.read(Some(after), None, None).await.unwrap();
    assert!(acknowledged.chunks.is_empty());
    assert!(acknowledged.failure.is_none());
    assert!(process.read(None, None, None).await.is_err());
    process.terminate().await.unwrap();
    let closed = process.read(Some(after), None, None).await.unwrap();
    assert!(closed.closed);
    assert!(closed.failure.is_none());
    assert_eq!(counts.complete.load(Ordering::SeqCst), 1);
    assert_eq!(counts.quarantine.load(Ordering::SeqCst), 0);
    assert_eq!(backend.active_process_count(), 0);
}

#[tokio::test]
async fn consumed_output_recycles_chunk_slots_but_preserves_cumulative_stdin_budget() {
    let (backend, instance, _) = consumed_output_backend(1024 * 1024);
    let process = backend.start(params("streaming-tiny-chunks")).await.unwrap().process;
    for after in 0..5000 {
        instance.last().inject(Stream::Stdout, vec![b'x']);
        let page = next_output_page(&process, after, 8192).await;
        assert_eq!(page.chunks.len(), 1);
        assert_eq!(page.chunks[0].seq, after + 1);
    }
    // Reading and acknowledging output must never refund stdin submissions.
    for _ in 0..32 {
        assert_eq!(process.write(vec![b'x'; 32768]).await.unwrap().status, WriteStatus::Accepted);
        let page = process.read(Some(5000), None, None).await.unwrap();
        assert!(page.chunks.is_empty());
        assert!(page.failure.is_none());
    }
    assert!(process.write(vec![b'x']).await.is_err());
    assert_eq!(instance.last().writes.load(Ordering::SeqCst), 32);
    process.terminate().await.unwrap();
}

#[tokio::test]
async fn consumed_output_bounds_unacknowledged_bytes_and_tiny_chunks() {
    const BUDGET: usize = 1024 * 1024;
    // The first case fills the byte limit. The second fills the chunk limit
    // using only 4096 bytes. Merely reading a page acknowledges neither page.
    for (transfers, transfer_bytes, event_count) in [(32, 32768, 128), (4096, 1, 4096)] {
        let (backend, instance, counts) = consumed_output_backend(BUDGET);
        let process = backend.start(params("slow-reader")).await.unwrap().process;
        let mut events = process.subscribe_events();
        for _ in 0..transfers {
            instance.last().inject(Stream::Stdout, vec![b'x'; transfer_bytes]);
        }
        receive_output_events(&mut events, event_count).await;
        let first = process.read(None, None, None).await.unwrap();
        let replay = process.read(None, None, None).await.unwrap();
        assert_eq!(first.chunks, replay.chunks);
        assert!(first.failure.is_none());
        instance.last().inject(Stream::Stderr, vec![b'x']);
        let failed = settled(&process).await;
        assert_eq!(failed.failure.as_deref(), Some("iSH output budget exceeded"));
        process.terminate().await.unwrap();
        assert_eq!(counts.complete.load(Ordering::SeqCst), 1);
        assert_eq!(backend.active_process_count(), 0);
    }
}

#[tokio::test]
async fn consumed_output_rejects_unread_and_rewind_cursors_without_losing_replay() {
    let (backend, instance, _) = consumed_output_backend(1024 * 1024);
    let process = backend.start(params("ack-cursors")).await.unwrap().process;
    let mut events = process.subscribe_events();
    instance.last().inject(Stream::Stdout, vec![b'x'; 32768]);
    receive_output_events(&mut events, 4).await;

    // The bytes exist, but a pushed subscriber does not authorize a read ACK.
    assert!(process.read(Some(1), None, None).await.is_err());
    assert!(process.read(Some(u64::MAX), None, None).await.is_err());
    let first = process.read(None, Some(8192), None).await.unwrap();
    assert_eq!(first.chunks.len(), 1);
    assert_eq!(first.next_seq, 2);
    assert!(process.read(Some(2), None, None).await.is_err());
    assert!(process.read(Some(4), None, None).await.is_err());
    let replay = process.read(None, Some(8192), None).await.unwrap();
    assert_eq!(replay.chunks, first.chunks);

    let second = process.read(Some(1), Some(8192), None).await.unwrap();
    assert_eq!(second.chunks[0].seq, 2);
    assert!(process.read(None, None, None).await.is_err());
    let retry = process.read(Some(1), Some(8192), None).await.unwrap();
    assert_eq!(retry.chunks, second.chunks);
    let rest = process.read(Some(2), None, None).await.unwrap();
    assert_eq!(rest.chunks.iter().map(|chunk| chunk.seq).collect::<Vec<_>>(), [3, 4]);
    let empty = process.read(Some(4), None, None).await.unwrap();
    assert!(empty.chunks.is_empty());
    assert!(empty.failure.is_none());
    process.terminate().await.unwrap();

    // Exited and Closed consume sequence numbers, even without output bytes.
    let closed = process.read(Some(4), None, None).await.unwrap();
    assert!(closed.closed);
    assert_eq!(closed.next_seq, 7);
    let terminal_ack = process.read(Some(closed.next_seq - 1), None, None).await.unwrap();
    assert!(terminal_ack.closed);
    assert!(terminal_ack.chunks.is_empty());
    assert!(process.read(Some(7), None, None).await.is_err());
}

#[tokio::test]
async fn consumed_output_drains_closed_partial_pages_without_acknowledging_unread_bytes() {
    let (backend, instance, _) = consumed_output_backend(1024 * 1024);
    let process = backend.start(params("closed-pages")).await.unwrap().process;
    instance.last().inject(Stream::Stdout, vec![b'x'; 32768]);
    instance.last().close(0);
    process.terminate().await.unwrap();

    for after in 0..4 {
        let page = process.read(Some(after), Some(8192), None).await.unwrap();
        assert!(page.closed);
        assert_eq!(page.chunks.len(), 1);
        assert_eq!(page.chunks[0].seq, after + 1);
        assert_eq!(page.next_seq, if after == 3 { 7 } else { after + 2 });
    }
    let drained = process.read(Some(6), None, None).await.unwrap();
    assert!(drained.closed);
    assert!(drained.chunks.is_empty());
    assert!(drained.failure.is_none());
}

#[tokio::test]
async fn consumed_output_cancelled_wait_preserves_next_page_and_previous_ack() {
    let (backend, instance, _) = consumed_output_backend(1024 * 1024);
    let process = backend.start(params("cancelled-read")).await.unwrap().process;
    instance.last().inject(Stream::Stdout, b"first".to_vec());
    let first = next_output_page(&process, 0, 8192).await;
    let after = first.chunks[0].seq;

    // Poll and then cancel a waiting read after it acknowledges the prior page.
    assert!(tokio::time::timeout(Duration::from_millis(10),
        process.read(Some(after), None, Some(60_000))).await.is_err());
    assert!(process.read(None, None, None).await.is_err());
    instance.last().inject(Stream::Stderr, b"second".to_vec());
    let second = next_output_page(&process, after, 8192).await;
    assert_eq!(second.chunks[0].seq, after + 1);
    assert_eq!(second.chunks[0].chunk.0, b"second");
    assert_eq!(second.chunks[0].stream, ExecOutputStream::Stderr);
    let replay = process.read(Some(after), None, None).await.unwrap();
    assert_eq!(replay.chunks, second.chunks);
    process.terminate().await.unwrap();
}

#[tokio::test]
async fn process_event_log_evicts_replay_while_continuing_live_delivery() {
    let log = ExecProcessEventLog::bounded(4, 16).unwrap();
    let mut live = log.subscribe();
    for seq in 1..=32 {
        let event = ExecProcessEvent::Output(ProcessOutputChunk {
            seq,
            stream: ExecOutputStream::Stdout,
            chunk: vec![b'x'; 8].into(),
        });
        log.try_publish(event.clone()).unwrap();
        assert_eq!(live.recv().await.unwrap(), event);
    }
    let mut replay = log.subscribe();
    for expected in [31, 32] {
        match replay.recv().await.unwrap() {
            ExecProcessEvent::Output(chunk) => assert_eq!(chunk.seq, expected),
            other => panic!("unexpected replay event {other:?}"),
        }
    }
    let closed = ExecProcessEvent::Closed { seq: 33 };
    log.try_publish(closed.clone()).unwrap();
    assert_eq!(replay.recv().await.unwrap(), closed);
}
