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
async fn owned_capacity_is_bounded_before_spawning() {
 let (b,i,_)=backend(Scenario::Held);let mut processes=vec![];
 for id in 0..64 {processes.push(b.start(params(&format!("p{id}"))).await.unwrap().process);}
 assert!(b.start(params("overflow")).await.is_err());assert_eq!(i.starts.load(Ordering::SeqCst),64);
 for p in processes {p.terminate().await.unwrap();}
}
