//! Disposable, no-auth functional probe of unchanged official Code Mode source.
//! Plain V8 deliberately lacks the upstream-required V8 memory sandbox.
use codex_code_mode_runtime::*;
use codex_protocol::ToolName;
use serde_json::{json, Value};
use std::ffi::{c_char, CString};
use std::sync::{Arc, Condvar, Mutex};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

type Callback = extern "C" fn(*const c_char);
static STARTED: AtomicBool = AtomicBool::new(false);
fn emit(cb: Callback, value: Value) {
    let json = CString::new(value.to_string()).expect("JSON escapes NUL");
    cb(json.as_ptr());
}
fn check(value: bool, message: &str) -> Result<(), String> {
    if value { Ok(()) } else { Err(message.into()) }
}
async fn bounded<T>(future: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::time::timeout(Duration::from_secs(5), future).await
        .map_err(|_| "probe operation deadline exceeded; cleanup not yet confirmed".to_string())?
}
#[derive(Default)]
struct Synthetic {
    tools_started: AtomicUsize,
    tools_cancelled: AtomicUsize,
    notifications_done: AtomicUsize,
    closed: AtomicUsize,
}
impl CodeModeSessionDelegate for Synthetic {
    fn invoke_tool<'a>(&'a self, call: CodeModeNestedToolCall, cancel: CancellationToken) -> ToolInvocationFuture<'a> {
        Box::pin(async move {
            self.tools_started.fetch_add(1, Ordering::SeqCst);
            match call.input {
                Some(Value::String(ref value)) if value == "block" => {
                    cancel.cancelled().await;
                    self.tools_cancelled.fetch_add(1, Ordering::SeqCst);
                    Err("synthetic tool cancelled".into())
                }
                input => { tokio::task::yield_now().await; Ok(input.unwrap_or(Value::Null)) }
            }
        })
    }
    fn notify<'a>(&'a self, _: String, _: CellId, _: String, cancel: CancellationToken) -> NotificationFuture<'a> {
        Box::pin(async move {
            tokio::select! {
                _ = cancel.cancelled() => Err("synthetic notification cancelled".into()),
                _ = tokio::time::sleep(Duration::from_millis(15)) => {
                    self.notifications_done.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }
        })
    }
    fn cell_closed(&self, _: &CellId) { self.closed.fetch_add(1, Ordering::SeqCst); }
}
fn request(source: &str, yield_ms: u64) -> ExecuteRequest {
    ExecuteRequest {
        tool_call_id: "synthetic-probe-call".into(), source: source.into(),
        yield_time_ms: Some(yield_ms), max_output_tokens: None,
        enabled_tools: vec![ToolDefinition {
            name: "probe_echo".into(), tool_name: ToolName::plain("probe_echo"),
            description: "Local synthetic echo/block fixture; no external operations".into(),
            kind: CodeModeToolKind::Function, input_schema: None,
            input_schema_max_bytes: None, output_schema: None,
        }],
    }
}
fn text_items(items: &[FunctionCallOutputContentItem]) -> Result<Vec<String>, String> {
    items.iter().map(|item| match item {
        FunctionCallOutputContentItem::InputText { text } => Ok(text.clone()),
        _ => Err("unexpected media in fixed text probe".into()),
    }).collect()
}
fn complete(response: RuntimeResponse) -> Result<Vec<String>, String> {
    match response {
        RuntimeResponse::Result { content_items, error_text: None, .. } => text_items(&content_items),
        RuntimeResponse::Result { error_text: Some(error), .. } => Err(error),
        _ => Err("expected completed result, observed nonterminal/terminated response".into()),
    }
}
async fn run_cell(session: &dyn CodeModeSession, delegate: Arc<Synthetic>, source: &str) -> Result<Vec<String>, String> {
    bounded(async {
        let started = session.execute(request(source, 1000), delegate, None).await?;
        complete(started.initial_response().await?)
    }).await
}
async fn wait_counter(value: &AtomicUsize, minimum: usize) -> Result<(), String> {
    bounded(async {
        while value.load(Ordering::SeqCst) < minimum { tokio::time::sleep(Duration::from_millis(1)).await; }
        Ok(())
    }).await
}
async fn cases(session: Arc<dyn CodeModeSession>, cb: Callback) -> Result<usize, String> {
    let delegate = Arc::new(Synthetic::default());
    let mut count = 0;
    macro_rules! case {
        ($id:expr, $body:expr) => {{
            emit(cb, json!({"type":"phase","phase":$id,"deadlineSeconds":15}));
            let begin = Instant::now();
            let result: Result<(), String> = async { $body }.await;
            emit(cb, json!({"type":"case","id":$id,"passed":result.is_ok(),"seconds":begin.elapsed().as_secs_f64()}));
            result?; count += 1;
        }};
    }
    case!("text-utf8", {
        check(run_cell(session.as_ref(), delegate.clone(), "text('中文 😀'); text({value:42});").await? == ["中文 😀", "{\"value\":42}"], "text mismatch")
    });
    case!("fresh-realm-and-session-stores", {
        run_cell(session.as_ref(), delegate.clone(), "globalThis.cellOnly=7; store('shared',{value:42});").await?;
        check(run_cell(session.as_ref(), delegate.clone(), "text(typeof cellOnly); text(load('shared'));").await? == ["undefined", "{\"value\":42}"], "realm/store mismatch")?;
        let isolated: Arc<dyn CodeModeSession> = Arc::new(InProcessCodeModeSession::new());
        let result = run_cell(isolated.as_ref(), delegate.clone(), "text(load('shared'));").await;
        bounded(isolated.shutdown()).await?;
        check(result? == ["undefined"], "store crossed session boundary")
    });
    case!("synthetic-nested-tools-promise-all", {
        let before = delegate.tools_started.load(Ordering::SeqCst);
        check(run_cell(session.as_ref(), delegate.clone(), "text(await Promise.all([tools.probe_echo({n:1}),tools.probe_echo({n:2})]));").await? == ["[{\"n\":1},{\"n\":2}]"], "nested tools mismatch")?;
        check(delegate.tools_started.load(Ordering::SeqCst) == before + 2, "nested dispatch count")
    });
    case!("notification-drain", {
        let before = delegate.notifications_done.load(Ordering::SeqCst);
        check(run_cell(session.as_ref(), delegate.clone(), "notify('synthetic notice'); text('done');").await? == ["done"], "notification result")?;
        check(delegate.notifications_done.load(Ordering::SeqCst) == before + 1, "result delivered before notification drained")
    });
    case!("yield-wait-incremental-output", {
        let started = bounded(session.execute(request("text('first'); await yield_control(); await new Promise(r=>setTimeout(r,60)); text('second');", 1000), delegate.clone(), None)).await?;
        let id = started.cell_id.clone();
        match bounded(started.initial_response()).await? {
            RuntimeResponse::Yielded { content_items, .. } => check(text_items(&content_items)? == ["first"], "initial yield output")?,
            _ => return Err("expected explicit yield".into()),
        }
        let response = bounded(session.wait(WaitRequest { cell_id: id, yield_time_ms:1000, max_output_tokens:None }, None)).await?;
        match response {
            WaitOutcome::LiveCell(value) => check(complete(value)? == ["second"], "wait duplicated/lost output"),
            _ => Err("yielded cell missing".into()),
        }
    });
    case!("uncatchable-exit-prior-store", {
        check(run_cell(session.as_ref(), delegate.clone(), "store('exit-phase','before'); text('before'); Promise.resolve().then(()=>{store('exit-phase','microtask'); text('microtask');}); try {exit();} catch {text('caught');} finally {store('exit-phase','finally');text('finally');} text('after');").await? == ["before"], "exit ran later code")?;
        check(run_cell(session.as_ref(), delegate.clone(), "text(load('exit-phase'));").await? == ["before"], "exit write-set mismatch")
    });
    case!("cpu-terminate-no-store-commit", {
        let notifications = delegate.notifications_done.load(Ordering::SeqCst);
        let started = bounded(session.execute(request("store('cancelled-store','must-not-commit'); notify('cpu-ready'); for (;;) {}", 5), delegate.clone(), None)).await?;
        let id = started.cell_id.clone();
        check(matches!(bounded(started.initial_response()).await?, RuntimeResponse::Yielded {..}), "CPU cell did not yield")?;
        wait_counter(&delegate.notifications_done, notifications+1).await?;
        check(matches!(bounded(session.terminate(id.into())).await?, WaitOutcome::LiveCell(RuntimeResponse::Terminated {..})), "CPU termination not acknowledged")?;
        check(run_cell(session.as_ref(), delegate.clone(), "text(load('cancelled-store'));").await? == ["undefined"], "terminated store committed")
    });
    case!("callback-cancel-before-termination", {
        let began = delegate.tools_started.load(Ordering::SeqCst);
        let cancelled = delegate.tools_cancelled.load(Ordering::SeqCst);
        let started = bounded(session.execute(request("await tools.probe_echo('block');", 5), delegate.clone(), None)).await?;
        let id = started.cell_id.clone();
        check(matches!(bounded(started.initial_response()).await?, RuntimeResponse::Yielded {..}), "callback cell did not yield")?;
        wait_counter(&delegate.tools_started, began+1).await?;
        check(matches!(bounded(session.terminate(id.into())).await?, WaitOutcome::LiveCell(RuntimeResponse::Terminated {..})), "callback termination result")?;
        check(delegate.tools_cancelled.load(Ordering::SeqCst) == cancelled+1, "termination preceded callback cleanup")
    });
    case!("shutdown-cancels-and-rejects-admission", {
        let began = delegate.tools_started.load(Ordering::SeqCst);
        let cancelled = delegate.tools_cancelled.load(Ordering::SeqCst);
        let started = bounded(session.execute(request("await tools.probe_echo('block');", 5), delegate.clone(), None)).await?;
        check(matches!(bounded(started.initial_response()).await?, RuntimeResponse::Yielded {..}), "shutdown fixture did not yield")?;
        wait_counter(&delegate.tools_started, began+1).await?;
        bounded(session.shutdown()).await?;
        check(delegate.tools_cancelled.load(Ordering::SeqCst) == cancelled+1, "shutdown preceded callback cleanup")?;
        check(bounded(session.execute(request("text('must not run');", 5), delegate.clone(), None)).await.is_err(), "shutdown accepted new cell")
    });
    Ok(count)
}

#[unsafe(no_mangle)]
pub extern "C" fn alma_official_code_mode_probe_run(_: *const c_char, _: *const c_char, cb: Callback) {
    if STARTED.swap(true, Ordering::SeqCst) {
        emit(cb, json!({"type":"fatal","message":"one-shot probe already started"})); return;
    }
    let finished = Arc::new((Mutex::new(false), Condvar::new()));
    let signal = finished.clone();
    let guard = std::thread::Builder::new().name("official-probe-watchdog".into()).spawn(move || {
        let (lock, wake) = &*signal;
        let (done, timeout) = wake.wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(60), |done| !*done).unwrap();
        if timeout.timed_out() && !*done {
            emit(cb, json!({"type":"fatal","message":"60-second hard deadline; cleanup unconfirmed; exiting disposable probe"}));
            unsafe { libc::_exit(124) }
        }
    });
    if guard.is_err() { emit(cb, json!({"type":"fatal","message":"could not arm watchdog"})); return; }
    let started = Instant::now();
    let result = std::panic::catch_unwind(|| -> Result<usize, String> {
        emit(cb, json!({"type":"phase","phase":"official-v8-jitless-init","deadlineSeconds":10}));
        initialize_v8(V8JitMode::Disabled)?;
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_time().build().map_err(|e| e.to_string())?;
        let result = runtime.block_on(async {
            let session: Arc<dyn CodeModeSession> = Arc::new(InProcessCodeModeSession::new());
            let result = cases(session.clone(), cb).await;
            let cleanup = bounded(session.shutdown()).await;
            cleanup?;
            result
        });
        runtime.shutdown_timeout(Duration::from_secs(2));
        result
    });
    match result {
        Ok(Ok(count)) => emit(cb, json!({"type":"finished","allExpectationsMatched":true,"cases":count,"seconds":started.elapsed().as_secs_f64(),"memorySandboxRequested":false,"jitRequested":false,"scope":"official Code Mode fixed synthetic fixtures; plain V8 without memory sandbox; no model/network/auth/security parity qualification"})),
        Ok(Err(error)) => emit(cb, json!({"type":"fatal","message":error})),
        Err(_) => emit(cb, json!({"type":"fatal","message":"official runtime probe panicked"})),
    }
    let (lock, wake) = &*finished;
    *lock.lock().unwrap() = true;
    wake.notify_all();
    if let Ok(guard) = guard { let _ = guard.join(); }
}
