use serde_json::Value;

#[cfg(target_os="ios")]
mod native {
    use super::*;
    // Include the actual backend and its exported UniFFI objects in this ONE
    // static library; never link a second Rust std/runtime archive beside it.
    use codex_mobile_client as _;
    use std::{collections::HashMap,ffi::{c_char,CStr,CString},sync::{Mutex,OnceLock,atomic::{AtomicU64,Ordering}}};
    use tokio::sync::oneshot;
    use tauri::Emitter;
    use std::sync::{Arc, atomic::AtomicBool, mpsc::{sync_channel, SyncSender}};
    static APP: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);
    type Reply=Result<Vec<u8>,String>;
    static NEXT:AtomicU64=AtomicU64::new(1);
    type Pending=HashMap<u64,oneshot::Sender<Reply>>;
    fn pending()->&'static Mutex<Pending>{static P:OnceLock<Mutex<Pending>>=OnceLock::new();P.get_or_init(||Mutex::new(HashMap::new()))}
    struct PendingCall(u64);
    impl Drop for PendingCall {
        fn drop(&mut self){if let Ok(mut p)=pending().lock(){p.remove(&self.0);}}
    }
    unsafe extern "C" {
        fn alma_tah_prepare_process()->bool;
        fn alma_tah_ui_set_changed_callback(callback:Option<extern "C" fn()>);
        fn alma_tah_ui_call(id:u64,payload:*const c_char,callback:extern "C" fn(u64,*const c_char,*const c_char));
        fn alma_tah_ui_set_working_callback(callback:Option<extern "C" fn(u64,u64,*const c_char)->bool>);
        fn alma_tah_ui_working_subscribe(subscription_id:u64);
        fn alma_tah_ui_working_ack(subscription_id:u64,sequence:u64);
        fn alma_tah_ui_working_unsubscribe(subscription_id:u64);
    }
    const MAX_WORKING_BYTES:usize=8*1024*1024;
    const MAX_WORKING_EVENTS:usize=512;
    const MAX_JS_INTEGER:u64=9_007_199_254_740_991;
    static NEXT_WORKING:AtomicU64=AtomicU64::new(1);
    struct Working {
        id:u64,
        sender:SyncSender<(u64,Vec<u8>)>,
        active:Arc<AtomicBool>,
        outstanding:u64,
        last_sequence:u64,
        last_ack:u64,
    }
    static WORKING:Mutex<Option<Working>>=Mutex::new(None);

    extern "C" fn working_frame(id:u64,sequence:u64,payload:*const c_char)->bool {
        if payload.is_null() || sequence==0 || sequence>MAX_JS_INTEGER {return false}
        let sender={
            let Ok(mut slot)=WORKING.lock() else{return false};
            let Some(stream)=slot.as_mut().filter(|s|s.id==id) else{return false};
            if stream.outstanding!=0 || sequence<=stream.last_sequence {return false}
            stream.outstanding=sequence;
            stream.sender.clone()
        };
        // The C ABI lends a NUL-terminated string for this call only. Bound
        // the scan as well as the allocation; do not parse or send on MainActor.
        let bytes=unsafe {
            let mut length=0;
            while length<=MAX_WORKING_BYTES && *payload.add(length)!=0 {length+=1;}
            if length>MAX_WORKING_BYTES {None}
            else {Some(std::slice::from_raw_parts(payload.cast::<u8>(),length).to_vec())}
        };
        let accepted=bytes.is_some_and(|bytes|sender.try_send((sequence,bytes)).is_ok());
        if let Ok(mut slot)=WORKING.lock() {
            if let Some(stream)=slot.as_mut().filter(|s|s.id==id) {
                if accepted {stream.last_sequence=stream.last_sequence.max(sequence);}
                else if stream.outstanding==sequence {stream.outstanding=0;}
                return accepted;
            }
        }
        false
    }
    fn decode_working(bytes:&[u8],id:u64,sequence:u64)->Result<Value,()> {
        let mut value:Value=serde_json::from_slice(bytes).map_err(|_|())?;
        let frame=value.as_object_mut().ok_or(())?;
        if frame.get("subscriptionID").is_some_and(|v|v.as_u64()!=Some(id)) {return Err(())}
        frame.insert("subscriptionID".into(),Value::from(id));
        let base=frame.get("baseSequence").and_then(Value::as_u64).ok_or(())?;
        if frame.get("schemaVersion").and_then(Value::as_u64)!=Some(1)
            || frame.get("sequence").and_then(Value::as_u64)!=Some(sequence)
            || base>=sequence || frame.get("reset").and_then(Value::as_bool).is_none() {return Err(())}
        match frame.get("log") {
            Some(Value::Null)=>{},
            Some(Value::Object(log)) if !log.contains_key("events")=>{},
            _=>return Err(()),
        }
        for key in ["events","removed","order"] {
            if !frame.get(key).and_then(Value::as_array).is_some_and(|items|items.len()<=MAX_WORKING_EVENTS) {return Err(())}
        }
        Ok(value)
    }
    pub fn working_unsubscribe(id:u64) {
        let removed={
            let Ok(mut slot)=WORKING.lock() else{return};
            if slot.as_ref().is_some_and(|s|s.id==id) {slot.take()} else {None}
        };
        if let Some(stream)=removed {
            stream.active.store(false,Ordering::Release);
            drop(stream); // Disconnect the worker before calling foreign code.
            unsafe{alma_tah_ui_working_unsubscribe(id)};
        }
    }
    pub fn working_subscribe(channel:tauri::ipc::Channel<Value>)->Result<u64,String> {
        let id=NEXT_WORKING.fetch_update(Ordering::Relaxed,Ordering::Relaxed,|id|id.checked_add(1).filter(|next|*next<=MAX_JS_INTEGER))
            .map_err(|_|"working_subscription_exhausted")?;
        let(tx,rx)=sync_channel(1);
        let active=Arc::new(AtomicBool::new(true));
        let old={
            let mut slot=WORKING.lock().map_err(|_|"working_unavailable")?;
            if slot.as_ref().is_some_and(|s|s.id>id) {return Err("working_subscription_superseded".into())}
            slot.replace(Working{id,sender:tx,active:active.clone(),outstanding:0,last_sequence:0,last_ack:0})
        };
        if let Some(old)=old {
            old.active.store(false,Ordering::Release);
            let old_id=old.id;drop(old);
            unsafe{alma_tah_ui_working_unsubscribe(old_id)};
        }
        // Dedicated bounded worker: neither JSON parsing nor Channel::send
        // executes in the Swift callback. There is no unbounded task spawning.
        if std::thread::Builder::new().name("tah-working".into()).spawn(move || {
            while let Ok((sequence,bytes))=rx.recv() {
                if !active.load(Ordering::Acquire) {break}
                let value=match decode_working(&bytes,id,sequence) {
                    Ok(value)=>value,
                    Err(())=>{
                        // Invalid envelope makes the consumer reconnect; never
                        // acknowledge a frame merely because Rust enqueued it.
                        let _=channel.send(serde_json::json!({"subscriptionID":id,"error":"working_frame_invalid"}));
                        working_unsubscribe(id);break;
                    }
                };
                if !active.load(Ordering::Acquire) {break}
                if channel.send(value).is_err() {working_unsubscribe(id);break;}
            }
        }).is_err() {working_unsubscribe(id);return Err("working_worker_unavailable".into())}
        // Swift also guards monotonic subscription IDs, including calls that
        // race a replacement after this lock-free active check.
        let current=WORKING.lock().map_err(|_|"working_unavailable")?.as_ref().is_some_and(|s|s.id==id);
        if current {unsafe{alma_tah_ui_working_subscribe(id)};}
        Ok(id)
    }
    pub fn working_ack(id:u64,sequence:u64)->Result<(),String> {
        {
            let mut slot=WORKING.lock().map_err(|_|"working_unavailable")?;
            let Some(stream)=slot.as_mut().filter(|s|s.id==id) else{return Err("working_subscription_closed".into())};
            if sequence!=0 && sequence<=stream.last_ack {return Ok(())}
            if sequence==0 || stream.outstanding!=sequence {return Err("working_ack_invalid".into())}
            stream.outstanding=0;stream.last_ack=sequence;
        }
        unsafe{alma_tah_ui_working_ack(id,sequence)};
        Ok(())
    }
    extern "C" fn complete(id:u64,payload:*const c_char,error:*const c_char){
        // Swift calls back on the UI actor. Copy its borrowed bytes only; parse
        // after the async receiver resumes, away from that actor.
        let result=unsafe {
            if !error.is_null(){Err(CStr::from_ptr(error).to_string_lossy().into_owned())}
            else if payload.is_null(){Err("native_response_missing".into())}
            else {Ok(CStr::from_ptr(payload).to_bytes().to_vec())}
        };
        if let Ok(mut p)=pending().lock(){if let Some(reply)=p.remove(&id){let _=reply.send(result);}}
    }
    extern "C" fn changed() {
        // Empty invalidation only: no snapshot encoding, parsing, or Core reads.
        let app = APP.lock().ok().and_then(|app| app.clone());
        if let Some(app) = app { let _ = app.emit("tah:changed", ()); }
    }
    pub fn subscribe(app: tauri::AppHandle) {
        if let Ok(mut slot) = APP.lock() { *slot = Some(app); }
        unsafe { alma_tah_ui_set_changed_callback(Some(changed)); }
        unsafe { alma_tah_ui_set_working_callback(Some(working_frame)); }
    }
    pub fn unsubscribe() {
        if let Ok(mut slot) = APP.lock() { *slot = None; }
        unsafe { alma_tah_ui_set_changed_callback(None); }
        let id=WORKING.lock().ok().and_then(|slot|slot.as_ref().map(|s|s.id));
        if let Some(id)=id {working_unsubscribe(id);}
        unsafe { alma_tah_ui_set_working_callback(None); }
    }
    pub fn prepare()->bool{unsafe{alma_tah_prepare_process()}}
    pub async fn call(method:String,value:Value)->Result<Value,String>{
        let body=serde_json::to_vec(&serde_json::json!({"method":method,"value":value})).map_err(|_|"invalid_request")?;
        if body.len()>32*1024*1024{return Err("request_too_large".into())}
        let body=CString::new(body).map_err(|_|"invalid_request")?;
        let id=NEXT.fetch_add(1,Ordering::Relaxed);let(tx,rx)=oneshot::channel();
        {let mut p=pending().lock().map_err(|_|"unavailable")?;if p.len()>=32{return Err("busy".into())}p.insert(id,tx);}
        let registration=PendingCall(id); // Also releases capacity when this future is dropped.
        unsafe{alma_tah_ui_call(id,body.as_ptr(),complete)};
        let result=tokio::time::timeout(std::time::Duration::from_secs(180),rx).await;
        drop(registration);
        let bytes=result.map_err(|_|"native_timeout")?.map_err(|_|"native_closed")??;
        tokio::task::spawn_blocking(move || serde_json::from_slice(&bytes).map_err(|_|"native_response_invalid".to_owned()))
            .await.map_err(|_|"native_response_invalid".to_owned())?
    }
}

#[tauri::command]
fn tah_working_stream(on_event:tauri::ipc::Channel<Value>)->Result<u64,String>{
    #[cfg(target_os="ios")]{native::working_subscribe(on_event)}
    #[cfg(not(target_os="ios"))]{let _=on_event;Err("Phone native backend unavailable".into())}
}

#[tauri::command]
fn tah_working_ack(subscription_i_d:u64,sequence:u64)->Result<(),String>{
    // Tauri camel-cases argument names; separate acronym letters preserve the
    // public invoke key `subscriptionID` (rather than `subscriptionId`).
    #[cfg(target_os="ios")]{native::working_ack(subscription_i_d,sequence)}
    #[cfg(not(target_os="ios"))]{let _=(subscription_i_d,sequence);Err("Phone native backend unavailable".into())}
}

#[tauri::command]
fn tah_working_unsubscribe(subscription_i_d:u64)->Result<(),String>{
    #[cfg(target_os="ios")]{native::working_unsubscribe(subscription_i_d);Ok(())}
    #[cfg(not(target_os="ios"))]{let _=subscription_i_d;Err("Phone native backend unavailable".into())}
}

#[tauri::command]
async fn tah_ui(method:String,value:Value)->Result<Value,String>{
    #[cfg(target_os="ios")]{native::call(method,value).await}
    #[cfg(not(target_os="ios"))]{let _=(method,value);Err("Phone native backend unavailable".into())}
}

#[tauri::command]
fn tah_theme(webview:tauri::WebviewWindow,dark:bool)->Result<(),String>{
    #[cfg(target_os="ios")]{
        use objc2_ui_kit::{UIViewController,UIUserInterfaceStyle};
        // Match the native WKWebView/host background too: UIKit can expose it
        // while the keyboard pans/resizes the visual viewport.
        webview.as_ref().set_background_color(Some(if dark {
            tauri::webview::Color(19,22,19,255)
        } else {
            tauri::webview::Color(250,247,239,255)
        })).map_err(|_|"Theme background update unavailable")?;
        webview.with_webview(move|platform|{
            if let Some(controller)=unsafe{platform.view_controller().cast::<UIViewController>().as_ref()}{
                controller.setOverrideUserInterfaceStyle(if dark{UIUserInterfaceStyle::Dark}else{UIUserInterfaceStyle::Light});
                controller.setNeedsStatusBarAppearanceUpdate();
            }
        }).map_err(|_|"Theme update unavailable")?;
    }
    #[cfg(not(target_os="ios"))]let _=(webview,dark);
    Ok(())
}

#[cfg_attr(mobile,tauri::mobile_entry_point)]
pub fn run(){
    // This synchronous call precedes Tauri/Tokio/provider startup.
    #[cfg(target_os="ios")]if !native::prepare(){panic!("Native provider process preparation failed")}
    tauri::Builder::default()
        .setup(|app|{
            #[cfg(target_os="ios")]native::subscribe(app.handle().clone());
            let builder=tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::App("index.html".into()))
                .title("ALMA TAH").inner_size(390.0,844.0)
                .background_color(tauri::webview::Color(19,22,19,255))
                .on_navigation(|url|url.scheme()=="tauri" || (url.host_str()==Some("tauri.localhost")&&["http","https"].contains(&url.scheme())) || url.as_str()=="about:blank");
            // This is the supported Tauri/Wry accessory hook, not a private
            // WKContentView swizzle. The composer provides its own dismissal.
            #[cfg(target_os="ios")]
            let builder=builder.with_input_accessory_view_builder(|_|None);
            builder.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![tah_ui,tah_theme,tah_working_stream,tah_working_ack,tah_working_unsubscribe])
        .build(tauri::generate_context!()).expect("ALMA TAH could not start")
        .run(|_app, _event| {
            #[cfg(target_os="ios")]
            if matches!(_event, tauri::RunEvent::Exit) { native::unsubscribe(); }
        });
}
