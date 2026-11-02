use std::collections::{HashMap,VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc,Mutex as StdMutex};
use tokio::sync::{broadcast,watch};
#[derive(Debug)] pub enum ExecServerError { Protocol(String) }
impl std::fmt::Display for ExecServerError { fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result { write!(f,"{self:?}") } }
impl std::error::Error for ExecServerError {}
#[derive(Clone,Debug)] pub struct ProcessId(String);
impl ProcessId { pub fn as_str(&self)->&str { &self.0 } }
impl From<&str> for ProcessId { fn from(s:&str)->Self { Self(s.into()) } }
#[derive(Clone)] pub struct GuestPath(pub std::path::PathBuf);
impl GuestPath { pub fn to_abs_path(&self)->Result<std::path::PathBuf,()> { Ok(self.0.clone()) } }
#[derive(Clone)] pub struct ExecParams {
 pub process_id:ProcessId, pub argv:Vec<String>, pub cwd:GuestPath, pub env:HashMap<String,String>,
 pub env_policy:Option<()>, pub sandbox:Option<()>, pub enforce_managed_network:bool,
 pub managed_network:Option<()>, pub network_proxy:Option<()>, pub shell_snapshot:Option<()>,
 pub tty:bool, pub pipe_stdin:bool, pub arg0:Option<String>,
}
#[derive(Clone,Debug,PartialEq,Eq)] pub enum ExecOutputStream { Stdout,Stderr,Pty }
#[derive(Clone,Debug,PartialEq,Eq)] pub struct ByteChunk(pub Vec<u8>);
impl From<Vec<u8>> for ByteChunk { fn from(v:Vec<u8>)->Self { Self(v) } }
#[derive(Clone,Debug,PartialEq,Eq)] pub struct ProcessOutputChunk { pub seq:u64,pub stream:ExecOutputStream,pub chunk:ByteChunk }
#[derive(Debug)] pub struct ReadResponse { pub chunks:Vec<ProcessOutputChunk>,pub next_seq:u64,pub exited:bool,pub exit_code:Option<i32>,pub closed:bool,pub failure:Option<String>,pub sandbox_denied:bool }
#[derive(Debug,PartialEq)] pub enum WriteStatus { Accepted,UnknownProcess,StdinClosed,Starting }
#[derive(Debug)] pub struct WriteResponse { pub status:WriteStatus }
pub enum ProcessSignal { Interrupt }
pub trait NetworkPolicyDecider:Send+Sync {}
pub struct StartedExecProcess { pub process:Arc<dyn ExecProcess>,pub sandbox_type:Option<()> }
