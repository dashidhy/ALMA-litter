//! App-owned ZCode composition. Secrets cross only the native Keychain callback.
use crate::mobile_tah_host::{MobileTahError, Result, invalid, make_scope_spec, text, unavailable};
use crate::provider_scope::{GuestRuntime, GuestScope, PreparedScope, ProviderScopeFactory};
use crate::zcode_native::{ModelAuthorization, ZCodeBackend, auth::*};
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
};
use tokio::sync::{Notify, OnceCell};
use uuid::Uuid;

#[uniffi::export(callback_interface)]
pub trait ZCodeCredentialStore: Send + Sync {
    fn load(&self) -> Result<String>;
    fn compare_exchange(&self, expected_revision: String, account_json: String) -> Result<String>;
}
struct KeychainStore(Arc<dyn ZCodeCredentialStore>);
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredSnapshot {
    revision: String,
    account: Option<StoredAccount>,
}
fn snapshot(json: String) -> AuthResult<CredentialSnapshot> {
    if json.len() > 64 * 1024 {
        return Err(AuthError::Store);
    }
    let value: StoredSnapshot = serde_json::from_str(&json).map_err(|_| AuthError::Store)?;
    if value.revision.is_empty() || value.revision.len() > 128 {
        return Err(AuthError::Store);
    }
    Ok(CredentialSnapshot {
        revision: value.revision,
        account: value.account,
    })
}
#[async_trait]
impl CredentialStore for KeychainStore {
    async fn load(&self) -> AuthResult<CredentialSnapshot> {
        snapshot(self.0.load().map_err(|_| AuthError::Store)?)
    }
    async fn compare_exchange(
        &self,
        revision: &str,
        next: Option<StoredAccount>,
    ) -> AuthResult<CredentialSnapshot> {
        let json = serde_json::to_string(&next).map_err(|_| AuthError::Store)?;
        snapshot(
            self.0
                .compare_exchange(revision.into(), json)
                .map_err(|_| AuthError::Store)?,
        )
    }
}
struct EntryState {
    prepared: Option<PreparedScope>,
    scope: Option<Arc<GuestScope>>,
    backend: Option<Arc<ZCodeBackend>>,
    starting: bool,
    closed: bool,
    released: bool,
}
struct Entry {
    attempt: Value,
    authorization: Arc<dyn ModelAuthorization>,
    state: Mutex<EntryState>,
    changed: Notify,
}
pub(crate) struct ZCodeHost {
    store: OnceLock<Arc<dyn ZCodeCredentialStore>>,
    auth: OnceCell<Arc<BigModelAuthOwner>>,
    handle: Mutex<Option<(String, Arc<BoundAuthorization>)>>,
    entries: Mutex<HashMap<String, Arc<Entry>>>,
    catalog: OnceCell<Value>,
}
impl ZCodeHost {
    pub(crate) fn new() -> Self {
        Self {
            store: OnceLock::new(),
            auth: OnceCell::new(),
            handle: Mutex::new(None),
            entries: Mutex::new(HashMap::new()),
            catalog: OnceCell::new(),
        }
    }
    pub(crate) fn configure_store(&self, store: Arc<dyn ZCodeCredentialStore>) -> Result<()> {
        self.store.set(store).map_err(unavailable)
    }
    pub(crate) fn clear_handles(&self) -> Result<()> {
        let mut handle = self.handle.lock().map_err(unavailable)?;
        if !self.entries.lock().map_err(unavailable)?.is_empty() {
            return Err(MobileTahError::Cleanup);
        }
        *handle = None;
        Ok(())
    }
    async fn owner(&self) -> Result<&Arc<BigModelAuthOwner>> {
        self.auth
            .get_or_try_init(|| async {
                let store = self.store.get().cloned().ok_or_else(invalid)?;
                let owner = BigModelAuthOwner::new(
                    Arc::new(ReqwestAuthHttp::new().map_err(unavailable)?),
                    Arc::new(KeychainStore(store)),
                    Arc::new(SystemClock),
                );
                owner.restore().await.map_err(unavailable)?;
                Ok(owner)
            })
            .await
    }
    async fn catalog(&self, bundle: &Path) -> Result<&Value> {
        self.catalog
            .get_or_try_init(|| async {
                let path = bundle
                    .parent()
                    .ok_or_else(invalid)?
                    .join("zcode-runtime/catalog.json");
                let bytes = std::fs::read(path).map_err(unavailable)?;
                if bytes.len() > 256 * 1024 {
                    return Err(invalid());
                }
                let value: Value = serde_json::from_slice(&bytes).map_err(unavailable)?;
                if value["providerID"] != "zcode"
                    || value["models"]
                        .as_array()
                        .is_none_or(|a| a.is_empty() || a.len() > 64)
                {
                    return Err(invalid());
                }
                Ok(value)
            })
            .await
    }
    fn authorization(&self, value: &Value) -> Result<Arc<BoundAuthorization>> {
        let handle = text(value, "credentialHandle")?;
        let current = self.handle.lock().map_err(unavailable)?;
        match current.as_ref() {
            Some((id, bound)) if id == handle => Ok(bound.clone()),
            _ => Err(invalid()),
        }
    }
    fn validate_handle(&self, value: &Value) -> Result<()> {
        self.authorization(value).map(|_| ())
    }
    pub(crate) async fn call(
        &self,
        method: &str,
        value: &Value,
        factory: &ProviderScopeFactory,
        bundle: &Path,
    ) -> Result<Value> {
        let owner = self.owner().await?;
        match method {
            "auth.zcode.restore" => {
                let inspection = owner.inspect().await.map_err(unavailable)?;
                if !inspection.connected || inspection.login_pending {
                    return Err(unavailable(()));
                }
                let bound = Arc::new(owner.authorization().await.map_err(unavailable)?);
                let mut handle = self.handle.lock().map_err(unavailable)?;
                let (id, _) = handle.get_or_insert_with(|| (Uuid::new_v4().to_string(), bound));
                Ok(json!({"credentialHandle":id}))
            }
            "auth.zcode.begin" => {
                self.clear_handles()?;
                let challenge = owner.begin_login().await.map_err(unavailable)?;
                Ok(
                    json!({"id":challenge.id,"authorizeURL":challenge.authorize_url,"expiresAtMs":challenge.expires_at_ms,"pollIntervalMs":challenge.poll_interval_ms}),
                )
            }
            "auth.zcode.poll" => {
                match owner
                    .poll_login(value["id"].as_u64().ok_or_else(invalid)?)
                    .await
                    .map_err(unavailable)?
                {
                    LoginProgress::Pending { retry_after_ms } => {
                        Ok(json!({"ready":false,"retryAfterMs":retry_after_ms}))
                    }
                    LoginProgress::Ready => {
                        self.clear_handles()?;
                        Ok(json!({"ready":true}))
                    }
                }
            }
            "auth.zcode.cancel" => {
                owner
                    .cancel_login(value["id"].as_u64().ok_or_else(invalid)?)
                    .await;
                Ok(Value::Null)
            }
            "auth.zcode.logout" => {
                self.clear_handles()?;
                owner.logout().await.map_err(unavailable)?;
                Ok(Value::Null)
            }
            "provider.zcode.inspect" => {
                self.validate_handle(value)?;
                let inspection = owner.inspect().await.map_err(unavailable)?;
                self.validate_handle(value)?;
                if !inspection.connected {
                    return Ok(
                        json!({"state":"invalid","credentialHandle":null,"account":null,"models":[],"defaultModelHandle":null}),
                    );
                }
                // Inspection validates the current Coding Plan authorization
                // through the native single-flight PAT owner, without a model
                // request or SDK startup. The token never enters the receipt.
                let validation = self.authorization(value)?.validate().await;
                self.validate_handle(value)?;
                match validation {
                    Ok(()) => {}
                    Err(
                        AuthError::LoginRequired
                        | AuthError::LoginFailed
                        | AuthError::Disabled
                        | AuthError::ProjectUnavailable
                        | AuthError::ScopeInvalidated
                        | AuthError::Http(401 | 403),
                    ) => {
                        return Ok(json!({"state":"invalid","credentialHandle":null,
                            "account":null,"models":[],"defaultModelHandle":null}));
                    }
                    Err(error) => return Err(unavailable(error)),
                }
                let catalog = self.catalog(bundle).await?;
                // TAH 的原有准入包含真实余额检查。这里只返回官方原始 quota，
                // 由 Provider Adapter 映射，不能拿“登录成功”伪造无限额度。
                let usage_quota = match self.authorization(value)?.usage_quota().await {
                    Ok(quota) => Some(quota),
                    Err(
                        AuthError::ScopeInvalidated | AuthError::Closed | AuthError::LoginRequired,
                    ) => {
                        return Err(unavailable(()));
                    }
                    Err(_) => None,
                };
                self.validate_handle(value)?;
                Ok(
                    json!({"state":"valid","credentialHandle":value["credentialHandle"],"account":inspection.account_id.unwrap_or_else(||"BigModel Coding Plan".into()),"models":catalog["models"],"defaultModelHandle":catalog["defaultModelHandle"],"usageQuota":usage_quota}),
                )
            }
            "provider.zcode.prepare" => {
                self.validate_handle(value)?;
                let attempt = &value["attempt"];
                if attempt["providerID"] != "zcode" || attempt["contractVersion"] != 1 {
                    return Err(invalid());
                }
                let authorization = self.authorization(value)?;
                let prepared = factory
                    .prepare(make_scope_spec(attempt, &value["inputFiles"])?)
                    .await
                    .map_err(unavailable)?;
                // Admission and account revocation use the same lock order.
                // A prepare that crossed a login replacement disposes its scope.
                let current = self.handle.lock().map_err(unavailable)?;
                if current.as_ref().map(|(id, _)| id.as_str()) != value["credentialHandle"].as_str()
                {
                    prepared
                        .dispose_before_start()
                        .map_err(|_| MobileTahError::Cleanup)?;
                    return Err(invalid());
                }
                let handle = prepared.layout().scope_id.clone();
                self.entries.lock().map_err(unavailable)?.insert(
                    handle.clone(),
                    Arc::new(Entry {
                        attempt: attempt.clone(),
                        authorization,
                        state: Mutex::new(EntryState {
                            prepared: Some(prepared),
                            scope: None,
                            backend: None,
                            starting: false,
                            closed: false,
                            released: false,
                        }),
                        changed: Notify::new(),
                    }),
                );
                Ok(json!({"handle":handle}))
            }
            _ => self.scope_call(method, value, bundle).await,
        }
    }
    async fn scope_call(&self, method: &str, value: &Value, bundle: &Path) -> Result<Value> {
        let handle = text(value, "handle")?;
        let entry = self
            .entries
            .lock()
            .map_err(unavailable)?
            .get(handle)
            .cloned();
        let Some(entry) = entry else {
            return if method == "provider.zcode.release" {
                Ok(Value::Null)
            } else {
                Err(invalid())
            };
        };
        if method == "provider.zcode.start" {
            let request = &value["request"];
            let inference = &entry.attempt["inference"];
            let catalog = self.catalog(bundle).await?;
            let model = catalog["models"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .find(|m| m["handle"] == inference["modelID"])
                .ok_or_else(invalid)?;
            let effort = &inference["reasoningEffortID"];
            if !effort.is_null()
                && !model["efforts"]
                    .as_array()
                    .ok_or_else(invalid)?
                    .iter()
                    .any(|e| &e["handle"] == effort)
            {
                return Err(invalid());
            }
            let role = if entry.attempt["role"] == "actor" {
                "actor"
            } else {
                "guardian"
            };
            let web = entry.attempt["requiredAbilities"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .any(|v| v == "web");
            if request["role"] != role
                || request["web"] != web
                || request["selection"]["providerId"] != model["selection"]["providerId"]
                || request["selection"]["modelId"] != model["selection"]["modelId"]
                || &request["selection"]["options"]["reasoningLevel"] != effort
            {
                return Err(invalid());
            }
            let scope = {
                let mut state = entry.state.lock().map_err(unavailable)?;
                if state.starting || state.scope.is_some() || state.closed || state.released {
                    return Err(invalid());
                }
                let scope = state
                    .prepared
                    .take()
                    .ok_or_else(invalid)?
                    .bind_guest_runtime(GuestRuntime::ZCode)
                    .map_err(unavailable)?;
                state.scope = Some(scope.clone());
                state.starting = true;
                scope
            };
            let result = ZCodeBackend::start(
                scope.clone(),
                text(&entry.attempt, "attemptID")?.into(),
                request.clone(),
                entry.authorization.clone(),
            )
            .await;
            let mut state = entry.state.lock().map_err(unavailable)?;
            state.starting = false;
            let result = match result {
                Ok(backend) => {
                    state.backend = Some(backend);
                    Ok(Value::Null)
                }
                Err(error) => {
                    state.closed = scope.is_quiescent();
                    Err(unavailable(error))
                }
            };
            drop(state);
            entry.changed.notify_waiters();
            return result;
        }
        loop {
            let changed = entry.changed.notified();
            if !entry.state.lock().map_err(unavailable)?.starting {
                break;
            }
            changed.await;
        }
        let backend = entry.state.lock().map_err(unavailable)?.backend.clone();
        match method {
            "provider.zcode.nextEvent" => backend
                .ok_or_else(invalid)?
                .next_event()
                .await
                .map_err(unavailable),
            "provider.zcode.cancel" => {
                if let Some(backend) = backend {
                    backend
                        .cancel()
                        .await
                        .map_err(|_| MobileTahError::Cleanup)?;
                }
                Ok(Value::Null)
            }
            "provider.zcode.close" => {
                let receipt = if let Some(backend) = backend {
                    backend.close().await.map_err(|_| MobileTahError::Cleanup)?
                } else {
                    let mut state = entry.state.lock().map_err(unavailable)?;
                    if state.scope.as_ref().is_some_and(|s| !s.is_quiescent()) {
                        return Err(MobileTahError::Cleanup);
                    }
                    if let Some(prepared) = state.prepared.take() {
                        prepared
                            .dispose_before_start()
                            .map_err(|_| MobileTahError::Cleanup)?
                    }
                    json!({"runtimeClosed":true,"requestsJoined":true,"eventsRetained":true,"scopeQuiescent":true,"terminal":{"outcome":{"kind":"cancelled"},"sessionId":null,"response":"","sdkClosed":true}})
                };
                entry.state.lock().map_err(unavailable)?.closed = true;
                Ok(receipt)
            }
            "provider.zcode.capture" => {
                let scope = {
                    let state = entry.state.lock().map_err(unavailable)?;
                    if !state.closed {
                        return Err(invalid());
                    }
                    state.scope.clone().ok_or_else(invalid)?
                };
                let captured = scope.capture().map_err(unavailable)?;
                let mut entries:Vec<Value>=captured.directories.into_iter().map(|relative_path|json!({"relativePath":relative_path,"kind":"directory","byteLength":null,"base64":null})).collect();
                entries.extend(captured.files.into_iter().map(|f|json!({"relativePath":f.relative_path,"kind":"file","byteLength":f.bytes.len(),"base64":STANDARD.encode(f.bytes)})));
                Ok(json!({"scopeID":handle,"quiescent":true,"entries":entries}))
            }
            "provider.zcode.release" => {
                let mut state = entry.state.lock().map_err(unavailable)?;
                if state.released {
                    return Ok(Value::Null);
                }
                if state.scope.is_some() && !state.closed {
                    return Err(MobileTahError::Cleanup);
                }
                if let Some(scope) = &state.scope {
                    scope.dispose().map_err(|_| MobileTahError::Cleanup)?
                }
                if let Some(prepared) = state.prepared.take() {
                    prepared
                        .dispose_before_start()
                        .map_err(|_| MobileTahError::Cleanup)?
                }
                state.released = true;
                drop(state);
                self.entries.lock().map_err(unavailable)?.remove(handle);
                Ok(Value::Null)
            }
            _ => Err(invalid()),
        }
    }
}
