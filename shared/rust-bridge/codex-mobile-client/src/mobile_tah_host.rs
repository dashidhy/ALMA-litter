//! Trusted mobile composition boundary. The JS Framework owns all TAH decisions;
//! this host materializes declared bytes, binds native auth and routes the Adapter
//! to its backend. No model tokens, secrets or desktop control process enter JS.
use crate::auth_refresh::ChatgptAuthRefreshTokens;
use crate::provider_bridge::{NativeProviderBridge, NativeServerRequestHandler};
use crate::provider_runtime_config::PreparedRuntimeConfig;
use crate::provider_scope::{ProviderScopeFactory, ScopeFile, ScopeSpec};
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
type Result<T> = std::result::Result<T, MobileTahError>;
fn invalid() -> MobileTahError { MobileTahError::InvalidRequest }
fn unavailable<E>(_:E)->MobileTahError{MobileTahError::Unavailable}
fn text<'a>(v:&'a Value,k:&str)->Result<&'a str>{v.get(k).and_then(Value::as_str).ok_or_else(invalid)}

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
struct State { credentials:HashMap<String,ChatgptAuthRefreshTokens>, leases:HashMap<String,Lease> }

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
    bridge:NativeProviderBridge,
    state:Arc<Mutex<State>>,
    code_mode:Arc<dyn codex_code_mode_protocol::CodeModeSessionProvider>,
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

    /// Called only by native Keychain plumbing. No token-bearing JSON method exists.
    pub fn register_credential(&self,tokens:ChatgptAuthRefreshTokens)->Result<String>{
        if tokens.access_token.is_empty()||tokens.account_id.is_empty(){return Err(invalid())}
        let mut state=self.state.lock().map_err(unavailable)?;
        if !state.leases.is_empty(){return Err(unavailable(()))}
        state.credentials.clear();
        let handle=Uuid::new_v4().to_string();state.credentials.insert(handle.clone(),tokens);Ok(handle)
    }
}

impl MobileTahHost {
    async fn new_inner(bundle_fs:String,application_support:String)->Result<Arc<Self>>{
        let support=PathBuf::from(application_support);
        if !support.is_absolute(){return Err(invalid())}
        let workspace=support.join("mobile-tah-runtime/workspace");let controllers=support.join("mobile-tah-runtime/controllers");
        std::fs::create_dir_all(&workspace).map_err(unavailable)?;std::fs::create_dir_all(&controllers).map_err(unavailable)?;
        let instance=crate::ish_runtime::bootstrap_mobile_tah(&PathBuf::from(bundle_fs),&support,&workspace).map_err(unavailable)?;
        let factory=ProviderScopeFactory::new(instance,workspace,controllers).map_err(unavailable)?;
        let state=Arc::new(Mutex::new(State{credentials:HashMap::new(),leases:HashMap::new()}));
        let bridge=NativeProviderBridge::new(factory).with_native_request_handler(Arc::new(RefreshHandler{state:state.clone()}));
        let code_mode=crate::alma_code_mode::IosCodeModeProbeProvider::initialize().map_err(unavailable)?;
        Ok(Arc::new(Self{bridge,state,code_mode}))
    }

    async fn call_inner(&self,method:String,payload:String)->Result<String>{
        if payload.len()>16*1024*1024{return Err(invalid())}
        let v:Value=serde_json::from_str(&payload).map_err(unavailable)?;
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
                        self.bridge.request(h,m,v.get("params").cloned().unwrap_or(Value::Null)).await.map_err(unavailable)?
                    },
                    "provider.codex.notify"=>{
                        if text(&v,"method")?!="initialized"||self.phase(h)?!=Phase::Started{return Err(invalid())}
                        self.bridge.notify(h,"initialized",Value::Null).await.map_err(unavailable)?;
                        self.bridge.install_native_tokens(h,self.tokens(h)?).await.map_err(unavailable)?;
                        self.change(h,Phase::Started,Phase::Authenticated)?;json!(null)
                    },
                    "provider.codex.nextEvent"=>self.bridge.next_event(h).await.map_err(unavailable)?,
                    "provider.codex.authVerify"=>{if self.phase(h)?!=Phase::Authenticated{return Err(invalid())}self.tokens(h)?;json!(null)},
                    "provider.codex.authSeal"=>{self.change(h,Phase::Authenticated,Phase::Sealed)?;json!(null)},
                    "provider.codex.close"=>{
                        let receipt=self.bridge.close(h).await.map_err(|_|MobileTahError::Cleanup)?;
                        self.state.lock().map_err(unavailable)?.leases.get_mut(h).ok_or_else(invalid)?.phase=Phase::Closed;receipt
                    },
                    "provider.codex.authRelease"=>{
                        if !matches!(self.phase(h)?,Phase::Closed|Phase::Prepared|Phase::Bound){return Err(MobileTahError::Cleanup)}
                        let layout=self.bridge.layout(h).map_err(unavailable)?;
                        crate::provider_runtime_config::clear_native_tokens(&PathBuf::from(layout.controller_home)).map_err(|_|MobileTahError::Cleanup)?;
                        json!(null)
                    },
                    "provider.codex.capture"=>{if self.phase(h)?!=Phase::Closed{return Err(MobileTahError::Cleanup)}self.bridge.capture(h).map_err(unavailable)?},
                    "provider.codex.release"=>{self.bridge.release(h).map_err(|_|MobileTahError::Cleanup)?;self.state.lock().map_err(unavailable)?.leases.remove(h);json!(null)},
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
        let id=Uuid::parse_str(text(attempt,"attemptID")?).map_err(unavailable)?;
        let workspace=attempt.get("workspace").ok_or_else(invalid)?;
        let supplied=v["inputFiles"].as_array().ok_or_else(invalid)?;
        let mut files=BTreeMap::new();
        for file in supplied{let path=text(file,"relativePath")?.to_owned();let data=STANDARD.decode(text(file,"base64")?).map_err(unavailable)?;if files.insert(path,data).is_some(){return Err(invalid())}}
        let mut spec=ScopeSpec{scope_id:id,read_only_files:vec![],writable_files:vec![],writable_directories:vec![],writable_roots:serde_json::from_value(workspace["writableRoots"].clone()).map_err(unavailable)?};
        for (key,seed) in [("materials",false),("candidateSeeds",true)]{
            for meta in workspace[key].as_array().ok_or_else(invalid)?{
                let path=text(meta,"relativePath")?.to_owned();
                if seed&&meta["kind"]=="directory"{spec.writable_directories.push(path);continue}
                let bytes=files.remove(&path).ok_or_else(invalid)?;let digest:[u8;32]=Sha256::digest(&bytes).into();
                if meta["byteLength"].as_u64()!=Some(bytes.len()as u64)||text(meta,"sha256")?!=format!("{:x}",Sha256::digest(&bytes)){return Err(invalid())}
                let file=ScopeFile{relative_path:path,bytes,sha256:digest};if seed{spec.writable_files.push(file)}else{spec.read_only_files.push(file)}
            }
        }
        if !files.is_empty(){return Err(invalid())}
        let result=self.bridge.prepare(spec).await.map_err(unavailable)?;let handle=text(&result,"handle")?.to_owned();
        self.state.lock().map_err(unavailable)?.leases.insert(handle,Lease{credential,account_id:account,phase:Phase::Prepared,expected:Some(attempt.clone())});
        Ok(result)
    }

    async fn start(&self,h:&str,profile:&Value)->Result<()>{
        if self.phase(h)?!=Phase::Bound{return Err(invalid())}
        let layout=self.bridge.layout(h).map_err(unavailable)?;
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
        self.bridge.start(h,text(profile,"permissionProfileID")?.into(),prepared,self.code_mode.clone()).await.map_err(unavailable)?;
        self.change(h,Phase::Bound,Phase::Started)
    }

    async fn inspect(&self,v:&Value)->Result<Value>{
        let credential=text(v,"credentialHandle")?.to_owned();
        let account=self.state.lock().map_err(unavailable)?.credentials.get(&credential).ok_or_else(invalid)?.account_id.clone();
        let id=Uuid::new_v4();
        let result=self.bridge.prepare(ScopeSpec{scope_id:id,read_only_files:vec![],writable_files:vec![],writable_directories:vec![],writable_roots:vec![]}).await.map_err(unavailable)?;
        let h=text(&result,"handle")?.to_owned();
        self.state.lock().map_err(unavailable)?.leases.insert(h.clone(),Lease{credential:credential.clone(),account_id:account,phase:Phase::Bound,expected:None});
        let layout=self.bridge.layout(&h).map_err(unavailable)?;
        let profile=json!({"permissionProfileID":"alma-tah-guardian","modelID":"gpt-5.6-luna","reasoningEffortID":"low","threadConfig":{
            "default_permissions":"alma-tah-guardian","permissions":{"alma-tah-guardian":{"filesystem":layout.filesystem,"network":{"enabled":false}}},
            "shell_environment_policy":{"inherit":"none","ignore_default_excludes":false,"set":layout.shell_environment},"web_search":"disabled","model_reasoning_effort":"low"}});
        self.start(&h,&profile).await?;
        let rpc=async{
            let initialize=self.bridge.request(&h,"initialize",json!({"clientInfo":{"name":"@alma/tah-codex-guest","title":"ALMA TAH Codex Guest","version":"1.0.0"},"capabilities":{"experimentalApi":true,"requestAttestation":false}})).await.map_err(unavailable)?;
            self.bridge.notify(&h,"initialized",Value::Null).await.map_err(unavailable)?;
            self.bridge.install_native_tokens(&h,self.tokens(&h)?).await.map_err(unavailable)?;
            self.change(&h,Phase::Started,Phase::Authenticated)?;
            let account=self.bridge.request(&h,"account/read",json!({"refreshToken":false})).await.map_err(unavailable)?;
            let mut pages=vec![];let mut cursor=None;
            for _ in 0..16{let mut params=json!({"includeHidden":false,"limit":64});if let Some(c)=cursor{params["cursor"]=c;}
                let page=self.bridge.request(&h,"model/list",params).await.map_err(unavailable)?;let value=page.get("value").ok_or_else(invalid)?.clone();cursor=value.get("nextCursor").filter(|v|!v.is_null()).cloned();pages.push(value);if cursor.is_none(){break}}
            if cursor.is_some(){return Err(invalid())}
            let quota=self.bridge.request(&h,"account/rateLimits/read",json!({})).await.map_err(unavailable)?;
            Ok::<_,MobileTahError>(json!({"initialize":initialize.get("value").ok_or_else(invalid)?,"controllerHome":layout.controller_home,"account":account.get("value").ok_or_else(invalid)?,"modelPages":pages,"quota":quota.get("value").ok_or_else(invalid)?,"credentialHandle":credential}))
        }.await;
        let close=self.bridge.close(&h).await.map_err(|_|MobileTahError::Cleanup)?;
        while self.bridge.next_event(&h).await.map_err(unavailable)?["done"]!=true {}
        self.state.lock().map_err(unavailable)?.leases.get_mut(&h).ok_or_else(invalid)?.phase=Phase::Closed;
        crate::provider_runtime_config::clear_native_tokens(&PathBuf::from(layout.controller_home)).map_err(|_|MobileTahError::Cleanup)?;
        self.bridge.release(&h).map_err(|_|MobileTahError::Cleanup)?;self.state.lock().map_err(unavailable)?.leases.remove(&h);
        let mut answer=rpc?;answer["closed"]=close;Ok(answer)
    }
}
