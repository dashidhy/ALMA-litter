//! Phone observations only. Original Mac TAH owns normalization, acceptance and publication.
use crate::session::connection::{ServerEvent, ServerSession};
use crate::tah_attempt::TahQualificationInfo;
use codex_app_server_protocol as p;
use codex_protocol::{models::MessagePhase, openai_models::ReasoningEffort};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{collections::HashSet, io::Write, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration};
use tokio::time::{Instant, timeout, timeout_at};

const MAX_EVENTS: usize = 10 * 1024 * 1024;
static ATTEMPT_USED: AtomicBool = AtomicBool::new(false);
type Result<T> = std::result::Result<T, &'static str>;
fn id() -> p::RequestId { p::RequestId::Integer(crate::next_request_id()) }
fn digest(s: &str) -> bool { s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn identifier(s: &str) -> bool {
    !s.is_empty() && s.len() <= 256 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b))
}
fn context(server: &str, fingerprint: &str) -> Result<(&'static TahQualificationInfo, Arc<ServerSession>)> {
    let info = &crate::tah_attempt::current().ok_or("attempt_missing")?.info;
    if !digest(fingerprint) || fingerprint != info.expected_account_fingerprint
        || !digest(&info.attempt_sha256) || !digest(&info.profile_digest)
        || !identifier(&info.model) || info.maximum_final_bytes == 0 || info.maximum_final_bytes > 65536 {
        return Err("identity_or_manifest_invalid");
    }
    let session = crate::ffi::shared::shared_mobile_client().get_session(server).map_err(|_| "session_missing")?;
    if !session.config().is_local || session.config().server_id != server || session.runtime_kinds() != ["codex"] {
        return Err("local_codex_session_required");
    }
    Ok((info, session))
}
fn identity(info: &TahQualificationInfo, fingerprint: &str) -> Value {
    json!({"runID":info.run_id,"challenge":info.challenge,"attemptID":info.attempt_id,
        "attemptSHA256":info.attempt_sha256,"expectedAccountFingerprint":info.expected_account_fingerprint,
        "actualAccountFingerprint":fingerprint,"profileDigest":info.profile_digest,"role":info.role})
}
// Limit serialization before allocating the complete JSON representation.
struct Bounded(Vec<u8>, usize);
impl Write for Bounded {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.1.saturating_sub(self.0.len()) { return Err(std::io::Error::other("limit")); }
        self.0.extend_from_slice(bytes); Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}
fn bounded<T: Serialize>(value: &T, limit: usize) -> Result<(Value, usize)> {
    let mut writer = Bounded(Vec::new(), limit);
    serde_json::to_writer(&mut writer, value).map_err(|_| "observation_limit")?;
    let value = serde_json::from_slice(&writer.0).map_err(|_| "invalid_observation")?;
    Ok((value, writer.0.len()))
}
async fn rpc<T: DeserializeOwned>(session: &ServerSession, request: p::ClientRequest) -> Result<T> {
    // Direct session API: do not use MobileClient's model-selection normalization.
    let value = session.request_client(request).await.map_err(|_| "rpc_failed")?;
    serde_json::from_value(value).map_err(|_| "capability_or_response_invalid")
}
fn quota_observation(raw: Value) -> Result<Value> {
    let parsed: p::GetAccountRateLimitsResponse = serde_json::from_value(raw).map_err(|_| "quota_invalid")?;
    // Preserve original wire quota fields consumed by the Mac usage normalizer.
    // accountId, reset-credit IDs and opaque upsell content are deliberately absent.
    let quota = json!({"rateLimits":parsed.rate_limits,"rateLimitsByLimitId":parsed.rate_limits_by_limit_id,
        "ordinaryUsageAllowed":parsed.ordinary_usage_allowed});
    Ok(bounded(&quota, 1024 * 1024)?.0)
}
async fn inspect_session(session: &ServerSession, info: Option<&TahQualificationInfo>) -> Result<Value> {
    let account: p::GetAccountResponse = rpc(session, p::ClientRequest::GetAccount {
        request_id: id(), params: p::GetAccountParams { refresh_token: false },
    }).await?;
    if !matches!(account.account, Some(p::Account::Chatgpt { .. })) { return Err("chatgpt_account_required"); }
    let mut cursor = None; let mut seen = HashSet::new(); let mut models = Vec::new();
    let mut selected = info.is_none(); let mut defaults = 0;
    for page_index in 0..8 {
        let page: p::ModelListResponse = rpc(session, p::ClientRequest::ModelList {
            request_id: id(), params: p::ModelListParams { cursor, limit: Some(128), include_hidden: Some(false) },
        }).await?;
        if page.data.len() > 128 { return Err("catalog_limit"); }
        for model in page.data {
            if model.hidden || !identifier(&model.id) || !identifier(&model.model) || !seen.insert(model.id.clone())
                || model.supported_reasoning_efforts.is_empty() || model.supported_reasoning_efforts.len() > 32 {
                return Err("catalog_invalid");
            }
            let efforts: Vec<_> = model.supported_reasoning_efforts.iter().map(|e| e.reasoning_effort.as_str()).collect();
            if !efforts.contains(&model.default_reasoning_effort.as_str()) || efforts.iter().any(|e| !identifier(e)) {
                return Err("catalog_efforts_invalid");
            }
            defaults += usize::from(model.is_default);
            if let Some(info)=info.filter(|info|model.model==info.model) {
                if selected || info.reasoning_effort.as_deref().is_some_and(|e| !efforts.contains(&e)) {
                    return Err("requested_effort_unavailable");
                }
                selected = true;
            }
            models.push(json!({"id":model.id,"model":model.model,"displayName":model.display_name,"isDefault":model.is_default,
                "effortDescriptions":model.supported_reasoning_efforts.iter().map(|e|json!({"handle":e.reasoning_effort,"displayName":e.description})).collect::<Vec<_>>(),
                "defaultReasoningEffort":model.default_reasoning_effort,"supportedReasoningEfforts":efforts}));
        }
        cursor = page.next_cursor;
        if cursor.is_none() { break; }
        if page_index == 7 { return Err("catalog_pagination_limit"); }
    }
    if !selected || defaults > 1 || models.is_empty() { return Err("requested_model_or_default_unavailable"); }
    let raw: Value = rpc(session, p::ClientRequest::GetAccountRateLimits { request_id: id(), params: None }).await?;
    Ok(json!({"validChatGPT":true,"models":models,"rawQuotaResponse":quota_observation(raw)?}))
}
/// Actual inspection observations, never an AuthInspectionSucceeded receipt.
pub(crate) async fn inspect(server_id: String, actual_account_fingerprint: String) -> Value {
    let (info, session) = match context(&server_id, &actual_account_fingerprint) {
        Ok(value) => value, Err(code) => return json!({"outcome":"failure","failure":code}),
    };
    match timeout(Duration::from_secs(30), inspect_session(&session, Some(info))).await {
        Ok(Ok(observations)) => json!({"outcome":"observed","identity":identity(info,&actual_account_fingerprint),"inspection":observations}),
        Ok(Err(code)) => json!({"outcome":"failure","failure":code}),
        Err(_) => json!({"outcome":"failure","failure":"inspection_timeout"}),
    }
}

/// Initial read-only discovery before the host can bind its first manifest.
/// The actual fingerprint is supplied by the same-App trusted OAuth owner.
pub(crate) async fn discover(server_id:String,fingerprint:String) -> Value {
    if !digest(&fingerprint) {return json!({"outcome":"failure","failure":"fingerprint_invalid"});}
    let client=crate::ffi::shared::shared_mobile_client();
    let session=match client.get_session(&server_id) {
        Ok(s) if s.config().is_local && s.runtime_kinds()==["codex"] =>s,
        _=>return json!({"outcome":"failure","failure":"local_codex_session_required"}),
    };
    match timeout(Duration::from_secs(30),inspect_session(&session,None)).await {
        Ok(Ok(inspection))=>json!({"outcome":"observed","actualAccountFingerprint":fingerprint,"inspection":inspection}),
        Ok(Err(code))=>json!({"outcome":"failure","failure":code}),
        Err(_)=>json!({"outcome":"failure","failure":"inspection_timeout"}),
    }
}
fn private_item(item: &p::ThreadItem) -> bool { matches!(item.payload, p::ThreadItemPayload::Reasoning { .. }) }
fn final_message(item: &p::ThreadItem) -> Option<(&str, &str)> {
    match &item.payload {
        p::ThreadItemPayload::AgentMessage { id, text, phase: Some(MessagePhase::FinalAnswer), .. } => Some((id, text)),
        _ => None,
    }
}
// Keep native method/params; only remove private reasoning. No TAH event projection.
fn frame(mut notification: p::ServerNotification, thread: &str, turn: &str, remaining: usize) -> Result<Option<(Value, usize)>> {
    use p::ServerNotification as N;
    let method = notification.to_string();
    if method.starts_with("account/") || method.starts_with("item/reasoning/")
        || method.starts_with("rawResponse") || method == "thread/tokenUsage/updated" || method == "thread/started" {
        return Ok(None);
    }
    match &mut notification {
        N::ItemStarted(n) if private_item(&n.item) => return Ok(None),
        N::ItemCompleted(n) if private_item(&n.item) => return Ok(None),
        N::TurnStarted(n) => n.turn.items.retain(|item| !private_item(item)),
        N::TurnCompleted(n) => n.turn.items.retain(|item| !private_item(item)),
        _ => {},
    }
    let (mut value, _) = bounded(&notification, remaining)?;
    let params = &value["params"];
    if params["threadId"].as_str() != Some(thread) { return Ok(None); }
    let event_turn = params["turnId"].as_str().or_else(|| params["turn"]["id"].as_str());
    if event_turn.is_some_and(|id| id != turn) { return Ok(None); }
    if !matches!(method.as_str(), "turn/started" | "turn/completed" | "item/started" | "item/completed"
        | "item/agentMessage/delta" | "thread/status/changed" | "error" | "turn/plan/updated" | "item/plan/delta"
        | "item/commandExecution/outputDelta" | "item/commandExecution/terminalInteraction"
        | "item/fileChange/outputDelta" | "item/fileChange/patchUpdated" | "turn/diff/updated" | "thread/compacted") {
        if !matches!(method.as_str(), "turn/moderationMetadata" | "model/safetyBuffering/updated" | "warning" | "deprecationNotice") {
            return Err("unexpected_scoped_notification");
        }
    }
    if event_turn.is_none() && !matches!(method.as_str(), "thread/status/changed" | "thread/compacted" | "warning" | "deprecationNotice") {
        return Err("notification_turn_missing");
    }
    value.as_object_mut().ok_or("notification_invalid")?.insert("kind".into(), json!("notification"));
    Ok(Some(bounded(&value, remaining)?))
}
/// One attempted submission per app process, including failures. No file capture or process-exit claims.
pub(crate) async fn run(server_id: String, actual_account_fingerprint: String) -> Value {
    let deadline = Instant::now() + Duration::from_secs(180);
    let (info, session) = match context(&server_id, &actual_account_fingerprint) {
        Ok(value) => value, Err(code) => return json!({"outcome":"failure","failure":code}),
    };
    if ATTEMPT_USED.swap(true, Ordering::SeqCst) { return json!({"outcome":"failure","failure":"attempt_already_used"}); }
    let mut rx = session.events(); // Before inspection, thread/start and turn/start.
    let mut thread_id = String::new(); let mut turn_id = String::new();
    let mut report = json!({"outcome":"failure","identity":identity(info,&actual_account_fingerprint),
        "notifications":[],"cancellation":{"requested":false,"acknowledged":false}});
    let result: Result<()> = timeout_at(deadline - Duration::from_secs(5), async {
        report["inspection"] = inspect_session(&session, Some(info)).await?;
        let effort: Option<ReasoningEffort> = info.reasoning_effort.as_ref().map(|s| serde_json::from_value(json!(s)))
            .transpose().map_err(|_| "effort_invalid")?;
        let config = effort.as_ref().map(|e| [("model_reasoning_effort".into(), json!(e))].into_iter().collect());
        let response: p::ThreadStartResponse = rpc(&session, p::ClientRequest::ThreadStart {
            request_id: id(), params: p::ThreadStartParams {
                model: Some(info.model.clone()), allow_provider_model_fallback: false, ephemeral: Some(true),
                developer_instructions: Some(info.developer_instructions.clone()), cwd: Some(info.guest_cwd.clone()),
                config, ..Default::default()
            },
        }).await?;
        thread_id = response.thread.id.clone();
        report["threadReceipt"] = json!({"threadID":thread_id,"model":response.model,"reasoningEffort":response.reasoning_effort,
            "ephemeral":response.thread.ephemeral,"cwd":response.cwd});
        if !identifier(&thread_id) || response.model != info.model || !response.thread.ephemeral
            || response.cwd.as_path() != std::path::Path::new(&info.guest_cwd)
            // Match original Mac receipts.ts: null selects native defaults and
            // does not require the server to materialize them in its receipt.
            || info.reasoning_effort.as_deref().is_some_and(|requested|
                response.reasoning_effort.as_ref().map(ReasoningEffort::as_str)!=Some(requested)) {
            return Err("thread_receipt_mismatch");
        }
        let started: p::TurnStartResponse = rpc(&session, p::ClientRequest::TurnStart {
            request_id: id(), params: p::TurnStartParams {
                thread_id: thread_id.clone(), model: Some(info.model.clone()), effort,
                input: vec![p::UserInput::Text { text: info.turn_input_text.clone(), text_elements: Vec::new() }],
                ..Default::default()
            },
        }).await?;
        turn_id = started.turn.id.clone();
        report["turnReceipt"] = json!({"turnID":turn_id,"status":started.turn.status,"errorPresent":started.turn.error.is_some()});
        if !identifier(&turn_id) || started.turn.status != p::TurnStatus::InProgress || started.turn.error.is_some() {
            return Err("turn_receipt_invalid");
        }
        let mut bytes = 2; let mut final_item: Option<(String, String)> = None;
        loop {
            let notification = match rx.recv().await.map_err(|_| "event_stream_lagged_or_closed")? {
                ServerEvent::Notification { runtime_kind, notification } if runtime_kind == "codex" => notification,
                _ => return Err("unexpected_server_request_or_stream"),
            };
            let terminal = match &notification {
                p::ServerNotification::ItemCompleted(n) if n.thread_id == thread_id && n.turn_id == turn_id => {
                    if let Some((id, text)) = final_message(&n.item) {
                        if final_item.is_some() || text.len() as u64 > info.maximum_final_bytes { return Err("final_answer_invalid"); }
                        final_item = Some((id.into(), text.into()));
                    }
                    None
                }
                p::ServerNotification::TurnCompleted(n) if n.thread_id == thread_id && n.turn.id == turn_id => Some(n.turn.clone()),
                _ => None,
            };
            let observed_method=notification.to_string();
            let framed=frame(notification, &thread_id, &turn_id, MAX_EVENTS - bytes).map_err(|code| {
                report["rejectedNotificationMethod"]=json!(observed_method);code
            })?;
            if let Some((value, size)) = framed {
                bytes += size + 1;
                if bytes > MAX_EVENTS || report["notifications"].as_array().unwrap().len() >= 8192 { return Err("event_limit"); }
                report["notifications"].as_array_mut().unwrap().push(value);
            }
            if let Some(turn) = terminal {
                report["terminal"] = json!({"status":turn.status,"errorPresent":turn.error.is_some()});
                if turn.status != p::TurnStatus::Completed || turn.error.is_some() { return Err("turn_not_completed"); }
                let finals: Vec<_> = turn.items.iter().filter_map(final_message).collect();
                if finals.len() != 1 || final_item.as_ref().map(|(id,text)| (id.as_str(),text.as_str())) != Some(finals[0]) {
                    return Err("final_answer_missing_or_mismatched");
                }
                report["terminal"]["finalText"] = json!(finals[0].1);
                // Inspect already-buffered tail events, without claiming quiescence.
                for _ in 0..256 {
                    let event = match rx.try_recv() {
                        Err(tokio::sync::broadcast::error::TryRecvError::Empty) => return Ok(()),
                        Ok(event) => event,
                        Err(_) => return Err("event_stream_lagged_or_closed"),
                    };
                    let ServerEvent::Notification { runtime_kind, notification } = event else {
                        return Err("unexpected_server_request_or_stream");
                    };
                    if runtime_kind != "codex" { return Err("unexpected_runtime"); }
                    if let Some((value, size)) = frame(notification, &thread_id, &turn_id, MAX_EVENTS - bytes)? {
                        // Only status updates are an admissible buffered tail here.
                        if value["method"] != "thread/status/changed" { return Err("semantic_output_after_completion"); }
                        bytes += size + 1;
                        if bytes > MAX_EVENTS { return Err("event_limit"); }
                        report["notifications"].as_array_mut().unwrap().push(value);
                    }
                }
                return Err("tail_event_limit");
            }
        }
    }).await.unwrap_or(Err("attempt_timeout"));
    if let Err(code) = result {
        report["failure"] = json!(code);
        // A timed-out turn/start may already have emitted its authoritative ID.
        for _ in 0..256 {
            let Ok(event) = rx.try_recv() else { break; };
            if let ServerEvent::Notification { runtime_kind, notification: p::ServerNotification::TurnStarted(n) } = event {
                if runtime_kind == "codex" && n.thread_id == thread_id && turn_id.is_empty() { turn_id = n.turn.id; }
            }
        }
        if !thread_id.is_empty() && !turn_id.is_empty() {
            report["cancellation"]["requested"] = json!(true);
            report["cancellation"]["threadID"] = json!(thread_id);
            report["cancellation"]["turnID"] = json!(turn_id);
            let cancelled = timeout_at(deadline, rpc::<p::TurnInterruptResponse>(&session, p::ClientRequest::TurnInterrupt {
                request_id: id(), params: p::TurnInterruptParams { thread_id, turn_id },
            })).await;
            report["cancellation"]["acknowledged"] = json!(matches!(cancelled, Ok(Ok(_))));
        } else { report["cancellation"]["unavailable"] = json!("authoritative_thread_or_turn_id_missing"); }
    } else { report["outcome"] = json!("observed"); }
    report
}
