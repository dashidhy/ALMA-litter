//! Persistent conversations, independent of the old TAH workflow.
#[path = "session_agent_guest.rs"]
mod guest;
#[path = "session_agent_zcode_events.rs"]
mod zcode_events;
#[path = "session_agent_codex_events.rs"]
mod codex_events;
use guest::GuestSession;
use super::{Lease, MobileTahHost, Phase};
use crate::provider_runtime_config::{clear_native_tokens, native_authorization_identity};
use crate::provider_scope::PersistentScopeSpec;
use crate::session_agent_role::{RoleAndCapabilities, sha256};
use crate::session_agent_role_adapters::{NativeRoleConfiguration, ProviderRoleAdapter};
use crate::session_agent_store::{SKILL_ROOT, SKILLS, SessionStore};
use serde_json::{Value, json};
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Mutex as AsyncMutex, Notify};
use tokio::task::JoinHandle;
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
const PROFILE: &str = "alma-session-agent";
const CAPABILITY: &str = "alma-builtin-v1";

#[derive(Clone)]
struct RuntimeRef {
    handle: String,
    home: std::path::PathBuf,
}
#[derive(Default)]
struct Memory {
    store: Option<SessionStore>,
    ready: bool,
    busy: bool,
    closing: bool,
    error: Option<String>,
    models: Value,
    runtime: Option<RuntimeRef>,
    guest: Option<Arc<GuestSession>>,
    active_request: Option<String>,
    cancel_requested: bool,
    manual_compaction: bool,
    events: VecDeque<(u64, Value)>,
}
pub(super) struct AgentController {
    memory: Mutex<Memory>,
    operation: AsyncMutex<()>,
    pump: AsyncMutex<Option<JoinHandle<()>>>,
    notify: Notify,
}
impl AgentController {
    pub(super) fn new() -> Self {
        Self {
            memory: Mutex::new(Memory::default()),
            operation: AsyncMutex::new(()),
            pump: AsyncMutex::new(None),
            notify: Notify::new(),
        }
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Memory>> {
        self.memory
            .lock()
            .map_err(|_| "session_state_unavailable".into())
    }
    fn ensure_store(&self, host: &MobileTahHost) -> Result<()> {
        let mut memory = self.lock()?;
        if memory.store.is_none() {
            let package = host
                .bundle_fs
                .parent()
                .ok_or("skill_bundle_unavailable")?
                .join("skills")
                .join(crate::session_agent_store::SKILL_BUNDLE);
            SessionStore::install_skills(&host.support.join("Alma"), &package)
                .map_err(|_| "skill_bundle_install_failed")?;
            memory.store = Some(
                SessionStore::open(host.support.join("Alma"))
                    .map_err(|e| format!("storage: {e}"))?,
            );
        }
        Ok(())
    }
    fn snapshot(&self) -> Result<Value> {
        let memory = self.lock()?;
        let store = memory.store.as_ref().ok_or("workspace_unavailable")?;
        Ok(store.snapshot(
            memory.busy,
            memory.ready,
            memory.error.as_deref(),
            &memory.models,
        ))
    }
    fn record(&self, event: Value, durable: bool) -> Result<()> {
        let mut memory = self.lock()?;
        let store = memory.store.as_mut().ok_or("workspace_unavailable")?;
        let mut event = store
            .record(event, durable)
            .map_err(|_| "conversation_save_failed")?;
        let sequence = store.conversation.sequence;
        event["sequence"] = json!(sequence);
        memory.events.push_back((sequence, event));
        while memory.events.len() > 2000 {
            memory.events.pop_front();
        }
        drop(memory);
        self.notify.notify_waiters();
        Ok(())
    }
    fn fail(&self, code: &str) {
        let mut finish = false;
        if let Ok(mut memory) = self.lock() {
            finish = memory.store.as_ref().is_some_and(|s|matches!(s.conversation.status.as_str(),"running"|"sending"));
            memory.error = Some(code.into());
            memory.busy = false;
            memory.manual_compaction = false;
            // A transport failure does not prove the native request never ran.
            // Require close/resume reconciliation before accepting more work.
            memory.ready = false;
        }
        if finish {
            let public_code:String=code.chars().filter(|c|c.is_ascii_alphanumeric()||['_','-',':'].contains(c)).take(160).collect();
            let _ = self.record(json!({"kind":"finished","status":"failed","error":public_code}), true);
        }
        self.notify.notify_waiters();
    }

    pub(super) async fn call(
        host: Arc<MobileTahHost>,
        method: &str,
        value: Value,
    ) -> Result<Value> {
        host.agent.ensure_store(&host)?;
        match method {
            "agent.snapshot" => host.agent.snapshot(),
            "agent.provider" => {
                if let Some(id) = value["sessionId"].as_str() {
                    let store = SessionStore::open_session(host.support.join("Alma"), id).map_err(|_| "workspace_open_failed")?;
                    Ok(json!({"provider":store.state.provider_id}))
                } else { Ok(json!({"provider":host.agent.lock()?.store.as_ref().ok_or("workspace_unavailable")?.state.provider_id})) }
            }
            "agent.sessions" => {
                let root = host.support.join("Alma/sessions");
                let mut sessions = Vec::new();
                for entry in std::fs::read_dir(root).map_err(|_| "workspace_list_failed")? {
                    let entry = entry.map_err(|_| "workspace_list_failed")?;
                    if !entry.file_type().map_err(|_| "workspace_list_failed")?.is_dir() { continue; }
                    let Ok(bytes) = std::fs::read(entry.path().join("conversation/session.json")) else { continue };
                    let Ok(state) = serde_json::from_slice::<crate::session_agent_store::SessionState>(&bytes) else { continue };
                    sessions.push(json!({"sessionId":state.session_id,"provider":state.provider_id,"hasMessages":state.has_user_requests}));
                }
                Ok(json!({"sessions":sessions}))
            },
            "agent.skillDiscovery" => {
                let guest = host.agent.lock()?.guest.clone();
                if let Some(guest) = guest { return Ok(guest.catalog.lock().map_err(|_| "guest_state_unavailable")?.clone()); }
                let handle = host
                    .agent
                    .lock()?
                    .runtime
                    .as_ref()
                    .ok_or("runtime_unavailable")?
                    .handle
                    .clone();
                host.prepared()
                    .map_err(|_| "runtime_unavailable")?
                    .bridge
                    .inspect_capability_root(&handle, &format!("/workspace/{SKILL_ROOT}"))
                    .await
                    .map_err(|_| "skill_discovery_failed".into())
            }
            "agent.newSession" => {
                let _operation = host.agent.operation.lock().await;
                if host.agent.lock()?.busy {
                    return Err("session_busy_or_closed".into());
                }
                Self::close(&host).await?;
                let provider = value["provider"].as_str().unwrap_or("codex");
                if !["codex","kimi","zcode"].contains(&provider) { return Err("provider_not_supported".into()); }
                let mut store = SessionStore::create(host.support.join("Alma"))
                    .map_err(|_| "workspace_create_failed")?;
                store.state.provider_id = provider.into();
                store.save_state().map_err(|_| "binding_save_failed")?;
                *host.agent.lock()? = Memory {
                    store: Some(store),
                    ..Memory::default()
                };
                host.agent.snapshot()
            }
            "agent.configure" => {
                let _operation = host.agent.operation.lock().await;
                let mut memory = host.agent.lock()?;
                if memory.busy || memory.closing {return Err("session_busy_or_closed".into());}
                let catalog = memory.models.clone();
                let store = memory.store.as_mut().ok_or("workspace_unavailable")?;
                if value["sessionId"].as_str().is_some_and(|id|id!=store.state.session_id) {return Err("workspace_changed".into());}
                store.configure_inference(&value, &catalog).map_err(|e|e.to_string())?;
                drop(memory);
                host.agent.snapshot()
            }
            "agent.open" => {
                let _operation = host.agent.operation.lock().await;
                if let Some(id) = value["sessionId"].as_str() {
                    let switching = host
                        .agent
                        .lock()?
                        .store
                        .as_ref()
                        .is_none_or(|s| s.state.session_id != id);
                    if switching {
                        if host.agent.lock()?.busy {
                            return Err("session_busy_or_closed".into());
                        }
                        Self::close(&host).await?;
                        let store = SessionStore::select(host.support.join("Alma"), id)
                            .map_err(|_| "workspace_open_failed")?;
                        *host.agent.lock()? = Memory {
                            store: Some(store),
                            ..Memory::default()
                        };
                    }
                }
                let provider = host.agent.lock()?.store.as_ref().ok_or("workspace_unavailable")?.state.provider_id.clone();
                if provider != "codex" {
                    if !host.agent.lock()?.ready {
                        if host.agent.lock()?.busy { return Err("session_busy_or_closed".into()); }
                        Self::close(&host).await?;
                        if let Err(error) = GuestSession::open(&host, &value).await { host.agent.fail(&error); }
                    } else {
                        let identity = GuestSession::identity(&host, &provider, value["credentialHandle"].as_str().ok_or("authorization_required")?).await?;
                        if host.agent.lock()?.store.as_ref().and_then(|s|s.state.authorization_id.as_deref()).is_none_or(|old|old!=identity) {
                            Self::close(&host).await?; host.agent.fail("authorization_changed");
                        }
                    }
                    return host.agent.snapshot();
                }
                if host.agent.lock()?.ready {
                    let credential = value["credentialHandle"]
                        .as_str()
                        .ok_or("authorization_required")?;
                    let identity = {
                        let state = host.state.lock().map_err(|_| "authorization_unavailable")?;
                        native_authorization_identity(
                            state
                                .credentials
                                .get(credential)
                                .ok_or("authorization_required")?,
                        )
                        .map_err(|_| "authorization_identity_unavailable")?
                    };
                    let matches = host.agent.lock()?.store.as_ref().is_some_and(|store| {
                        store.state.authorization_id.as_deref() == Some(identity.as_str())
                    });
                    if !matches {
                        Self::close(&host).await?;
                        host.agent.fail("authorization_changed");
                        return host.agent.snapshot();
                    }
                }
                if !host.agent.lock()?.ready {
                    if host.agent.lock()?.runtime.is_some() {
                        Self::close(&host).await?;
                    }
                    if let Err(error) = Self::open(&host, &value).await {
                        host.agent.fail(&error);
                        return host.agent.snapshot();
                    }
                }
                host.agent.snapshot()
            }
            "agent.send" => {
                let _operation = host.agent.operation.lock().await;
                let text = value["text"].as_str().unwrap_or("").trim().to_string();
                let skill = value["skill"].as_str().map(str::to_owned);
                if text.len() > 64 * 1024
                    || (text.is_empty() && skill.is_none())
                    || skill
                        .as_ref()
                        .is_some_and(|s| !SKILLS.iter().any(|(id, _, _)| id == s))
                {
                    return Err("invalid_message".into());
                }
                let id = Uuid::new_v4().to_string();
                let (handle, inference) = {
                    let mut memory = host.agent.lock()?;
                    if !memory.ready || memory.busy || memory.closing {
                        return Err("session_busy_or_closed".into());
                    }
                    let handle = if let Some(guest) = &memory.guest { guest.id.clone() }
                        else { memory.runtime.as_ref().ok_or("runtime_unavailable")?.handle.clone() };
                    let store = memory.store.as_ref().ok_or("workspace_unavailable")?;
                    let inference = json!({"model":store.state.model,"effort":store.state.effort});
                    memory.busy = true;
                    memory.manual_compaction = false;
                    memory.error = None;
                    memory.cancel_requested = false;
                    memory.active_request = Some(id.clone());
                    (handle, inference)
                };
                if let Err(error) = host.agent.record(
                    json!({"kind":"user","id":id,"text":text,"skill":skill,"inference":inference}),
                    true,
                ) {
                    let mut memory = host.agent.lock()?;
                    memory.busy = false;
                    memory.active_request = None;
                    return Err(error);
                }
                let worker = host.clone();
                tokio::spawn(async move {
                    let guest = worker.agent.lock().ok().and_then(|m| m.guest.clone());
                    let result = if let Some(guest) = guest { guest.run(&worker, Some(&id), text, skill).await }
                        else { Self::send(&worker, &handle, &id, text, skill).await };
                    if let Err(error) = result {
                        let current = worker.agent.lock().is_ok_and(|m| {
                            (m.runtime.as_ref().is_some_and(|r| r.handle == handle) || m.guest.as_ref().is_some_and(|g| g.id == handle))
                                && m.active_request.as_deref() == Some(id.as_str())
                        });
                        if current {
                            worker.agent.fail(&error);
                        }
                    }
                });
                host.agent.snapshot()
            }
            "agent.cancel" => {
                Self::cancel(&host).await?;
                host.agent.snapshot()
            }
            "agent.close" => {
                let _operation = host.agent.operation.lock().await;
                Self::close(&host).await?;
                host.agent.snapshot()
            }
            "agent.assets" => {
                let memory = host.agent.lock()?;
                let store = memory.store.as_ref().ok_or("workspace_unavailable")?;
                Ok(json!({"files":store.assets().map_err(|_|"asset_list_failed")?}))
            }
            "agent.read" => {
                let path = value["path"].as_str().ok_or("invalid_path")?;
                let memory = host.agent.lock()?;
                let store = memory.store.as_ref().ok_or("workspace_unavailable")?;
                Ok(json!({"path":path,"text":store.read(path).map_err(|_|"asset_read_failed")?}))
            }
            "agent.workingLog" => {
                let id = value["id"].as_str().ok_or("invalid_turn")?;
                let memory = host.agent.lock()?;
                let store = memory.store.as_ref().ok_or("workspace_unavailable")?;
                store
                    .working_log(id)
                    .map_err(|_| "working_log_read_failed".into())
            }
            "agent.events" => {
                let after = value["after"].as_u64().unwrap_or(0);
                let notified = host.agent.notify.notified();
                let has_new = {
                    let memory = host.agent.lock()?;
                    memory
                        .store
                        .as_ref()
                        .is_some_and(|s| s.conversation.sequence > after)
                };
                if !has_new {
                    let _ = tokio::time::timeout(Duration::from_millis(800), notified).await;
                }
                let memory = host.agent.lock()?;
                let store = memory.store.as_ref().ok_or("workspace_unavailable")?;
                let reset = memory
                    .events
                    .front()
                    .is_some_and(|(seq, _)| after + 1 < *seq)
                    || after > store.conversation.sequence;
                Ok(json!({"sequence":store.conversation.sequence,"reset":reset,
                    "snapshot":if reset{Some(store.snapshot(memory.busy,memory.ready,memory.error.as_deref(),&memory.models))}else{None},
                    "state":{"busy":memory.busy,"ready":memory.ready,"error":memory.error,"status":store.conversation.status,"threadId":store.state.thread_id,"turns":store.conversation.turns},
                    "events":memory.events.iter().filter(|(seq,_)|*seq>after).map(|(_,event)|event).collect::<Vec<_>>()}))
            }
            "agent.compact" => {
                if host.agent.lock()?.guest.is_some() { return Err("manual_compaction_not_supported".into()); }
                {
                    let mut memory = host.agent.lock()?;
                    if !memory.ready || memory.busy {
                        return Err("session_busy_or_closed".into());
                    }
                    memory.busy = true;
                    memory.manual_compaction = true;
                }
                let runtime = host
                    .agent
                    .lock()?
                    .runtime
                    .clone()
                    .ok_or("runtime_unavailable")?;
                let id = host
                    .agent
                    .lock()?
                    .store
                    .as_ref()
                    .and_then(|s| s.state.thread_id.clone())
                    .ok_or("thread_unavailable")?;
                let result = Self::rpc(
                    &host,
                    &runtime.handle,
                    "thread/compact/start",
                    json!({"threadId":id}),
                )
                .await;
                if let Err(error) = result {
                    host.agent.fail(&error);
                }
                host.agent.snapshot()
            }
            _ => Err("unknown_agent_operation".into()),
        }
    }

    async fn rpc(host: &MobileTahHost, handle: &str, method: &str, params: Value) -> Result<Value> {
        if matches!(method, "thread/start" | "thread/resume" | "turn/start") {
            // Host audit only; these records never enter model input or chat.
            // It distinguishes context configuration from ordinary turn payloads.
            host.agent.record(
                json!({"kind":"native_role_request", "method":method,
                    "contextHandle":handle,
                    "hasDeveloperInstructions":params.get("developerInstructions").is_some(),
                    "configurationSHA256":params["developerInstructions"].as_str().map(sha256)
                }),
                true,
            )?;
        }
        let response = host
            .prepared()
            .map_err(|_| "runtime_unavailable")?
            .bridge
            .request(handle, method, params)
            .await
            .map_err(|_| format!("native_request_failed:{method}"))?;
        if response.get("error").is_some() {
            let message = response["error"]["message"].as_str().unwrap_or("");
            if method == "thread/resume"
                && (message.starts_with("no rollout found for thread id ")
                    || message.starts_with("thread not found: "))
            {
                return Err("native_thread_missing".into());
            }
            // Diagnostic codes only. Native messages can contain tokens or paths.
            return Err(format!(
                "native_rpc:{method}:{}",
                response["error"]["code"].as_i64().unwrap_or(0)
            ));
        }
        response
            .get("value")
            .cloned()
            .ok_or_else(|| format!("native_receipt_missing:{method}"))
    }

    async fn open(host: &Arc<MobileTahHost>, input: &Value) -> Result<()> {
        host.prepare_provider("codex")
            .await
            .map_err(|_| "provider_prepare_failed")?;
        let credential = input["credentialHandle"]
            .as_str()
            .ok_or("authorization_required")?
            .to_string();
        let tokens = host
            .state
            .lock()
            .map_err(|_| "authorization_unavailable")?
            .credentials
            .get(&credential)
            .cloned()
            .ok_or("authorization_required")?;
        let authorization = native_authorization_identity(&tokens)
            .map_err(|_| "authorization_identity_unavailable")?;
        let (session_id, workspace, thread_id, selected_model, selected_effort, language) = {
            let mut memory = host.agent.lock()?;
            memory.error = None;
            memory.closing = false;
            memory.cancel_requested = false;
            let store = memory.store.as_mut().ok_or("workspace_unavailable")?;
            store
                .bind(&authorization)
                .map_err(|_| "authorization_changed")?;
            if let Some(language) = input["language"].as_str().filter(|s| s.len() < 80) {
                store.state.language = language.into();
            }
            if let Some(model) = input["model"].as_str().filter(|s| s.len() < 200) {
                store.state.model = Some(model.into());
            }
            if let Some(effort) = input["effort"].as_str().filter(|s| s.len() < 30) {
                store.state.effort = Some(effort.into());
            }
            (
                store.state.session_id.clone(),
                store.workspace_relative(),
                store.state.thread_id.clone(),
                store.state.model.clone(),
                store.state.effort.clone(),
                store.state.language.clone(),
            )
        };
        let definition = RoleAndCapabilities::load(
            &host
                .bundle_fs
                .parent()
                .ok_or("role_definition_unavailable")?
                .join("roles/role-and-capabilities.json"),
        )
        .map_err(|_| "role_definition_unavailable")?;
        let role = ProviderRoleAdapter::Codex
            .prepare_context(
                &definition,
                &language,
                &format!("/workspace/{SKILL_ROOT}"),
                CAPABILITY,
            )
            .map_err(|_| "role_definition_invalid")?;
        let NativeRoleConfiguration::CodexDeveloperInstructions(ref role_instructions) =
            role.configuration
        else {
            return Err("role_adapter_mismatch".into());
        };
        let prepared = host.prepared().map_err(|_| "runtime_unavailable")?;
        let scope = prepared
            .bridge
            .prepare_persistent(PersistentScopeSpec {
                scope_id: Uuid::new_v4(),
                workspace_relative: workspace,
                controller_relative: format!("codex/{authorization}/{session_id}"),
                readonly_roots: vec![SKILL_ROOT.into()],
                writable_roots: vec!["assets".into()],
            })
            .await
            .map_err(|_| "persistent_scope_unavailable")?;
        let handle = scope["handle"]
            .as_str()
            .ok_or("scope_receipt_invalid")?
            .to_string();
        let layout = prepared
            .bridge
            .layout(&handle)
            .map_err(|_| "scope_receipt_invalid")?;
        host.state
            .lock()
            .map_err(|_| "authorization_unavailable")?
            .leases
            .insert(
                handle.clone(),
                Lease {
                    credential,
                    account_id: tokens.account_id.clone(),
                    phase: Phase::Bound,
                    expected: None,
                },
            );
        host.agent.lock()?.runtime = Some(RuntimeRef {
            handle: handle.clone(),
            home: layout.controller_home.clone().into(),
        });
        let result=async {
            // Native startup needs a real model config; the default discovery
            // model is the existing qualified host baseline, never inference.
            let bootstrap_model=selected_model.as_deref().unwrap_or("gpt-5.6-luna");
            let mut profile=native_profile(&layout,bootstrap_model,selected_effort.as_deref().unwrap_or("medium"));
            profile["sessionThreadID"]=json!(thread_id);
            host.start(&handle,&profile).await.map_err(|_|"native_start_failed")?;
            let pump_host=host.clone();let pump_handle=handle.clone();
            *host.agent.pump.lock().await=Some(tokio::spawn(async move{Self::pump(pump_host,pump_handle).await;}));
            let initialized=Self::rpc(host,&handle,"initialize",json!({"clientInfo":{"name":"alma-session-agent","title":"Alma Session Agent","version":"1.0.0"},
                "capabilities":{"experimentalApi":true,"requestAttestation":false}})).await?;
            if initialized["codexHome"].as_str()!=Some(layout.controller_home.as_str()) {return Err("native_identity_mismatch".into());}
            prepared.bridge.notify(&handle,"initialized",Value::Null).await.map_err(|_|"initialize_failed")?;
            prepared.bridge.install_native_tokens(&handle,tokens).await.map_err(|_|"authorization_failed")?;
            host.change(&handle,Phase::Started,Phase::Authenticated).map_err(|_|"authorization_phase_failed")?;
            let account=Self::rpc(host,&handle,"account/read",json!({"refreshToken":false})).await?;
            if account["account"].is_null(){return Err("authorization_required".into());}
            let mut models=Vec::new();let mut cursor=Value::Null;
            for _ in 0..16 {
                let page=Self::rpc(host,&handle,"model/list",json!({"includeHidden":false,"limit":64,"cursor":cursor})).await?;
                models.extend(page["data"].as_array().ok_or("model_catalog_invalid")?.iter().cloned());
                cursor=page["nextCursor"].clone();if cursor.is_null(){break;}
            }
            if !cursor.is_null(){return Err("model_catalog_incomplete".into());}
            let model=if let Some(wanted)=selected_model.as_deref(){models.iter().find(|m|m["id"]==wanted||m["model"]==wanted)}
                else{models.iter().find(|m|m["isDefault"]==true).or_else(||models.first())}.ok_or("selected_model_unavailable")?;
            let model_name=model["model"].as_str().or_else(||model["id"].as_str()).ok_or("model_catalog_invalid")?.to_string();
            let effort=selected_effort.or_else(||model["defaultReasoningEffort"].as_str().map(str::to_owned)).unwrap_or_else(||"medium".into());
            let profile=native_profile(&layout,&model_name,&effort);
            let common=json!({"cwd":layout.workspace_root,"model":model_name,"config":profile["threadConfig"],
                "approvalPolicy":"never","approvalsReviewer":"user","permissions":PROFILE,
                "developerInstructions":role_instructions,"runtimeWorkspaceRoots":[layout.workspace_root],
                "selectedCapabilityRoots":[{"id":CAPABILITY,"location":{"type":"environment","environmentId":"embedded","path":format!("/workspace/{SKILL_ROOT}")}}]});
            let mut replaced_empty_binding=false;
            let resumed=if let Some(id)=&thread_id {
                let mut params=common.clone();params["threadId"]=json!(id);
                // selectedCapabilityRoots is persisted at creation; current
                // frozen resume schema restores it from the native thread.
                params.as_object_mut().unwrap().remove("selectedCapabilityRoots");
                match Self::rpc(host,&handle,"thread/resume",params).await {
                    Ok(receipt)=>Some(receipt),
                    Err(error) if error=="native_thread_missing"=>{
                        let empty=host.agent.lock()?.store.as_ref().is_some_and(|store|
                            !store.state.has_user_requests && !store.conversation.messages.iter().any(|m|m.role=="user"));
                        if !empty{return Err(error);}
                        // Repair only the pre-persistence prototype's empty
                        // binding. Used/unknown native requests never restart.
                        replaced_empty_binding=true;
                        None
                    },
                    Err(error)=>return Err(error),
                }
            }else{None};
            let receipt=if let Some(receipt)=resumed {receipt}else{
                let mut params=common;params["ephemeral"]=json!(false);params["historyMode"]=json!("paginated");
                let receipt=Self::rpc(host,&handle,"thread/start",params).await?;
                let id=receipt["thread"]["id"].as_str().ok_or("thread_receipt_invalid")?;
                // Follow the SDK's named_empty_paginated_thread_resumes_after_restart
                // flow: naming persists both rollout and index, without inference.
                Self::rpc(host,&handle,"thread/name/set",json!({"threadId":id,"name":"NVIDIA transcript"})).await?;
                Self::rpc(host,&handle,"thread/read",json!({"threadId":id,"includeTurns":true})).await?;
                receipt
            };
            let id=receipt["thread"]["id"].as_str().ok_or("thread_receipt_invalid")?.to_string();
            if !replaced_empty_binding && thread_id.as_ref().is_some_and(|expected|*expected!=id){return Err("native_thread_identity_changed".into());}
            host.change(&handle,Phase::Authenticated,Phase::Sealed).map_err(|_|"authorization_phase_failed")?;
            {let mut memory=host.agent.lock()?;let store=memory.store.as_mut().ok_or("workspace_unavailable")?;
                if replaced_empty_binding {store.record(json!({"kind":"binding_replaced","reason":"empty_native_thread_not_materialized","oldThreadId":thread_id,"threadId":id}),true).map_err(|_|"binding_save_failed")?;}
                store.state.thread_id=Some(id);store.state.model=Some(model_name);store.state.effort=Some(effort);
                store.state.role_and_capabilities=Some(role.receipt.clone());
                store.save_state().map_err(|_|"binding_save_failed")?;
                memory.models=json!(models);}
            if thread_id.is_some(){Self::reconcile_history(host,&handle).await?;}
            host.agent.lock()?.ready=true;
            host.agent.notify.notify_waiters();
            Ok(())
        }.await;
        if result.is_err() && Self::close(host).await.is_err() {
            // A failure before the native runtime starts still owns a prepared
            // lease. Release it without deleting durable state. Once runtime
            // cleanup is uncertain, release refuses and the App must restart.
            if prepared.bridge.release(&handle).is_ok() {
                host.state
                    .lock()
                    .map_err(|_| "authorization_unavailable")?
                    .leases
                    .remove(&handle);
                let mut memory = host.agent.lock()?;
                memory.runtime = None;
                memory.ready = false;
                memory.closing = false;
            }
        }
        result
    }

    async fn reconcile_history(host: &MobileTahHost, handle: &str) -> Result<()> {
        let thread = host
            .agent
            .lock()?
            .store
            .as_ref()
            .and_then(|s| s.state.thread_id.clone())
            .ok_or("thread_unavailable")?;
        let history = Self::rpc(
            host,
            handle,
            "thread/read",
            json!({"threadId":thread,"includeTurns":true}),
        )
        .await?;
        let turns = history["thread"]["turns"]
            .as_array()
            .ok_or("native_history_invalid")?;
        for turn in turns {
            let Some(items) = turn["items"].as_array() else {
                continue;
            };
            let client = items
                .iter()
                .find(|item| item["type"] == "userMessage")
                .and_then(|item| item["clientId"].as_str());
            let Some(client) = client else { continue };
            let known = host.agent.lock()?.store.as_ref().is_some_and(|store| {
                store
                    .conversation
                    .messages
                    .iter()
                    .any(|m| m.role == "user" && m.id == client)
            });
            if !known {
                continue;
            }
            host.agent.record(json!({"kind":"reconciled","id":client,"turnId":turn["id"],"status":turn["status"]}),true)?;
            for item in items.iter().filter(|item| item["type"] == "agentMessage") {
                let Some(id) = item["id"].as_str() else {
                    continue;
                };
                let Some(text) = item["text"].as_str() else {
                    continue;
                };
                let complete = turn["status"] == "completed";
                let identical = host.agent.lock()?.store.as_ref().is_some_and(|store| {
                    store.conversation.messages.iter().any(|m| {
                        m.id == id
                            && m.text == text
                            && m.phase.as_deref() == item["phase"].as_str()
                            && (!complete || m.status == "complete")
                    })
                });
                if !identical {
                    host.agent.record(json!({"kind":"assistant","id":id,"text":text,"turnId":turn["id"],"phase":item["phase"],"complete":complete}),true)?;
                }
            }
        }
        Ok(())
    }

    async fn send(
        host: &Arc<MobileTahHost>,
        expected_handle: &str,
        message_id: &str,
        text: String,
        skill: Option<String>,
    ) -> Result<()> {
        let (runtime, id, model, effort) = {
            let memory = host.agent.lock()?;
            let store = memory.store.as_ref().ok_or("workspace_unavailable")?;
            if memory.closing
                || memory.cancel_requested
                || memory
                    .runtime
                    .as_ref()
                    .is_none_or(|r| r.handle != expected_handle)
            {
                return Err("request_interrupted".into());
            }
            (
                memory.runtime.clone().ok_or("runtime_unavailable")?,
                store.state.thread_id.clone().ok_or("thread_unavailable")?,
                store.state.model.clone(),
                store.state.effort.clone(),
            )
        };
        let mut input = Vec::new();
        if let Some(skill) = &skill {
            input.push(json!({"type":"skill","name":skill,"path":format!("skill://{CAPABILITY}/workspace/{SKILL_ROOT}/{skill}/SKILL.md")}));
        }
        let text = if text.is_empty() {
            format!(
                "Use the {} skill for this session.",
                skill.as_deref().unwrap_or("selected")
            )
        } else {
            text
        };
        input.push(json!({"type":"text","text":text}));
        let receipt = Self::rpc(
            host,
            &runtime.handle,
            "turn/start",
            json!({"threadId":id,"input":input,"clientUserMessageId":message_id,
            "model":model,"effort":effort,"approvalPolicy":"never","approvalsReviewer":"user"}),
        )
        .await?;
        let turn = receipt["turn"]["id"]
            .as_str()
            .ok_or("turn_receipt_invalid")?;
        let pending = host
            .agent
            .lock()?
            .store
            .as_ref()
            .is_some_and(|s| s.conversation.status == "sending");
        if pending {
            host.agent
                .record(json!({"kind":"started","turnId":turn}), true)?;
        }
        Ok(())
    }

    async fn cancel(host: &MobileTahHost) -> Result<()> {
        let guest = host.agent.lock()?.guest.clone();
        if let Some(guest) = guest { host.agent.lock()?.cancel_requested = true; return guest.cancel().await; }
        let (runtime, thread, turn) = {
            let mut memory = host.agent.lock()?;
            memory.cancel_requested = true;
            let store = memory.store.as_ref().ok_or("workspace_unavailable")?;
            (
                memory.runtime.clone(),
                store.state.thread_id.clone(),
                store.conversation.active_turn.clone(),
            )
        };
        if let (Some(runtime), Some(thread), Some(turn)) = (runtime, thread, turn) {
            Self::rpc(
                host,
                &runtime.handle,
                "turn/interrupt",
                json!({"threadId":thread,"turnId":turn}),
            )
            .await?;
        }
        Ok(())
    }

    async fn close(host: &MobileTahHost) -> Result<()> {
        let guest = { let mut memory = host.agent.lock()?; memory.closing = true; memory.ready = false; memory.guest.clone() };
        if let Some(guest) = guest {
            guest.close().await?;
            let mut memory = host.agent.lock()?;
            memory.guest = None; memory.busy = false; memory.closing = false; memory.active_request = None;
            return Ok(());
        }
        let runtime = {
            let mut memory = host.agent.lock()?;
            memory.closing = true;
            memory.ready = false;
            memory.runtime.clone()
        };
        let Some(runtime) = runtime else {
            return Ok(());
        };
        let _ = Self::cancel(host).await;
        let prepared = host.prepared().map_err(|_| "runtime_unavailable")?;
        let receipt = prepared
            .bridge
            .close(&runtime.handle)
            .await
            .map_err(|_| "native_close_incomplete")?;
        if receipt["scopeQuiescent"] != true {
            return Err("scope_not_quiescent".into());
        }
        if let Some(pump) = host.agent.pump.lock().await.take() {
            tokio::time::timeout(Duration::from_secs(20), pump)
                .await
                .map_err(|_| "event_drain_timeout")?
                .map_err(|_| "event_drain_failed")?;
        }
        clear_native_tokens(&runtime.home).map_err(|_| "native_auth_cleanup_failed")?;
        prepared
            .bridge
            .release(&runtime.handle)
            .map_err(|_| "scope_release_failed")?;
        host.state
            .lock()
            .map_err(|_| "authorization_unavailable")?
            .leases
            .remove(&runtime.handle);
        let mut memory = host.agent.lock()?;
        memory.runtime = None;
        memory.busy = false;
        memory.closing = false;
        drop(memory);
        host.agent.notify.notify_waiters();
        Ok(())
    }

    async fn pump(host: Arc<MobileTahHost>, handle: String) {
        loop {
            let frame = match host.prepared() {
                Ok(p) => p.bridge.next_event(&handle).await,
                Err(_) => break,
            };
            let frame = match frame {
                Ok(f) => f,
                Err(_) => {
                    host.agent.fail("native_event_stream_failed");
                    break;
                }
            };
            if frame["done"] == true {
                break;
            }
            let event = &frame["event"];
            if event["kind"] == "server_request" {
                if let Ok(id) = serde_json::from_value(event["id"].clone()) {
                    if let Ok(p) = host.prepared() {
                        let _ = p
                            .bridge
                            .respond_native(
                                &handle,
                                id,
                                Err(codex_app_server_protocol::JSONRPCErrorError {
                                    code: -32601,
                                    message: "This operation is not available in Session Agent"
                                        .into(),
                                    data: None,
                                }),
                            )
                            .await;
                    }
                }
                continue;
            }
            if let Err(error) = host.agent.observe(event) {
                host.agent.fail(&error);
                break;
            }
            if event["method"] == "turn/started"
                && host.agent.lock().is_ok_and(|m| m.cancel_requested)
            {
                let _ = Self::cancel(&host).await;
            }
        }
        if let Ok(mut memory) = host.agent.lock() {
            memory.ready = false;
            if memory.busy {
                drop(memory);
                let _ = host
                    .agent
                    .record(json!({"kind":"finished","status":"interrupted"}), true);
                if let Ok(mut memory) = host.agent.lock() {
                    memory.busy = false;
                }
            }
        }
        host.agent.notify.notify_waiters();
    }

    fn observe(&self, event: &Value) -> Result<()> {
        let method = event["method"].as_str().unwrap_or("");
        let p = &event["params"];
        let public = {
            let memory=self.lock()?;
            memory.store.as_ref().and_then(|s|codex_events::auxiliary(event,s.conversation.active_turn.as_deref(),&s.conversation.activities))
        };
        if let Some(public)=public {self.record(public,true)?;}
        match method {
            "turn/started" => {
                if self.lock()?.active_request.is_none() {return Ok(());}
                self.record(json!({"kind":"started","turnId":p["turn"]["id"]}), true)?;
                self.lock()?.busy = true;
            }
            "item/agentMessage/delta" => self.record(
                json!({"kind":"assistant","id":p["itemId"],"delta":p["delta"],"turnId":p["turnId"]}),
                false,
            )?,
            "item/started" | "item/completed" => {
                let item = &p["item"];
                let done = method == "item/completed";
                let kind = item["type"].as_str().unwrap_or("");
                if kind == "agentMessage" {
                    self.record(json!({"kind":"assistant","id":item["id"],"text":item["text"],"phase":item["phase"],"turnId":p["turnId"],"complete":done}),done)?;
                } else if !matches!(kind, "reasoning" | "userMessage" | "") {
                    let detail = if kind == "commandExecution" {
                        item["command"]
                            .as_str()
                            .map(|command| format!("Command: {command}"))
                            .unwrap_or_else(|| item["command"].to_string())
                    } else if kind == "webSearch" {
                        let action = &item["action"];
                        let queries = action["queries"].as_array().into_iter().flatten().filter_map(Value::as_str).take(16).collect::<Vec<_>>();
                        if !queries.is_empty() { format!("Web search: {}", queries.join("; ")) }
                        else if let Some(query) = action["query"].as_str().or(item["query"].as_str()) { format!("Web search: {query}") }
                        else if let Some(url) = action["url"].as_str() {
                            let public_url = url::Url::parse(url).ok().map(|mut u| { u.set_query(None); u.set_fragment(None); let _=u.set_username(""); let _=u.set_password(None); u.to_string() }).unwrap_or_default();
                            if action["type"] == "findInPage" { format!("Find in page: {} · {}",public_url,action["pattern"].as_str().unwrap_or("")) }
                            else {format!("Open page: {public_url}")}
                        } else {"Web search".into()}
                    } else if kind == "fileChange" {
                        let paths = item["changes"].as_array().into_iter().flatten()
                            .filter_map(|change|change["path"].as_str()).collect::<Vec<_>>();
                        format!("Edit files: {}", paths.join(", "))
                    } else {
                        item.get("tool")
                            .and_then(Value::as_str)
                            .unwrap_or(kind)
                            .into()
                    };
                    let status = if !done {"running"} else if matches!(item["status"].as_str(),Some("failed"|"declined"|"cancelled")) {"failed"} else {"completed"};
                    let detail = if done { format!("{detail} — {status}") } else { detail };
                    let mut bytes = 0;
                    let clean: String = detail.chars().map(|c|if c.is_ascii_control(){' '}else{c}).take_while(|c|{bytes+=c.len_utf8();bytes<=4096}).collect();
                    let label = if kind == "commandExecution" {
                        let actions = item["commandActions"].as_array().into_iter().flatten().filter_map(|a|a["type"].as_str()).collect::<Vec<_>>();
                        match actions.first().copied().filter(|first|actions.iter().all(|a|a==first)) {Some("read")=>"Read",Some("listFiles")=>"Glob",Some("search")=>"Grep",_=>kind}
                    } else {kind};
                    self.record(json!({"kind":"activity","activity":{"id":item["id"],"kind":label,
                        "turnId":p["turnId"],"text":clean,
                        "detailTruncated":detail.len()>4096,
                        "status":status}}),false)?;
                }
            }
            "turn/completed" => {
                if self.lock()?.active_request.is_none() {
                    let mut memory=self.lock()?;
                    if memory.manual_compaction {memory.manual_compaction=false;memory.busy=false;}
                    return Ok(());
                }
                let status = p["turn"]["status"].as_str().unwrap_or("interrupted");
                self.record(json!({"kind":"finished","status":status,"turnId":p["turn"]["id"]}), true)?;
                let mut memory = self.lock()?;
                memory.busy = false;
                memory.active_request = None;
                if status == "failed" {
                    memory.error = Some("model_turn_failed".into());
                }
            }
            "thread/compacted" => {
                let mut memory=self.lock()?;
                if memory.manual_compaction && memory.active_request.is_none() {
                    memory.manual_compaction=false;memory.busy=false;
                }
            }
            "error" => {
                if p["willRetry"] != true {
                    self.lock()?.error = Some("provider_error".into());
                }
            }
            _ => {}
        }
        Ok(())
    }
}

fn native_profile(layout: &crate::provider_scope::ScopeLayout, model: &str, effort: &str) -> Value {
    let mut thread_config = json!({"model_reasoning_effort":effort,"default_permissions":PROFILE,
        "permissions":{(PROFILE):{"filesystem":layout.filesystem,"network":{"enabled":false}}},
        "shell_environment_policy":{"inherit":"none","ignore_default_excludes":false,"set":layout.shell_environment},
        "web_search":"live","skills":{"include_instructions":true,"bundled":{"enabled":false}},
        "history":{"persistence":"none"},"project_doc_max_bytes":0,"show_raw_agent_reasoning":false});
    // Reuse the exact qualified base feature configuration; enable only skill
    // catalog instructions, not plugins, extra agents or the old guardians.
    let defaults: BTreeMap<_, _> = crate::alma_local_profile::alma_local_cli_overrides(true)
        .into_iter()
        .collect();
    let features: serde_json::Map<String, Value> = defaults
        .into_iter()
        .filter_map(|(k, v)| {
            k.strip_prefix("features.")
                .map(|name| (name.to_string(), serde_json::to_value(v).unwrap()))
        })
        .collect();
    thread_config["features"] = Value::Object(features);
    // The old qualification profile denies all plugin IDs. The SDK also denies
    // standalone skills when ancestor ownership probes are unavailable under
    // that policy. Admit only this App-owned capability root; the Plugins feature,
    // all other plugin IDs and private filesystem paths remain disabled.
    thread_config[format!("plugins.{CAPABILITY}.enabled")] = json!(true);
    json!({"permissionProfileID":PROFILE,"modelID":model,"reasoningEffortID":effort,"threadConfig":thread_config})
}
