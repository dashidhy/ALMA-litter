//! Boundary test double only. Does not emulate or claim real process cleanup.
use std::sync::{Arc,Mutex};
use std::sync::atomic::{AtomicBool,AtomicUsize,Ordering};
use std::time::Duration;
use std::path::PathBuf;
use tokio::sync::{broadcast,Notify};
#[derive(Clone,Copy,Debug)] pub enum Stream { Stdout,Stderr,Pty }
pub enum WriteStatus { Accepted,UnknownSession,StdinClosed,Starting }
pub struct SpawnOpts { pub argv:Vec<String>,pub envp:Option<Vec<(String,String)>>,pub cwd:Option<PathBuf>,pub tty:bool,pub size:Option<()>,pub pipe_stdin:bool,pub arg0:Option<String> }
pub struct WorkspaceGrant;
#[derive(Clone,Debug,Default)] pub struct SessionStatus { pub pid:Option<i32>,pub opened:bool,pub exited:bool,pub exit_code:Option<i32>,pub term_signal:Option<i32>,pub closed:bool,pub failure:Option<String> }
#[derive(Clone)] pub enum SessionEvent { Changed }
#[derive(Clone)] pub struct OutputChunk { pub seq:u64,pub stream:Stream,pub bytes:Vec<u8> }
pub struct ReadOutput { pub chunks:Vec<OutputChunk>,pub next_seq:u64,pub closed:bool,pub missed_older_bytes:bool }
#[derive(Clone)] pub enum Scenario { Held,Pending,NoAck,FailureBeforeSubscribe,Completed(Vec<(Stream,Vec<u8>)>) }
pub struct IshInstance { pub ready:AtomicBool,pub starts:AtomicUsize,pub started:Notify,scenario:Scenario,pub sessions:Mutex<Vec<Arc<IshSession>>> }
impl IshInstance {
 pub fn fixture(scenario:Scenario)->Arc<Self> { Arc::new(Self { ready:AtomicBool::new(true),starts:AtomicUsize::new(0),started:Notify::new(),scenario,sessions:Mutex::new(vec![]) }) }
 pub fn owned_jobs_enabled(&self)->bool { self.ready.load(Ordering::SeqCst) }
 // This double covers the original lifecycle only. Sealed grants are tested
 // against the real kernel, never treated as validated by this mock.
 pub fn spawn_with_grant(&self,_:SpawnOpts,_:&WorkspaceGrant)->Result<Arc<IshSession>,()> { Err(()) }
 pub fn spawn(&self,_:SpawnOpts)->Result<Arc<IshSession>,()> {
  let session=Arc::new(IshSession { state:Mutex::new(SessionStatus::default()),output:Mutex::new(vec![]),events:broadcast::channel(2).0,terms:AtomicUsize::new(0),writes:AtomicUsize::new(0),interrupts:AtomicUsize::new(0),no_ack:matches!(self.scenario,Scenario::NoAck),lost:AtomicBool::new(false) });
  if !matches!(self.scenario,Scenario::Pending) { let mut s=session.state.lock().unwrap();s.opened=true;s.pid=Some(7); }
  match &self.scenario {
   Scenario::Completed(chunks)=>{ for (stream,bytes) in chunks {session.inject(*stream,bytes.clone());} session.close(0); },
   Scenario::FailureBeforeSubscribe=>{let mut s=session.state.lock().unwrap();s.opened=false;s.failure=Some("fixture error".into());s.closed=true;s.exited=true;s.exit_code=Some(127);},
   _=>{}
  }
  self.sessions.lock().unwrap().push(session.clone());self.starts.fetch_add(1,Ordering::SeqCst);self.started.notify_one();Ok(session)
 }
 pub fn last(&self)->Arc<IshSession> { self.sessions.lock().unwrap().last().unwrap().clone() }
}
pub struct IshSession { state:Mutex<SessionStatus>,output:Mutex<Vec<OutputChunk>>,events:broadcast::Sender<SessionEvent>,pub terms:AtomicUsize,pub writes:AtomicUsize,pub interrupts:AtomicUsize,no_ack:bool,pub lost:AtomicBool }
impl IshSession {
 pub fn status(&self)->SessionStatus {self.state.lock().unwrap().clone()}
 pub fn subscribe(&self)->broadcast::Receiver<SessionEvent> {self.events.subscribe()}
 pub fn inject(&self,stream:Stream,bytes:Vec<u8>) {let mut v=self.output.lock().unwrap();let seq=v.len() as u64+1;v.push(OutputChunk {seq,stream,bytes});let _=self.events.send(SessionEvent::Changed);}
 pub fn close(&self,code:i32) {let mut s=self.state.lock().unwrap();s.exited=true;s.closed=true;s.exit_code=Some(code);let _=self.events.send(SessionEvent::Changed);}
 pub async fn read(&self,after:Option<u64>,cap:Option<usize>,_:Option<u64>)->Result<ReadOutput,()> {
  let v=self.output.lock().unwrap();let mut chunks=vec![];let mut bytes=0;
  for c in v.iter().filter(|c|c.seq>after.unwrap_or(0)) {if bytes+c.bytes.len()>cap.unwrap_or(usize::MAX)&&!chunks.is_empty(){break;}bytes+=c.bytes.len();chunks.push(c.clone());}
  Ok(ReadOutput {chunks,next_seq:v.len() as u64+1,closed:self.status().closed,missed_older_bytes:self.lost.load(Ordering::SeqCst)})
 }
 pub async fn terminate_owned(&self,_:Duration)->Result<(),()> {
  self.terms.fetch_add(1,Ordering::SeqCst);if self.no_ack{return Err(());}
  tokio::time::sleep(Duration::from_millis(15)).await;
  if !self.status().closed {self.close(137);}
  if self.status().failure.is_some() {Err(())} else {Ok(())}
 }
 pub async fn write(&self,_:&[u8])->Result<WriteStatus,()> {if self.status().closed {return Ok(WriteStatus::StdinClosed);}self.writes.fetch_add(1,Ordering::SeqCst);Ok(WriteStatus::Accepted)}
 pub async fn signal(&self,n:i32)->Result<(),()> {assert_eq!(n,2);self.interrupts.fetch_add(1,Ordering::SeqCst);Ok(())}
}
