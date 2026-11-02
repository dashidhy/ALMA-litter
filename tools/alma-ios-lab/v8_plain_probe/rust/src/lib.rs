//! Fixed, non-authenticated native iOS V8 capability probe, not a Code Mode host.
use std::ffi::{c_char, CString};
use std::time::Instant;
use serde_json::{json, Value};

type Callback = extern "C" fn(*const c_char);
fn emit(cb: Callback, value: Value) {
    let value = CString::new(value.to_string()).expect("JSON escapes NUL");
    cb(value.as_ptr());
}

fn reserve_address_space(bytes: usize) -> Value {
    // Reserve inaccessible address ranges only. No pages are touched or made
    // readable/writable/executable, and every successful mapping is released.
    let address = unsafe { libc::mmap(std::ptr::null_mut(), bytes, libc::PROT_NONE,
        libc::MAP_PRIVATE | libc::MAP_ANON, -1, 0) };
    if address == libc::MAP_FAILED {
        return json!({"requestedBytes":bytes,"reserved":false,"errno":std::io::Error::last_os_error().raw_os_error()});
    }
    let aligned = (address as usize) % (1usize << 40) == 0;
    let released = unsafe { libc::munmap(address, bytes) } == 0;
    json!({"requestedBytes":bytes,"reserved":true,"baseAlignedToOneTiB":aligned,"released":released,
        "pagesTouched":false})
}

fn evaluate(isolate: &mut v8::OwnedIsolate, source: &str) -> Result<String, &'static str> {
    v8::scope!(let handles, isolate);
    let context = v8::Context::new(handles, Default::default());
    let scope = &v8::ContextScope::new(handles, context);
    let source = v8::String::new(scope, source).ok_or("source allocation failed")?;
    let script = v8::Script::compile(scope, source, None).ok_or("script compile failed")?;
    let result = script.run(scope).ok_or("script execution failed")?;
    Ok(result.to_string(scope).ok_or("result conversion failed")?.to_rust_string_lossy(scope))
}

#[no_mangle]
pub extern "C" fn alma_v8_plain_probe_run(_: *const c_char, _: *const c_char, cb: Callback) {
    let thread = std::thread::Builder::new().name("alma-v8-probe".into()).stack_size(8 * 1024 * 1024)
        .spawn(move || -> Result<(), &'static str> {
            let started = Instant::now();
            emit(cb, json!({"type":"phase","phase":"v8-jitless-init","deadlineSeconds":30}));
            v8::V8::set_flags_from_string("--jitless --max-old-space-size=64");
            let platform = v8::new_default_platform(2, false).make_shared();
            v8::V8::initialize_platform(platform);
            v8::V8::initialize();
            emit(cb,json!({"type":"case","id":"initialize","passed":true,"seconds":started.elapsed().as_secs_f64(),
                "v8Version":v8::V8::get_version(),"memorySandboxRequested":false,"jitRequested":false}));
            let mut isolate = v8::Isolate::new(v8::CreateParams::default());
            let cases = [
                ("arithmetic", "1 + 2", "3"),
                ("unicode-json", "JSON.stringify({message:'中文 😀',values:[1,2,3]})", "{\"message\":\"中文 😀\",\"values\":[1,2,3]}"),
                ("set-global", "globalThis.cellLocal = 41; cellLocal + 1", "42"),
                ("fresh-context", "typeof cellLocal", "undefined"),
                ("wasm-disabled", "typeof WebAssembly", "undefined"),
            ];
            for (name, source, expected) in cases {
                emit(cb,json!({"type":"phase","phase":name,"deadlineSeconds":10}));
                let begin = Instant::now();
                let actual = evaluate(&mut isolate, source)?;
                let passed = actual == expected;
                emit(cb,json!({"type":"case","id":name,"passed":passed,"seconds":begin.elapsed().as_secs_f64()}));
                if !passed { return Err("fixed V8 fixture did not match"); }
            }
            let reservations = [reserve_address_space(1usize << 40), reserve_address_space(2usize << 40)];
            emit(cb,json!({"type":"finished","allExpectationsMatched":true,"cases":6,
                "seconds":started.elapsed().as_secs_f64(),
                "virtualReservationObservations":reservations,
                "scope":"plain iOS V8, fixed scripts only; no memory sandbox, Code Mode integration, account or recording data"}));
            drop(isolate);
            // This one-shot probe exits through the native UI harness. Production
            // platform lifecycle is not qualified by these short script checks.
            Ok(())
        });
    match thread {
        Ok(thread) => match thread.join() {
            Ok(Ok(())) => {},
            Ok(Err(message)) => emit(cb,json!({"type":"fatal","message":message})),
            Err(_) => emit(cb,json!({"type":"fatal","message":"V8 probe thread panicked"})),
        },
        Err(_) => emit(cb,json!({"type":"fatal","message":"V8 probe thread could not start"})),
    }
}
