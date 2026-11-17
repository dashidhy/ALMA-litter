//! Persistent native guest sessions. One process per operation, one durable SDK session.
use super::*;
use crate::provider_scope::{GuestRuntime};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone)]
enum Backend {
    Kimi(Arc<crate::kimi_backend::KimiBackend>),
    Zcode(Arc<crate::zcode_native::ZCodeBackend>),
}
impl Backend {
    async fn next(&self) -> Result<Value> {
        match self {
            Self::Kimi(b) => b.next_event().await.map_err(|_| "kimi_events_failed".into()),
            Self::Zcode(b) => b.next_event().await.map_err(|_| "zcode_events_failed".into()),
        }
    }
    async fn close(&self) -> Result<()> {
        match self {
            Self::Kimi(b) => b.close().await.map(|_| ()).map_err(|_| "kimi_close_failed".into()),
            Self::Zcode(b) => b.close().await.map(|_| ()).map_err(|_| "zcode_close_failed".into()),
        }
    }
    async fn cancel(&self) -> Result<()> {
        match self {
            Self::Kimi(b) => b.cancel().await.map_err(|_| "kimi_cancel_failed".into()),
            Self::Zcode(b) => b.cancel().await.map_err(|_| "zcode_cancel_failed".into()),
        }
    }
}
pub(super) struct GuestSession {
    pub id: String,
    provider: String,
    credential: String,
    system: String,
    gate: AsyncMutex<()>,
    active: Mutex<Option<Backend>>,
    cancelled: AtomicBool,
    pub catalog: Mutex<Value>,
}
impl GuestSession {
    pub async fn identity(host: &MobileTahHost, provider: &str, handle: &str) -> Result<String> {
        match provider {
            "kimi" => Ok(sha256(&format!("kimi:{}", host.kimi_credential(handle).map_err(|_| "authorization_required")?))),
            "zcode" => {
                let auth = host.zcode.authorization(&json!({"credentialHandle":handle})).map_err(|_| "authorization_required")?;
                Ok(sha256(&format!("zcode:{}", auth.identity().await.map_err(|_| "authorization_required")?)))
            }
            _ => Err("provider_not_supported".into()),
        }
    }
    pub async fn open(host: &Arc<MobileTahHost>, input: &Value) -> Result<()> {
        let provider = host.agent.lock()?.store.as_ref().ok_or("workspace_unavailable")?.state.provider_id.clone();
        host.prepare_provider(&provider).await.map_err(|_| "provider_prepare_failed")?;
        let credential = input["credentialHandle"].as_str().ok_or("authorization_required")?.to_string();
        let identity = Self::identity(host, &provider, &credential).await?;
        let inspection = if provider == "kimi" {
            host.inspect_kimi(&json!({"credentialHandle":credential})).await.map_err(|_| "model_catalog_unavailable")?
        } else {
            host.zcode.call("provider.zcode.inspect", &json!({"credentialHandle":credential}),
                &host.prepared().map_err(|_| "runtime_unavailable")?.factory, &host.bundle_fs).await.map_err(|_| "model_catalog_unavailable")?
        };
        let models = model_catalog(&provider, &inspection)?;
        let language = {
            let mut memory = host.agent.lock()?;
            let store = memory.store.as_mut().ok_or("workspace_unavailable")?;
            store.bind(&identity).map_err(|_| "authorization_changed")?;
            if let Some(language) = input["language"].as_str().filter(|s| !s.is_empty() && s.len() < 80) { store.state.language = language.into(); }
            let wanted = input["model"].as_str().map(str::to_owned).or(store.state.model.clone());
            let model = if let Some(wanted) = wanted { models.iter().find(|m| m["model"] == wanted) }
                else { models.first() }.ok_or("selected_model_unavailable")?;
            let efforts = model["supportedReasoningEfforts"].as_array().ok_or("model_catalog_invalid")?;
            let explicit_effort = input["effort"].as_str();
            if explicit_effort.is_some_and(|e| !efforts.iter().any(|item|item["reasoningEffort"]==e)) { return Err("selected_effort_unavailable".into()); }
            let effort = explicit_effort.map(str::to_owned)
                .or(store.state.effort.clone().filter(|e| efforts.iter().any(|item|item["reasoningEffort"]==*e)))
                .or_else(|| model["defaultReasoningEffort"].as_str().map(str::to_owned)).ok_or("model_catalog_invalid")?;
            store.state.model = model["model"].as_str().map(str::to_owned); store.state.effort = Some(effort);
            store.save_state().map_err(|_| "binding_save_failed")?;
            store.state.language.clone()
        };
        let definition = RoleAndCapabilities::load(&host.bundle_fs.parent().ok_or("role_definition_unavailable")?.join("roles/role-and-capabilities.json"))
            .map_err(|_| "role_definition_unavailable")?;
        let role = (if provider == "kimi" { ProviderRoleAdapter::Kimi } else { ProviderRoleAdapter::Zcode })
            .prepare_context(&definition, &language, &format!("/workspace/{SKILL_ROOT}"), CAPABILITY).map_err(|_| "role_definition_invalid")?;
        let system = match role.configuration { NativeRoleConfiguration::KimiSystemFile { contents, .. } => contents,
            NativeRoleConfiguration::ZcodeSystemPrompt(text) => text, _ => return Err("role_adapter_mismatch".into()) };
        let guest = Arc::new(Self { id: Uuid::new_v4().to_string(), provider, credential, system,
            gate: AsyncMutex::new(()), active: Mutex::new(None), cancelled: AtomicBool::new(false), catalog: Mutex::new(Value::Null) });
        {
            let mut memory = host.agent.lock()?;
            memory.guest = Some(guest.clone()); memory.models = json!(models);
            memory.closing = false; memory.cancel_requested = false; memory.error = None;
            let store = memory.store.as_mut().ok_or("workspace_unavailable")?;
            store.state.role_and_capabilities = Some(role.receipt); store.save_state().map_err(|_| "binding_save_failed")?;
        }
        guest.run(host, None, "".into(), None).await?;
        host.agent.lock()?.ready = true;
        Ok(())
    }
    pub async fn cancel(&self) -> Result<()> {
        self.cancelled.store(true, Ordering::Release);
        let backend = self.active.lock().map_err(|_| "guest_state_unavailable")?.clone();
        if let Some(backend) = backend { backend.cancel().await?; }
        Ok(())
    }
    pub async fn close(&self) -> Result<()> {
        self.cancel().await?;
        let _gate = self.gate.lock().await;
        Ok(())
    }
    pub async fn run(&self, host: &Arc<MobileTahHost>, request_id: Option<&str>, text: String, skill: Option<String>) -> Result<()> {
        let _gate = self.gate.lock().await;
        if host.agent.lock()?.closing { return Err("session_closed".into()); }
        self.cancelled.store(false, Ordering::Release);
        let (state, workspace) = {
            let memory = host.agent.lock()?;
            let store = memory.store.as_ref().ok_or("workspace_unavailable")?;
            (store.state.clone(), store.workspace_relative())
        };
        let expected = Self::identity(host, &self.provider, &self.credential).await?;
        if state.authorization_id.as_deref() != Some(expected.as_str()) { return Err("authorization_changed".into()); }
        let id = request_id.map(str::to_owned).unwrap_or_else(|| Uuid::new_v4().to_string());
        let operation = if request_id.is_some() { "turn" } else { "open" };
        let scope = host.prepared().map_err(|_| "runtime_unavailable")?.factory.prepare_persistent(PersistentScopeSpec {
            scope_id: Uuid::new_v4(), workspace_relative: workspace,
            controller_relative: format!("{}/{}/{}", self.provider, expected, state.session_id),
            readonly_roots: vec![SKILL_ROOT.into()], writable_roots: vec!["assets".into()],
        }).await.map_err(|_| "persistent_scope_unavailable")?
          .bind_guest_runtime(if self.provider == "kimi" {GuestRuntime::Kimi} else {GuestRuntime::ZCode})
          .map_err(|_| "guest_scope_unavailable")?;
        let request = json!({"operation":operation,"threadId":state.thread_id,"requestId":id,
            "text":text,"skill":skill,"system":self.system});
        let backend = if self.provider == "kimi" {
            let credential = host.kimi_credential(&self.credential).map_err(|_| "authorization_required")?;
            crate::kimi_backend::KimiBackend::start(scope.clone(), json!({"providerID":"kimi","attemptID":id,
                "inference":{"modelID":state.model,"reasoningEffortID":state.effort},"requiredAbilities":["web"],"sessionAgent":request}), credential)
                .await.map(Backend::Kimi).map_err(|_| "kimi_start_failed")
        } else {
            let authorization = host.zcode.authorization(&json!({"credentialHandle":self.credential})).map_err(|_| "authorization_required")?;
            crate::zcode_native::ZCodeBackend::start(scope.clone(), id.clone(), json!({"prompt":if text.is_empty(){"Open session"}else{&text},
                "role":"actor","language":if state.language=="English"{"en-US"}else{"zh-CN"},"web":true,
                "selection":{"providerId":"account:bigmodel-individual-coding-plan","modelId":state.model,"options":{"reasoningLevel":state.effort}},"sessionAgent":request}), authorization)
                .await.map(Backend::Zcode).map_err(|_| "zcode_start_failed")
        };
        let backend = match backend { Ok(b) => b, Err(e) => { let _ = scope.dispose(); return Err(e.into()); } };
        *self.active.lock().map_err(|_| "guest_state_unavailable")? = Some(backend.clone());
        if host.agent.lock()?.cancel_requested { self.cancelled.store(true, Ordering::Release); }
        let result = self.drain(host, &backend, &id, request_id.is_some()).await;
        let closed = backend.close().await;
        *self.active.lock().map_err(|_| "guest_state_unavailable")? = None;
        closed?;
        scope.dispose().map_err(|_| "guest_scope_cleanup_failed")?;
        let status = result?;
        if request_id.is_some() {
            host.agent.record(json!({"kind":"finished","turnId":id,"status":status}),true)?;
            let mut memory = host.agent.lock()?; memory.busy = false; memory.active_request = None;
            host.agent.notify.notify_waiters();
        }
        Ok(())
    }
    async fn drain(&self, host: &Arc<MobileTahHost>, backend: &Backend, id: &str, turn: bool) -> Result<String> {
        if turn { host.agent.record(json!({"kind":"started","turnId":id}),true)?; }
        let mut confirmed = false;
        let mut zcode = super::zcode_events::ZcodeEvents::new(id);
        loop {
            if self.cancelled.load(Ordering::Acquire) { backend.cancel().await?; }
            let frame = backend.next().await?;
            if frame["done"] == true {
                let terminal = &frame["terminal"];
                if let Some(detail) = terminal.get("diagnostic") {
                    host.agent.record(json!({"kind":"transport_diagnostic","provider":self.provider,"detail":detail}),true)?;
                }
                if self.provider == "zcode" && turn {
                    if !confirmed && terminal["outcome"]["kind"]!="cancelled" {return Err("native_session_receipt_missing".into());}
                    return zcode.terminal(terminal).map(str::to_owned);
                }
                let status = if self.provider == "kimi" {terminal["kind"].as_str()} else {terminal["outcome"]["kind"].as_str()};
                let success = matches!(status, Some("completed"|"end_turn"));
                // A confirmed user cancellation is a terminal result, not a
                // transport failure; retain the cancelled state already recorded.
                if !success && status == Some("cancelled") && turn { return Ok("cancelled".into()); }
                if !success { return Err(format!("{}_session_failed:{}",self.provider,
                    terminal["failure"]["code"].as_str().or(terminal["outcome"]["failure"]["code"].as_str()).unwrap_or("incomplete"))); }
                if !confirmed { return Err("native_session_receipt_missing".into()); }
                return Ok("completed".into());
            }
            let event = &frame["event"];
            if event["kind"] == "native_session" {
                let native_id = event["threadId"].as_str().filter(|s| !s.is_empty()).ok_or("native_session_receipt_invalid")?;
                let mut memory = host.agent.lock()?;
                let store = memory.store.as_mut().ok_or("workspace_unavailable")?;
                if store.state.thread_id.as_deref().is_some_and(|old| old != native_id) { return Err("native_thread_identity_changed".into()); }
                store.state.thread_id = Some(native_id.into()); store.save_state().map_err(|_| "binding_save_failed")?;
                *self.catalog.lock().map_err(|_| "guest_state_unavailable")? = event["skills"].clone();
                confirmed = true;
                zcode.set_session(native_id);
                drop(memory);
                host.agent.record(event.clone(),true)?;
            } else if self.provider == "kimi" {
                if ["assistant","activity","skill_used"].contains(&event["kind"].as_str().unwrap_or("")) {
                    let mut event = event.clone(); event["turnId"] = json!(id);
                    let durable = event["kind"] != "assistant" || event["complete"] == true;
                    host.agent.record(event, durable)?;
                }
            } else if turn {
                for event in zcode.accept(event).map_err(str::to_owned)? {host.agent.record(event,true)?;}
            }
        }
    }
}


fn model_catalog(provider: &str, inspection: &Value) -> Result<Vec<Value>> {
    if inspection["state"] != "valid" { return Err("authorization_required".into()); }
    let rows = if provider == "kimi" { inspection["models"]["data"].as_array() } else { inspection["models"].as_array() }.ok_or("model_catalog_invalid")?;
    let mut models = Vec::new();
    for row in rows {
        let id = if provider == "kimi" { row["id"].as_str() } else { row["handle"].as_str() }.ok_or("model_catalog_invalid")?;
        let admitted = if provider == "kimi" { ["kimi-for-coding","k3-256k","k3","k3.1-pro","k3.1-pro-highspeed","kimi-for-coding-highspeed"].contains(&id) }
            else { ["GLM-5.3","GLM-5.3-Flash"].contains(&id) };
        if !admitted { continue; }
        let efforts: Vec<String> = if provider == "zcode" {
            row["efforts"].as_array().ok_or("model_catalog_invalid")?.iter().filter_map(|e|e["handle"].as_str().map(str::to_owned)).collect()
        } else if id == "kimi-for-coding-highspeed" { vec!["on".into()] }
        else {
            row["think_efforts"]["valid_efforts"].as_array().or_else(||row["reasoning"]["effort"]["valid"].as_array())
                .ok_or("model_catalog_invalid")?.iter().filter_map(|e|e.as_str().map(str::to_owned)).collect()
        };
        if efforts.is_empty() || efforts.iter().any(|e| !["low","high","max","on"].contains(&e.as_str())) { return Err("model_catalog_invalid".into()); }
        let default = if provider == "zcode" { row["defaultEffortHandle"].as_str() } else { row["think_efforts"]["default_effort"].as_str().or(row["reasoning"]["effort"]["default"].as_str()) }
            .filter(|e|efforts.iter().any(|value|value==e)).unwrap_or(&efforts[0]);
        models.push(json!({"id":id,"model":id,"displayName":row["displayName"].as_str().or(row["display_name"].as_str()).unwrap_or(id),
            "defaultReasoningEffort":default,"isDefault":models.is_empty(),
            "supportedReasoningEfforts":efforts.iter().map(|e|json!({"reasoningEffort":e,"description":e})).collect::<Vec<_>>()}));
    }
    if models.is_empty() { return Err("model_catalog_empty".into()); }
    Ok(models)
}
