//! Trusted mobile composition boundary. The JS Framework owns all TAH decisions;
//! this host materializes declared bytes, binds native auth and routes the Adapter
//! to its backend. No model tokens, secrets or desktop control process enter JS.
use crate::auth_refresh::ChatgptAuthRefreshTokens;
use crate::provider_bridge::{NativeProviderBridge, NativeServerRequestHandler};
use crate::provider_runtime_config::PreparedRuntimeConfig;
use crate::provider_scope::{GuestScope, PreparedScope, ProviderScopeFactory, ScopeFile, ScopeSpec};
use crate::kimi_backend::KimiBackend;
use base64::{Engine, engine::general_purpose::STANDARD};
use codex_app_server_protocol::{ServerRequest, JSONRPCErrorError};
use codex_config::TomlValue;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use uuid::Uuid;

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MobileTahError {
    #[error("mobile provider unavailable")] Unavailable,
    #[error("invalid mobile provider request")] InvalidRequest,
    #[error("mobile provider cleanup is incomplete")] Cleanup,
}
pub(crate) type Result<T> = std::result::Result<T, MobileTahError>;
pub(crate) fn invalid() -> MobileTahError { MobileTahError::InvalidRequest }
pub(crate) fn unavailable<E>(_:E)->MobileTahError{MobileTahError::Unavailable}
pub(crate) fn text<'a>(v:&'a Value,k:&str)->Result<&'a str>{v.get(k).and_then(Value::as_str).ok_or_else(invalid)}

fn provider_executor()->Result<&'static tokio::runtime::Runtime>{
    static EXECUTOR:OnceLock<std::result::Result<tokio::runtime::Runtime,()>>=OnceLock::new();
    EXECUTOR.get_or_init(||tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2).thread_stack_size(8*1024*1024).thread_name("alma-provider")
        .enable_all().build().map_err(|_|())).as_ref().map_err(unavailable)
}

/// Synchronous native App startup entry, before any AppClient/Tokio/network use.
#[uniffi::export]
pub fn initialize_mobile_tah_process(application_support:String)->Result<()> {
    // The standalone app calls this from App.init before creating its runtime.
    // This process-wide TLS setting is never changed between attempts.
    unsafe {crate::provider_runtime_config::initialize_mobile_provider_process(&PathBuf::from(application_support))}.map_err(unavailable)
}

#[derive(Clone,Copy,PartialEq,Eq)]
enum Phase { Prepared, Bound, Started, Authenticated, Sealed, Closed }
struct Lease { credential:String, account_id:String, phase:Phase, expected:Option<Value> }
struct State {
    credentials: HashMap<String, ChatgptAuthRefreshTokens>,
    leases: HashMap<String, Lease>,
    kimi_credentials: HashMap<String, Arc<str>>,
}

struct KimiEntry {
    prepared: Option<PreparedScope>,
    scope: Option<Arc<GuestScope>>,
    backend: Option<Arc<KimiBackend>>,
    attempt: Value,
    credential: String,
    starting: bool,
    cancelled: bool,
    closed: bool,
}

struct RefreshHandler { state:Arc<Mutex<State>> }
impl NativeServerRequestHandler for RefreshHandler {
    fn handle<'a>(&'a self,handle:&'a str,request:&'a ServerRequest)
        ->Pin<Box<dyn Future<Output=Option<std::result::Result<Value,JSONRPCErrorError>>>+Send+'a>> {
        Box::pin(async move{
            let ServerRequest::ChatgptAuthTokensRefresh{params,..}=request else{return None};
            let expected=self.state.lock().ok().and_then(|s|s.leases.get(handle).map(|l|l.account_id.clone()));
            let Some(expected)=expected else{return Some(Err(JSONRPCErrorError{code:-32000,message:"Native authentication unavailable".into(),data:None}))};
            if params.previous_account_id.as_ref().is_some_and(|id|id!=&expected){return Some(Err(JSONRPCErrorError{code:-32000,message:"Native account changed".into(),data:None}))}
            let mut params=params.clone();params.previous_account_id=Some(expected);
            let (tx,rx)=tokio::sync::oneshot::channel();
            let _=crate::auth_refresh::dispatcher().dispatch(true,params,tokio::time::Instant::now(),move|result|async move{
                tx.send(result.map(|value|serde_json::to_value(value).expect("typed auth response"))).map_err(|_|())
            }).await;
            Some(rx.await.unwrap_or_else(|_|Err(JSONRPCErrorError{code:-32000,message:"Native authentication unavailable".into(),data:None})))
        })
    }
}

#[derive(uniffi::Object)]
pub struct MobileTahHost {
    runtime: tokio::sync::OnceCell<PreparedHost>,
    bundle_fs: PathBuf,
    support: PathBuf,
    state:Arc<Mutex<State>>,
    code_mode: tokio::sync::OnceCell<Arc<dyn codex_code_mode_protocol::CodeModeSessionProvider>>,
    kimi_entries: Mutex<HashMap<String, KimiEntry>>,
    kimi_ready: tokio::sync::OnceCell<()>,
    zcode_ready: tokio::sync::OnceCell<()>,
    zcode: crate::mobile_zcode::ZCodeHost,
}

struct PreparedHost {
    bridge: NativeProviderBridge,
    factory: ProviderScopeFactory,
    workspace: PathBuf,
}

#[uniffi::export(async_runtime="tokio")]
impl MobileTahHost {
    #[uniffi::constructor]
    pub async fn new(bundle_fs:String,application_support:String)->Result<Arc<Self>>{
        provider_executor()?.spawn(async move {Box::pin(Self::new_inner(bundle_fs,application_support)).await}).await.map_err(unavailable)?
    }

    /// UniFFI async_runtime enters Tokio context but does not move polling off
    /// Swift's cooperative thread. Keep large upstream futures on owned workers.
    pub async fn call(self:Arc<Self>,method:String,payload:String)->Result<String>{
        provider_executor()?.spawn(async move {Box::pin(self.call_inner(method,payload)).await}).await.map_err(unavailable)?
    }

    pub fn configure_zcode_store(&self,store:Box<dyn crate::mobile_zcode::ZCodeCredentialStore>)->Result<()> {
        self.zcode.configure_store(Arc::from(store))
    }

    /// Called only by native Keychain plumbing. No token-bearing JSON method exists.
    pub fn register_credential(&self,tokens:ChatgptAuthRefreshTokens)->Result<String>{
        if tokens.access_token.is_empty()||tokens.account_id.is_empty(){return Err(invalid())}
        if !self.kimi_entries.lock().map_err(unavailable)?.is_empty(){return Err(unavailable(()))}
        self.zcode.clear_handles()?;
        let mut state=self.state.lock().map_err(unavailable)?;
        if !state.leases.is_empty(){return Err(unavailable(()))}
        state.credentials.clear();
        let handle=Uuid::new_v4().to_string();state.credentials.insert(handle.clone(),tokens);Ok(handle)
    }

    /// Native Keychain ingress. Public JS receives only the generated handle.
    pub fn register_kimi_credential(&self, api_key: String) -> Result<String> {
        if api_key.len() < 20 || api_key.len() > 4096
            || !api_key.starts_with("sk-")
            || !api_key.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)) {
            return Err(invalid());
        }
        if !self.kimi_entries.lock().map_err(unavailable)?.is_empty() { return Err(unavailable(())); }
        self.zcode.clear_handles()?;
        let mut state = self.state.lock().map_err(unavailable)?;
        if !state.leases.is_empty() { return Err(unavailable(())); }
        state.kimi_credentials.clear();
        let handle = Uuid::new_v4().to_string();
        state.kimi_credentials.insert(handle.clone(), Arc::from(api_key));
        Ok(handle)
    }

    /// AuthService invokes reset only after the active attempt has drained.
    /// Invalidate every process-local handle before admitting another account.
    pub fn clear_credentials(&self) -> Result<()> {
        if !self.kimi_entries.lock().map_err(unavailable)?.is_empty() { return Err(MobileTahError::Cleanup); }
        let mut state = self.state.lock().map_err(unavailable)?;
        if !state.leases.is_empty() { return Err(MobileTahError::Cleanup); }
        self.zcode.clear_handles()?;
        state.credentials.clear();
        state.kimi_credentials.clear();
        Ok(())
    }
}

impl MobileTahHost {
    fn kimi_credential(&self, handle: &str) -> Result<Arc<str>> {
        self.state.lock().map_err(unavailable)?.kimi_credentials.get(handle).cloned().ok_or_else(invalid)
    }

    async fn kimi_call(&self, method: &str, value: &Value) -> Result<Value> {
        match method {
            "provider.kimi.inspect" => return self.inspect_kimi(value).await,
            "provider.kimi.prepare" => return self.prepare_kimi(value).await,
            _ => {}
        }
        let handle = text(value, "handle")?;
        if method == "provider.kimi.start" { return self.start_kimi(handle).await; }
        if method == "provider.kimi.release" {
            let mut entries = self.kimi_entries.lock().map_err(unavailable)?;
            let entry = entries.get(handle).ok_or_else(invalid)?;
            if entry.starting { return Err(MobileTahError::Cleanup); }
            if let Some(scope) = &entry.scope {
                if !entry.closed { return Err(MobileTahError::Cleanup); }
                scope.dispose().map_err(|_| MobileTahError::Cleanup)?;
            }
            entries.remove(handle);
            return Ok(Value::Null);
        }
        if method == "provider.kimi.capture" {
            let scope = {
                let entries = self.kimi_entries.lock().map_err(unavailable)?;
                let entry = entries.get(handle).ok_or_else(invalid)?;
                if !entry.closed { return Err(MobileTahError::Cleanup); }
                if entry.scope.is_none() && entry.cancelled {
                    return Ok(json!({"scopeID":handle,"quiescent":true,"entries":[]}));
                }
                entry.scope.clone().ok_or_else(invalid)?
            };
            let snapshot = scope.capture().map_err(unavailable)?;
            let mut entries = Vec::new();
            for path in snapshot.directories {
                entries.push(json!({"relativePath":path,"kind":"directory","byteLength":null,"base64":null}));
            }
            for file in snapshot.files {
                entries.push(json!({"relativePath":file.relative_path,"kind":"file",
                    "byteLength":file.bytes.len(),"base64":STANDARD.encode(&file.bytes)}));
            }
            return Ok(json!({"scopeID":scope.layout().scope_id,"quiescent":true,"entries":entries}));
        }
        let backend = {
            let mut entries = self.kimi_entries.lock().map_err(unavailable)?;
            let entry = entries.get_mut(handle).ok_or_else(invalid)?;
            if method == "provider.kimi.cancel" { entry.cancelled = true; }
            entry.backend.clone()
        };
        if method == "provider.kimi.cancel" {
            if let Some(backend) = backend { backend.cancel().await.map_err(unavailable)?; }
            return Ok(Value::Null);
        }
        if backend.is_none() {
            let mut entries = self.kimi_entries.lock().map_err(unavailable)?;
            let entry = entries.get_mut(handle).ok_or_else(invalid)?;
            if entry.cancelled && !entry.starting && entry.scope.is_none() {
                if method == "provider.kimi.nextEvent" {
                    return Ok(json!({"done":true,"terminal":{"kind":"cancelled"}}));
                }
                if method == "provider.kimi.close" {
                    if let Some(prepared) = entry.prepared.take() {
                        prepared.dispose_before_start().map_err(|_| MobileTahError::Cleanup)?;
                    }
                    entry.closed = true;
                    return Ok(json!({"kind":"unstarted_guest","runtimeClosed":true,
                        "requestsJoined":true,"eventsRetained":true,"scopeQuiescent":true}));
                }
            }
        }
        let backend = backend.ok_or_else(invalid)?;
        match method {
            "provider.kimi.nextEvent" => backend.next_event().await.map_err(unavailable),
            "provider.kimi.close" => {
                let receipt = backend.close().await.map_err(|_| MobileTahError::Cleanup)?;
                if receipt["scopeQuiescent"] != true || receipt["requestsJoined"] != true
                    || receipt["runtimeClosed"] != true { return Err(MobileTahError::Cleanup); }
                self.kimi_entries.lock().map_err(unavailable)?.get_mut(handle).ok_or_else(invalid)?.closed = true;
                Ok(receipt)
            }
            _ => Err(invalid()),
        }
    }

    async fn prepare_kimi(&self, value: &Value) -> Result<Value> {
        let credential = text(value, "credentialHandle")?.to_owned();
        self.kimi_credential(&credential)?;
        let attempt = value.get("attempt").ok_or_else(invalid)?;
        if attempt["providerID"] != "kimi" || attempt["contractVersion"] != 1 { return Err(invalid()); }
        let prepared = self.prepared()?.factory.prepare(make_scope_spec(attempt, &value["inputFiles"])?).await.map_err(unavailable)?;
        let layout = prepared.layout();
        let handle = layout.scope_id.clone();
        let receipt = json!({"handle":handle,"workspaceRoot":layout.workspace_root,"scratchRoot":layout.scratch_root});
        self.kimi_entries.lock().map_err(unavailable)?.insert(handle, KimiEntry {
            prepared: Some(prepared), scope: None, backend: None, attempt: attempt.clone(), credential,
            starting: false, cancelled: false, closed: false,
        });
        Ok(receipt)
    }

    async fn start_kimi(&self, handle: &str) -> Result<Value> {
        let (scope, attempt, key) = {
            let mut entries = self.kimi_entries.lock().map_err(unavailable)?;
            let entry = entries.get_mut(handle).ok_or_else(invalid)?;
            if entry.starting || entry.backend.is_some() { return Err(invalid()); }
            if entry.cancelled { return Ok(Value::Null); }
            let scope = entry.prepared.take().ok_or_else(invalid)?.bind_guest().map_err(unavailable)?;
            let key = self.kimi_credential(&entry.credential)?;
            entry.scope = Some(scope.clone());
            entry.starting = true;
            (scope, entry.attempt.clone(), key)
        };
        let result = KimiBackend::start(scope.clone(), attempt, key).await;
        let cancel = {
            let mut entries = self.kimi_entries.lock().map_err(unavailable)?;
            let entry = entries.get_mut(handle).ok_or_else(invalid)?;
            entry.starting = false;
            match result {
                Ok(backend) => { entry.backend = Some(backend.clone()); Some((backend, entry.cancelled)) }
                Err(_) => { entry.closed = scope.is_quiescent(); None },
            }
        };
        let Some((backend, cancelled)) = cancel else { return Err(unavailable(())); };
        if cancelled { backend.cancel().await.map_err(unavailable)?; }
        Ok(Value::Null)
    }

    async fn inspect_kimi(&self, value: &Value) -> Result<Value> {
        let handle = text(value, "credentialHandle")?;
        let key = self.kimi_credential(handle)?;
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(30)).build().map_err(unavailable)?;
        let models = kimi_account_json(&client, "models", &key).await?;
        let Some(models) = models else {
            return Ok(json!({"state":"invalid","credentialHandle":null,"models":null,"usages":null}));
        };
        let usages = kimi_account_json(&client, "usages", &key).await.ok().flatten();
        // A replaced native handle cannot regain authority through a late reply.
        self.kimi_credential(handle)?;
        Ok(json!({"state":"valid","credentialHandle":handle,"models":models,"usages":usages}))
    }
}

async fn kimi_account_json(client: &reqwest::Client, route: &str, key: &str) -> Result<Option<Value>> {
    let mut response = client.get(format!("https://api.kimi.com/coding/v1/{route}"))
        .bearer_auth(key).header("User-Agent", "Alma-TAH/0.1")
        .send().await.map_err(unavailable)?;
    if matches!(response.status().as_u16(), 401 | 403) { return Ok(None); }
    if !response.status().is_success() { return Err(unavailable(())); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(unavailable)? {
        if bytes.len() + chunk.len() > 256 * 1024 { return Err(invalid()); }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map(Some).map_err(unavailable)
}

pub(crate) fn make_scope_spec(attempt: &Value, supplied: &Value) -> Result<ScopeSpec> {
    let id = Uuid::parse_str(text(attempt, "attemptID")?).map_err(unavailable)?;
    let workspace = attempt.get("workspace").ok_or_else(invalid)?;
    let mut files = BTreeMap::new();
    for file in supplied.as_array().ok_or_else(invalid)? {
        let path = text(file, "relativePath")?.to_owned();
        let bytes = STANDARD.decode(text(file, "base64")?).map_err(unavailable)?;
        if files.insert(path, bytes).is_some() { return Err(invalid()); }
    }
    let mut spec = ScopeSpec { scope_id:id, read_only_files:vec![], writable_files:vec![],
        writable_directories:vec![], writable_roots:serde_json::from_value(workspace["writableRoots"].clone()).map_err(unavailable)? };
    for (name, seed) in [("materials", false), ("candidateSeeds", true)] {
        for meta in workspace[name].as_array().ok_or_else(invalid)? {
            let path = text(meta, "relativePath")?.to_owned();
            if seed && meta["kind"] == "directory" { spec.writable_directories.push(path); continue; }
            let bytes = files.remove(&path).ok_or_else(invalid)?;
            let digest: [u8;32] = Sha256::digest(&bytes).into();
            if meta["byteLength"].as_u64() != Some(bytes.len() as u64)
                || text(meta, "sha256")? != format!("{:x}", Sha256::digest(&bytes)) { return Err(invalid()); }
            let file = ScopeFile { relative_path:path, bytes, sha256:digest };
            if seed { spec.writable_files.push(file); } else { spec.read_only_files.push(file); }
        }
    }
    if !files.is_empty() { return Err(invalid()); }
    Ok(spec)
}

impl MobileTahHost {
    async fn new_inner(bundle_fs:String,application_support:String)->Result<Arc<Self>>{
        if !crate::network_scope::alma_local() { return Err(unavailable(())); }
        let support=PathBuf::from(application_support);
        if !support.is_absolute(){return Err(invalid())}
        let state=Arc::new(Mutex::new(State{credentials:HashMap::new(),leases:HashMap::new(),kimi_credentials:HashMap::new()}));
        Ok(Arc::new(Self{runtime:tokio::sync::OnceCell::new(),bundle_fs:PathBuf::from(bundle_fs),support,state,
            code_mode:tokio::sync::OnceCell::new(),kimi_entries:Mutex::new(HashMap::new()),
            kimi_ready:tokio::sync::OnceCell::new(),zcode_ready:tokio::sync::OnceCell::new(),
            zcode:crate::mobile_zcode::ZCodeHost::new()}))
    }

    fn prepared(&self)->Result<&PreparedHost>{self.runtime.get().ok_or_else(||unavailable(()))}

    async fn prepare_provider(&self,provider:&str)->Result<()> {
        if !["codex","kimi","zcode"].contains(&provider){return Err(invalid())}
        let runtime=self.runtime.get_or_try_init(||async{
            let workspace=self.support.join("mobile-tah-runtime/workspace");
            let controllers=self.support.join("mobile-tah-runtime/controllers");
            std::fs::create_dir_all(&workspace).map_err(unavailable)?;
            std::fs::create_dir_all(&controllers).map_err(unavailable)?;
            let instance=crate::runtime_bootstrap::bootstrap_mobile_tah(&self.bundle_fs,&self.support,&workspace).map_err(unavailable)?;
            let factory=ProviderScopeFactory::new(instance,workspace.clone(),controllers).map_err(unavailable)?;
            let bridge=NativeProviderBridge::new(factory.clone()).with_native_request_handler(Arc::new(RefreshHandler{state:self.state.clone()}));
            Ok(PreparedHost{bridge,factory,workspace})
        }).await?;
        if provider=="kimi" {
            self.kimi_ready.get_or_try_init(||async{crate::kimi_assets::install(&self.bundle_fs,&runtime.workspace).map_err(unavailable)}).await?;
        }
        if provider=="zcode" {
            self.zcode_ready.get_or_try_init(||async{crate::zcode_native::install_assets(&self.bundle_fs,&runtime.workspace).map_err(unavailable)}).await?;
        }
        Ok(())
    }

    async fn call_inner(&self,method:String,payload:String)->Result<String>{
        if payload.len()>16*1024*1024{return Err(invalid())}
        let v:Value=serde_json::from_str(&payload).map_err(unavailable)?;
        if method=="runtime.prepareProvider" {
            self.prepare_provider(text(&v,"providerID")?).await?;
            return Ok("null".into());
        }
        if method.starts_with("provider.zcode.") || method.starts_with("auth.zcode.") {
            self.prepare_provider("zcode").await?;
            return self.zcode.call(&method,&v,&self.prepared()?.factory,&self.bundle_fs).await
                .and_then(|value|serde_json::to_string(&value).map_err(unavailable));
        }
        if method.starts_with("provider.codex."){self.prepare_provider("codex").await?;}
        if method.starts_with("provider.kimi.") {
            self.prepare_provider("kimi").await?;
            let result = self.kimi_call(&method, &v).await?;
            return serde_json::to_string(&result).map_err(unavailable);
        }
        let result=match method.as_str(){
            "provider.codex.prepare"=>self.prepare(&v).await?,
            "provider.codex.inspect"=>self.inspect(&v).await?,
            _=>{
                let h=text(&v,"handle")?;
                match method.as_str(){
                    "provider.codex.authBind"=>{self.change(h,Phase::Prepared,Phase::Bound)?;
                        if self.state.lock().map_err(unavailable)?.leases.get(h).ok_or_else(invalid)?.credential!=text(&v,"credentialHandle")?{return Err(invalid())}json!(null)},
                    "provider.codex.start"=>{self.start(h,v.get("profile").ok_or_else(invalid)?).await?;json!(null)},
                    "provider.codex.request"=>{
                        let m=text(&v,"method")?;
                        if !["initialize","account/read","account/rateLimits/read","model/list","thread/start","turn/start","turn/interrupt"].contains(&m){return Err(invalid())}
                        let phase=self.phase(h)?;
                        if m=="initialize"{if phase!=Phase::Started{return Err(invalid())}}
                        else if !matches!(phase,Phase::Authenticated|Phase::Sealed){return Err(invalid())}
                        if m=="turn/start"&&phase!=Phase::Sealed{return Err(invalid())}
                        self.prepared()?.bridge.request(h,m,v.get("params").cloned().unwrap_or(Value::Null)).await.map_err(unavailable)?
                    },
                    "provider.codex.notify"=>{
                        if text(&v,"method")?!="initialized"||self.phase(h)?!=Phase::Started{return Err(invalid())}
                        self.prepared()?.bridge.notify(h,"initialized",Value::Null).await.map_err(unavailable)?;
                        self.prepared()?.bridge.install_native_tokens(h,self.tokens(h)?).await.map_err(unavailable)?;
                        self.change(h,Phase::Started,Phase::Authenticated)?;json!(null)
                    },
                    "provider.codex.nextEvent"=>self.prepared()?.bridge.next_event(h).await.map_err(unavailable)?,
                    "provider.codex.authVerify"=>{if self.phase(h)?!=Phase::Authenticated{return Err(invalid())}self.tokens(h)?;json!(null)},
                    "provider.codex.authSeal"=>{self.change(h,Phase::Authenticated,Phase::Sealed)?;json!(null)},
                    "provider.codex.close"=>{
                        let receipt=self.prepared()?.bridge.close(h).await.map_err(|_|MobileTahError::Cleanup)?;
                        self.state.lock().map_err(unavailable)?.leases.get_mut(h).ok_or_else(invalid)?.phase=Phase::Closed;receipt
                    },
                    "provider.codex.authRelease"=>{
                        if !matches!(self.phase(h)?,Phase::Closed|Phase::Prepared|Phase::Bound){return Err(MobileTahError::Cleanup)}
                        let layout=self.prepared()?.bridge.layout(h).map_err(unavailable)?;
                        crate::provider_runtime_config::clear_native_tokens(&PathBuf::from(layout.controller_home)).map_err(|_|MobileTahError::Cleanup)?;
                        json!(null)
                    },
                    "provider.codex.capture"=>{if self.phase(h)?!=Phase::Closed{return Err(MobileTahError::Cleanup)}self.prepared()?.bridge.capture(h).map_err(unavailable)?},
                    "provider.codex.release"=>{self.prepared()?.bridge.release(h).map_err(|_|MobileTahError::Cleanup)?;self.state.lock().map_err(unavailable)?.leases.remove(h);json!(null)},
                    _=>return Err(invalid()),
                }
            }
        };
        serde_json::to_string(&result).map_err(unavailable)
    }
}

impl MobileTahHost {
    fn phase(&self,h:&str)->Result<Phase>{self.state.lock().map_err(unavailable)?.leases.get(h).map(|l|l.phase).ok_or_else(invalid)}
    fn change(&self,h:&str,from:Phase,to:Phase)->Result<()>{let mut state=self.state.lock().map_err(unavailable)?;let lease=state.leases.get_mut(h).ok_or_else(invalid)?;if lease.phase!=from{return Err(invalid())}lease.phase=to;Ok(())}
    fn tokens(&self,h:&str)->Result<ChatgptAuthRefreshTokens>{let state=self.state.lock().map_err(unavailable)?;let l=state.leases.get(h).ok_or_else(invalid)?;let t=state.credentials.get(&l.credential).ok_or_else(invalid)?;if t.account_id!=l.account_id{return Err(invalid())}Ok(t.clone())}

    async fn prepare(&self,v:&Value)->Result<Value>{
        let credential=text(v,"credentialHandle")?.to_owned();
        let account=self.state.lock().map_err(unavailable)?.credentials.get(&credential).ok_or_else(invalid)?.account_id.clone();
        let attempt=v.get("attempt").ok_or_else(invalid)?;
        if attempt["providerID"]!="codex"||attempt["contractVersion"]!=1{return Err(invalid())}
        let result=self.prepared()?.bridge.prepare(make_scope_spec(attempt, &v["inputFiles"])?).await.map_err(unavailable)?;let handle=text(&result,"handle")?.to_owned();
        self.state.lock().map_err(unavailable)?.leases.insert(handle,Lease{credential,account_id:account,phase:Phase::Prepared,expected:Some(attempt.clone())});
        Ok(result)
    }

    async fn start(&self,h:&str,profile:&Value)->Result<()>{
        if self.phase(h)?!=Phase::Bound{return Err(invalid())}
        let layout=self.prepared()?.bridge.layout(h).map_err(unavailable)?;
        let expected=self.state.lock().map_err(unavailable)?.leases.get(h).ok_or_else(invalid)?.expected.clone();
        let web=profile["threadConfig"]["web_search"]=="live";
        if let Some(a)=expected{
            if a["inference"]["modelID"]!=profile["modelID"]||a["inference"]["reasoningEffortID"]!=profile["reasoningEffortID"]
                || web!=a["requiredAbilities"].as_array().ok_or_else(invalid)?.iter().any(|v|v=="web"){return Err(invalid())}
        }
        let mut overrides:BTreeMap<String,TomlValue>=crate::alma_local_profile::alma_local_cli_overrides(web).into_iter().collect();
        for (k,v)in profile["threadConfig"].as_object().ok_or_else(invalid)?{
            if k=="features"{for(k,v)in v.as_object().ok_or_else(invalid)?{overrides.insert(format!("features.{k}"),serde_json::from_value(v.clone()).map_err(unavailable)?);}}
            else{overrides.insert(k.clone(),serde_json::from_value(v.clone()).map_err(unavailable)?);}
        }
        overrides.insert("model".into(),text(profile,"modelID")?.into());
        overrides.insert("approval_policy".into(),"never".into());
        let prepared=PreparedRuntimeConfig::load(PathBuf::from(layout.controller_home),PathBuf::from(layout.workspace_root),overrides.into_iter().collect(),web,&self.tokens(h)?).await.map_err(unavailable)?;
        self.prepared()?.bridge.start(h,text(profile,"permissionProfileID")?.into(),prepared,self.code_mode.get_or_try_init(|| async { crate::alma_code_mode::IosCodeModeProbeProvider::initialize().map_err(unavailable) }).await?.clone()).await.map_err(unavailable)?;
        self.change(h,Phase::Bound,Phase::Started)
    }

    async fn inspect(&self,v:&Value)->Result<Value>{
        let credential=text(v,"credentialHandle")?.to_owned();
        let account=self.state.lock().map_err(unavailable)?.credentials.get(&credential).ok_or_else(invalid)?.account_id.clone();
        let id=Uuid::new_v4();
        let result=self.prepared()?.bridge.prepare(ScopeSpec{scope_id:id,read_only_files:vec![],writable_files:vec![],writable_directories:vec![],writable_roots:vec![]}).await.map_err(unavailable)?;
        let h=text(&result,"handle")?.to_owned();
        self.state.lock().map_err(unavailable)?.leases.insert(h.clone(),Lease{credential:credential.clone(),account_id:account,phase:Phase::Bound,expected:None});
        let layout=self.prepared()?.bridge.layout(&h).map_err(unavailable)?;
        let profile=json!({"permissionProfileID":"alma-tah-guardian","modelID":"gpt-5.6-luna","reasoningEffortID":"low","threadConfig":{
            "default_permissions":"alma-tah-guardian","permissions":{"alma-tah-guardian":{"filesystem":layout.filesystem,"network":{"enabled":false}}},
            "shell_environment_policy":{"inherit":"none","ignore_default_excludes":false,"set":layout.shell_environment},"web_search":"disabled","model_reasoning_effort":"low"}});
        self.start(&h,&profile).await?;
        let rpc=async{
            let initialize=self.prepared()?.bridge.request(&h,"initialize",json!({"clientInfo":{"name":"@alma/tah-codex-guest","title":"ALMA TAH Codex Guest","version":"1.0.0"},"capabilities":{"experimentalApi":true,"requestAttestation":false}})).await.map_err(unavailable)?;
            self.prepared()?.bridge.notify(&h,"initialized",Value::Null).await.map_err(unavailable)?;
            self.prepared()?.bridge.install_native_tokens(&h,self.tokens(&h)?).await.map_err(unavailable)?;
            self.change(&h,Phase::Started,Phase::Authenticated)?;
            let account=self.prepared()?.bridge.request(&h,"account/read",json!({"refreshToken":false})).await.map_err(unavailable)?;
            let mut pages=vec![];let mut cursor=None;
            for _ in 0..16{let mut params=json!({"includeHidden":false,"limit":64});if let Some(c)=cursor{params["cursor"]=c;}
                let page=self.prepared()?.bridge.request(&h,"model/list",params).await.map_err(unavailable)?;let value=page.get("value").ok_or_else(invalid)?.clone();cursor=value.get("nextCursor").filter(|v|!v.is_null()).cloned();pages.push(value);if cursor.is_none(){break}}
            if cursor.is_some(){return Err(invalid())}
            let quota=self.prepared()?.bridge.request(&h,"account/rateLimits/read",json!({})).await.map_err(unavailable)?;
            Ok::<_,MobileTahError>(json!({"initialize":initialize.get("value").ok_or_else(invalid)?,"controllerHome":layout.controller_home,"account":account.get("value").ok_or_else(invalid)?,"modelPages":pages,"quota":quota.get("value").ok_or_else(invalid)?,"credentialHandle":credential}))
        }.await;
        let close=self.prepared()?.bridge.close(&h).await.map_err(|_|MobileTahError::Cleanup)?;
        while self.prepared()?.bridge.next_event(&h).await.map_err(unavailable)?["done"]!=true {}
        self.state.lock().map_err(unavailable)?.leases.get_mut(&h).ok_or_else(invalid)?.phase=Phase::Closed;
        crate::provider_runtime_config::clear_native_tokens(&PathBuf::from(layout.controller_home)).map_err(|_|MobileTahError::Cleanup)?;
        self.prepared()?.bridge.release(&h).map_err(|_|MobileTahError::Cleanup)?;self.state.lock().map_err(unavailable)?.leases.remove(&h);
        let mut answer=rpc?;answer["closed"]=close;Ok(answer)
    }
}
