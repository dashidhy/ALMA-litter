use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char};
use std::path::Path;
use std::time::Instant;
use ish_embed_host::IshInstance;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

type Callback = extern "C" fn(*const c_char);

#[derive(Deserialize)]
struct Case {
    id: String,
    script: String,
    marker: String,
    expected_exit: i32,
    timeout_ms: u64,
    #[serde(default)]
    checks: Vec<FileCheck>,
    #[serde(default)]
    expected_limitation: bool,
}
#[derive(Deserialize)]
struct FileCheck { file: String, sha256: Option<String>, json: Option<Value> }
#[derive(Deserialize)]
struct Plan { cases: Vec<Case> }

fn emit(cb: Callback, value: Value) {
    let message = CString::new(value.to_string()).expect("JSON contains no literal null");
    cb(message.as_ptr());
}
fn quote(s: &str) -> String { format!("'{}'", s.replace('\'', "'\\''")) }

fn process_cpu_seconds() -> f64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // RUSAGE_SELF covers this app, including interpreter workers and native UI.
    // It is not a per-guest Linux process measurement.
    unsafe {
        if libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) != 0 { return 0.0; }
        let usage = usage.assume_init();
        usage.ru_utime.tv_sec as f64 + usage.ru_utime.tv_usec as f64 / 1e6
            + usage.ru_stime.tv_sec as f64 + usage.ru_stime.tv_usec as f64 / 1e6
    }
}

fn environment() -> HashMap<String, String> {
    // Guest environment matches Litter's runtime_env; never changes host HOME.
    [("PATH","/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
     ("HOME","/root"),("USER","root"),("LOGNAME","root"),("LANG","C.UTF-8"),
     ("LC_ALL","C.UTF-8"),("TMPDIR","/tmp"),("PAGER","cat"),("EDITOR","vi"),
     ("HOSTNAME","litter"),("CODEX_HOME","/root/.codex")]
        .into_iter().map(|(k,v)|(k.into(),v.into())).collect()
}

fn command(ish: &IshInstance, script: &str, timeout: u64) -> (i32, String) {
    let argv = ["/bin/sh".into(), "-c".into(), script.into()];
    // Same public call used by Litter's ish_runtime::run_streaming.
    let (code, bytes) = ish.run_oneshot_streaming(&argv, Path::new("/"), &environment(),
                                               Some(timeout), |_| {});
    (code, String::from_utf8_lossy(&bytes).into_owned())
}

fn execute(resources: &Path, documents: &Path, cb: Callback) -> Result<(), String> {
    let plan: Plan = serde_json::from_slice(&std::fs::read(resources.join("plan.json")).map_err(|e|e.to_string())?)
        .map_err(|e|e.to_string())?;
    let began = Instant::now();
    emit(cb,json!({"type":"phase","phase":"booting","deadlineSeconds":90}));
    let ish = IshInstance::boot(&documents.join("fs/data"), Some(Path::new("/root")))
        .map_err(|e|format!("iSH bootstrap: {e}"))?;
    emit(cb,json!({"type":"booted","seconds":began.elapsed().as_secs_f64()}));
    let mount = format!("mkdir -p /work /packages && mount -t real {} /work && mount -t real {} /packages",
        quote(&documents.join("work").to_string_lossy()), quote(&resources.join("packages").to_string_lossy()));
    let (code, output) = command(&ish, &mount, 10_000);
    if code != 0 { return Err(format!("Mount failed ({code}): {output}")); }
    let mut results=Vec::new();
    for case in plan.cases {
        emit(cb,json!({"type":"phase","phase":case.id,"deadlineSeconds":case.timeout_ms/1000+15}));
        let start=Instant::now();
        let (code,output)=command(&ish,&case.script,case.timeout_ms);
        let mut checked=Vec::new();
        for check in case.checks {
            if check.file.contains('/') || check.file==".." {return Err("Invalid verification path".into());}
            let bytes=std::fs::read(documents.join("work").join(&check.file));
            let passed=bytes.as_ref().is_ok_and(|b| {
                check.sha256.as_ref().is_none_or(|h|format!("{:x}",Sha256::digest(b))==*h) &&
                check.json.as_ref().is_none_or(|j|serde_json::from_slice::<Value>(b).ok().as_ref()==Some(j))
            });
            checked.push(json!({"file":check.file,"passed":passed,"bytes":bytes.as_ref().ok().map(Vec::len)}));
        }
        let passed=code==case.expected_exit && output.contains(&case.marker) && checked.iter().all(|v|v["passed"]==true);
        let result=json!({"type":"case","id":case.id,"exitCode":code,"expectedExit":case.expected_exit,
            "seconds":start.elapsed().as_secs_f64(),"passed":passed,"checks":checked,
            "expectedLimitation":case.expected_limitation,"output":output});
        emit(cb,result.clone()); results.push(result);
        if case.id=="install" && !passed {break;}
    }
    let all_passed=results.len()>1 && results.iter().all(|v|v["passed"]==true);
    emit(cb,json!({"type":"finished","allExpectationsMatched":all_passed,"cases":results.len(),
                   "totalSeconds":began.elapsed().as_secs_f64()}));
    // The test app exits after persisting results. Its lifetime owns all guest
    // threads; no second kernel is booted in the same process.
    std::mem::forget(ish);
    Ok(())
}

#[no_mangle]
pub unsafe extern "C" fn alma_ish_probe_run(resources: *const c_char, documents: *const c_char, cb: Callback) {
    if resources.is_null() || documents.is_null() {return;}
    let root=CStr::from_ptr(resources).to_string_lossy();
    let docs=CStr::from_ptr(documents).to_string_lossy();
    if let Err(error)=execute(Path::new(root.as_ref()),Path::new(docs.as_ref()),cb) {
        emit(cb,json!({"type":"fatal","message":error}));
    }
}

/// Bounded CPU/file workload used by the native background scheduling probe.
/// Native code owns HTTPS and lifecycle reporting; this function never requires
/// network access inside the guest. Each command has its own deadline.
#[no_mangle]
pub unsafe extern "C" fn alma_ish_background_run(
    resources: *const c_char, documents: *const c_char, cycles: u32, workload: u32, cb: Callback,
    should_stop: extern "C" fn() -> bool,
) {
    if resources.is_null() || documents.is_null() { return; }
    let resources = std::path::PathBuf::from(CStr::from_ptr(resources).to_string_lossy().as_ref());
    let documents = std::path::PathBuf::from(CStr::from_ptr(documents).to_string_lossy().as_ref());
    let result = (|| -> Result<(), String> {
        let ish = IshInstance::boot(&documents.join("fs/data"), Some(Path::new("/root")))
            .map_err(|e| e.to_string())?;
        let mount = format!("mkdir -p /work /packages && mount -t real {} /work && mount -t real {} /packages",
            quote(&documents.join("work").to_string_lossy()), quote(&resources.join("packages").to_string_lossy()));
        for (name, script, timeout) in [
            ("mount", mount, 10_000),
            ("install", "apk add --no-network /packages/*.apk".to_string(), 180_000),
        ] {
            if should_stop() { std::mem::forget(ish); return Err("native stop requested".into()); }
            let start = Instant::now();
            let (code, _) = command(&ish, &script, timeout);
            emit(cb, json!({"type":"setup", "id":name,"exitCode":code,"seconds":start.elapsed().as_secs_f64()}));
            if code != 0 { std::mem::forget(ish); return Err(format!("{name} failed: {code}")); }
        }
        // Node-only control separates longer interpreter startup/CPU work
        // from the scheduler's treatment of long gaps without progress.
        if workload == 1 {
            std::fs::write(documents.join("work/background_node.cjs"), r#"
const fs=require('node:fs'), crypto=require('node:crypto');
const data=JSON.parse(fs.readFileSync('/work/fixture.json','utf8'));
const text=data.turns.map(t=>t.text).join('\n');
if(crypto.createHash('sha256').update(text).digest('hex')!=='4a6a25fc2470c69a228caf02c5b692cca6b357b279eac29bb12a2adff6894801')throw Error('fixture hash');
fs.writeFileSync('/work/background-note.tmp',text);
fs.renameSync('/work/background-note.tmp','/work/background-note.txt');
if(fs.readFileSync('/work/background-note.txt','utf8')!==text)throw Error('readback');
console.log('NODE_TEXT_OK');
"#).map_err(|e|e.to_string())?;
        }
        let script = if workload == 1 { "cd /work && node background_node.cjs" }
            else { "cd /work && python3 python_probe.py && node node_probe.cjs" };
        for index in 0..cycles.min(300) {
            if should_stop() { break; }
            emit(cb, json!({"type":"cycle-start", "index":index}));
            let start = Instant::now();
            let cpu_start = process_cpu_seconds();
            let (code, out) = command(&ish, script, 90_000);
            let passed = code == 0 && (workload == 1 || out.contains("PYTHON_TEXT_OK")) && out.contains("NODE_TEXT_OK");
            emit(cb, json!({"type":"cycle", "index":index,"passed":passed,
                "exitCode":code,"seconds":start.elapsed().as_secs_f64(),
                "appCpuSeconds":process_cpu_seconds()-cpu_start}));
            if !passed { std::mem::forget(ish); return Err("guest text processing failed".into()); }
            // Callback performs native HTTPS (periodically) and the configured
            // wait. The wait deliberately reports no artificial progress.
            emit(cb, json!({"type":"between", "index":index}));
        }
        std::mem::forget(ish); // One test kernel, owned until test app exits.
        emit(cb,json!({"type":"finished","cancelled":should_stop()}));
        Ok(())
    })();
    if let Err(error) = result { emit(cb,json!({"type":"fatal","message":error})); }
}
