//! Disposable real-iSH adapter consumer. No model, login or production policy.
#[path = "../../codex-mobile-client/src/ish_exec_backend.rs"]
mod backend;
#[path = "../../codex-mobile-client/src/scoped_files.rs"]
mod scoped_files;
#[path = "../../codex-mobile-client/src/scoped_executor_fs.rs"]
mod scoped_executor_fs;

use backend::{ExecutionLease, ExecutionPolicy, IshExecBackend, PolicyError, PreparedExecution};
use codex_exec_server::{ExecBackend, ExecOutputStream, ExecParams, ExecProcess, ProcessId, ProcessSignal};
use codex_utils_path_uri::PathUri;
use ish_embed_host::{IshInstance, SpawnOpts, WorkspaceGrant, WorkspaceNetworkPolicy};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::{c_char, CStr, CString};
use std::path::Path;
use std::sync::{atomic::{AtomicUsize, Ordering}, Arc};
use std::time::{Duration, Instant};

type Callback = extern "C" fn(*const c_char);
fn emit(cb: Callback, value: Value) { let s=CString::new(value.to_string()).unwrap();cb(s.as_ptr()); }
fn quote(s: &str) -> String { format!("'{}'",s.replace('\'',"'\\''")) }
fn env() -> HashMap<String,String> {
    [("PATH","/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
     ("HOME","/workspace/tmp"),("LANG","C.UTF-8"),("LC_ALL","C.UTF-8"),
     ("TMPDIR","/workspace/tmp"),("SHELL","/bin/bash")].into_iter().map(|(k,v)|(k.into(),v.into())).collect()
}
fn params(id: &str, script: &str, stdin: bool) -> ExecParams {
    ExecParams { process_id: ProcessId::new(id), metadata:None,
        argv:vec!["/bin/bash".into(),"-c".into(),script.into()],
        cwd:PathUri::parse("file:///workspace/output").unwrap(), env_policy:None, shell_snapshot:None,
        env:env(),tty:false,pipe_stdin:stdin,arg0:None,sandbox:None,
        enforce_managed_network:false,managed_network:None,network_proxy:None }
}

#[derive(Default)]
struct Counts { complete:AtomicUsize, quarantine:AtomicUsize, not_started:AtomicUsize }
struct TestLease(Arc<Counts>, Arc<WorkspaceGrant>);
impl ExecutionLease for TestLease {
    fn not_started(self:Box<Self>){self.0.not_started.fetch_add(1,Ordering::SeqCst);}
    fn complete(&mut self)->Result<(),PolicyError>{self.0.complete.fetch_add(1,Ordering::SeqCst);Ok(())}
    fn quarantine(self:Box<Self>){self.0.quarantine.fetch_add(1,Ordering::SeqCst);}
}
/// Only the exact compiled fixtures are accepted. No model/user-supplied command
/// is granted by this test-only policy. No filesystem/network enforcement claim.
struct FixturePolicy { allowed:Vec<ExecParams>, counts:Arc<Counts>, instance:Arc<IshInstance> }
impl ExecutionPolicy for FixturePolicy {
    fn prepare<'a>(&'a self,p:&'a ExecParams)->std::pin::Pin<Box<dyn std::future::Future<Output=Result<PreparedExecution,PolicyError>>+Send+'a>> {
        Box::pin(async move {
            if !self.allowed.contains(p){return Err(PolicyError::Denied);}
            let read=["/bin","/sbin","/usr","/lib","/etc","/workspace/input"].map(std::path::PathBuf::from);
            let write=["/workspace/output","/workspace/tmp"].map(std::path::PathBuf::from);
            let grant=Arc::new(self.instance.prepare_workspace_grant(&read,&write,WorkspaceNetworkPolicy::DenyDirect).map_err(|_|PolicyError::Denied)?);
            Ok(PreparedExecution { options:SpawnOpts { argv:p.argv.clone(),envp:Some(p.env.iter().map(|(k,v)|(k.clone(),v.clone())).collect()),
                cwd:Some(p.cwd.to_abs_path().map_err(|_|PolicyError::Denied)?.to_path_buf()),
                tty:false,size:None,pipe_stdin:p.pipe_stdin,arg0:None },grant:Some(grant.clone()),lease:Box::new(TestLease(self.counts.clone(),grant)) })
        })
    }
}
struct Capture { out:Vec<u8>, err:Vec<u8>, exit:Option<i32>, failure:Option<String> }
async fn drain(p:&Arc<dyn ExecProcess>, timeout:Duration)->Result<Capture,String> {
    let deadline=Instant::now()+timeout;let mut cursor=0;let mut out=Vec::new();let mut err=Vec::new();
    loop {
        if Instant::now()>deadline {let _=p.terminate().await;return Err("drain deadline".into());}
        let r=p.read(Some(cursor),Some(65536),Some(100)).await.map_err(|e|e.to_string())?;
        for c in r.chunks {if c.seq<=cursor{return Err("nonmonotonic output".into());}cursor=c.seq;
            match c.stream {ExecOutputStream::Stderr=>err.extend_from_slice(&c.chunk.0),_=>out.extend_from_slice(&c.chunk.0)}
        }
        if r.closed{return Ok(Capture {out,err,exit:r.exit_code,failure:r.failure});}
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
async fn ready(p:&Arc<dyn ExecProcess>)->Result<(),String> {
    let until=Instant::now()+Duration::from_secs(15);
    while Instant::now()<until {
        let r=p.read(None,Some(4096),Some(100)).await.map_err(|e|e.to_string())?;
        if r.chunks.iter().any(|c|c.chunk.0.windows(5).any(|s|s==b"READY")){return Ok(());}
        if r.closed{return Err("closed before READY".into());}
    } Err("READY deadline".into())
}

async fn suite(ish:Arc<IshInstance>,work:&Path,cb:Callback)->Result<(),String> {
    let fixtures=vec![
        params("unicode",r#"printf '你好 😀\n'; printf 'ERR_ONLY\n' >&2; exit 7"#,false),
        params("stdin",r#"printf READY; IFS= read -r line; printf 'ACK:%s\n' "$line""#,true),
        params("interrupt",r#"trap 'printf INTERRUPTED; exit 17' INT; printf READY; while :; do sleep 1; done"#,false),
        params("cancel",r#"printf READY; while :; do printf x >> ticks.txt; sleep 0.1; done"#,false),
        params("fast",r#"printf FAST"#,false),
        params("budget",r#"head -c 1100000 /dev/zero"#,false),
        params("shared-write",r#"printf 'shell 中文\n' > shared.txt"#,false),
        params("shared-read",r#"cat shared.txt"#,false),
        params("language-tools",r#"python3 -c 'from pathlib import Path; p=Path("/workspace/input/source.txt"); assert p.read_text()=="fixture input\n"; Path("python.txt").write_text("python 中文\n")' && node -e 'const fs=require("fs");if(fs.readFileSync("python.txt","utf8")!=="python 中文\n")throw Error("content");fs.writeFileSync("node.tmp","node ok\n");fs.renameSync("node.tmp","node.txt");console.log("TOOLS_OK")'"#,false),
    ];
    let counts=Arc::new(Counts::default());
    let policy=Arc::new(FixturePolicy {allowed:fixtures.clone(),counts:counts.clone(),instance:ish.clone()});
    let backend=IshExecBackend::new(ish.clone(),policy,Duration::from_secs(15)).map_err(|e|e.to_string())?;
    let mut passed=0;
    for (index,request) in fixtures.into_iter().enumerate() {
        let id=request.process_id.as_str().to_owned();
        emit(cb,json!({"type":"phase","phase":id,"deadlineSeconds":80}));
        let started=Instant::now();
        let p=backend.start(request).await.map_err(|e|format!("{id}: {e}"))?.process;
        let ok=match index {
            0=>{let r=drain(&p,Duration::from_secs(20)).await?;r.out=="你好 😀\n".as_bytes()&&r.err==b"ERR_ONLY\n"&&r.exit==Some(7)&&r.failure.is_none()},
            1=>{ready(&p).await?;let w=p.write("value 中文\n".as_bytes().to_vec()).await.map_err(|e|e.to_string())?;
                let r=drain(&p,Duration::from_secs(20)).await?;w.status==codex_exec_server::WriteStatus::Accepted&&String::from_utf8_lossy(&r.out).contains("ACK:value 中文")&&r.exit==Some(0)},
            2=>{ready(&p).await?;p.signal(ProcessSignal::Interrupt).await.map_err(|e|e.to_string())?;
                let r=drain(&p,Duration::from_secs(20)).await?;r.exit==Some(17)&&String::from_utf8_lossy(&r.out).contains("INTERRUPTED")},
            3=>{ready(&p).await?;tokio::time::sleep(Duration::from_millis(250)).await;
                p.terminate().await.map_err(|e|e.to_string())?;let r=drain(&p,Duration::from_secs(5)).await?;
                let before=std::fs::metadata(work.join("output/ticks.txt")).map_err(|e|e.to_string())?.len();
                tokio::time::sleep(Duration::from_millis(300)).await;
                let after=std::fs::metadata(work.join("output/ticks.txt")).map_err(|e|e.to_string())?.len();before>0&&before==after&&r.exit.is_some()},
            4=>{let r=drain(&p,Duration::from_secs(15)).await?;r.out==b"FAST"&&r.exit==Some(0)},
            5=>{let r=drain(&p,Duration::from_secs(30)).await?;r.failure.is_some()&&r.out.len()<=1024*1024},
            6=>{let r=drain(&p,Duration::from_secs(15)).await?;
                let fs=scoped_executor_fs::ScopedExecutorFileSystem::new(vec![
                    (PathUri::parse("file:///workspace/output").unwrap(),scoped_files::ScopedFiles::open(&work.join("output"),scoped_files::Access::ReadWrite).map_err(|e|e.to_string())?),
                    (PathUri::parse("file:///workspace/input").unwrap(),scoped_files::ScopedFiles::open(&work.join("input"),scoped_files::Access::ReadOnly).map_err(|e|e.to_string())?),
                ],1024*1024).map_err(|e|e.to_string())?;
                let patch="*** Begin Patch\n*** Update File: shared.txt\n@@\n-shell 中文\n+native patch 中文\n*** End Patch";
                let mut stdout=Vec::new();let mut stderr=Vec::new();
                codex_apply_patch::apply_patch(patch,&PathUri::parse("file:///workspace/output").unwrap(),&mut stdout,&mut stderr,&fs,None).await.map_err(|e|format!("native patch: {e}"))?;
                r.exit==Some(0)&&std::fs::read_to_string(work.join("output/shared.txt")).map_err(|e|e.to_string())?=="native patch 中文\n"},
            7=>{let r=drain(&p,Duration::from_secs(15)).await?;r.exit==Some(0)&&r.out=="native patch 中文\n".as_bytes()},
            8=>{let r=drain(&p,Duration::from_secs(30)).await?;r.exit==Some(0)&&String::from_utf8_lossy(&r.out).contains("TOOLS_OK")&&std::fs::read_to_string(work.join("output/node.txt")).map_err(|e|e.to_string())?=="node ok\n"},
            _=>unreachable!(),
        };
        emit(cb,json!({"type":"case","id":id,"passed":ok,"seconds":started.elapsed().as_secs_f64()}));
        if !ok{return Err(format!("case {id} failed"));}passed+=1;
    }
    emit(cb,json!({"type":"phase","phase":"lease-check","deadlineSeconds":15}));
    tokio::time::sleep(Duration::from_millis(150)).await;
    let leases_ok=counts.complete.load(Ordering::SeqCst)==9&&counts.quarantine.load(Ordering::SeqCst)==0;
    emit(cb,json!({"type":"case","id":"leases","passed":leases_ok,
        "completed":counts.complete.load(Ordering::SeqCst),"quarantined":counts.quarantine.load(Ordering::SeqCst)}));
    if !leases_ok{return Err("unexpected lease state".into());}
    drop(backend);
    // Kernel shutdown is tested separately; do not silently claim Drop is an ack.
    emit(cb,json!({"type":"finished","allExpectationsMatched":true,"cases":passed+1,
        "scope":"actual sealed iSH + native workspace +0.166 ExecBackend/apply_patch; fixed fixtures only; no account/model/TAH test"}));
    std::mem::forget(ish);
    Ok(())
}

#[no_mangle]
pub unsafe extern "C" fn alma_backend_probe_run(_resources:*const c_char,documents:*const c_char,cb:Callback) {
    if documents.is_null(){return;}
    let path=std::path::PathBuf::from(CStr::from_ptr(documents).to_string_lossy().as_ref());
    let result=(||->Result<(),String>{
        emit(cb,json!({"type":"phase","phase":"owned-boot","deadlineSeconds":90}));
        for name in ["input","output","tmp"] {std::fs::create_dir_all(path.join("work").join(name)).map_err(|e|e.to_string())?;}
        std::fs::write(path.join("work/input/source.txt"),"fixture input\n").map_err(|e|e.to_string())?;
        let ish=Arc::new(IshInstance::boot_workspace_policy_with_workspace(&path.join("fs/data"),Some(Path::new("/workspace/output")),&path.join("work")).map_err(|e|e.to_string())?);
        let runtime=tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_stack_size(4*1024*1024)
            .enable_all().build().map_err(|e|e.to_string())?;
        runtime.block_on(suite(ish,&path.join("work"),cb))
    })();
    if let Err(message)=result{emit(cb,json!({"type":"fatal","message":message}));}
}
