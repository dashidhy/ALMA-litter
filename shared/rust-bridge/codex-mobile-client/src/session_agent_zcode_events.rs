//! Public event projection for the pinned ZCode SDK. No provider prompts,
//! reasoning bodies or compaction summaries cross this boundary.
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const POLICY: &str = include_str!("../../../session-agent/zcode-event-policy.json");

#[derive(Clone)]
struct PublicMessage { id: String, text: String, origin: String, tools_since: bool }

pub struct ZcodeEvents {
    turn: String,
    session: Option<String>,
    native_turn: Option<String>,
    policy: BTreeMap<String, String>,
    seen: BTreeSet<String>,
    unknown: BTreeSet<String>,
    last_message: Option<PublicMessage>,
    pending_final: Option<PublicMessage>,
    notices: BTreeMap<String, (String, String)>,
    pub result_type: Option<String>,
    pub failure: Option<String>,
}

impl ZcodeEvents {
    pub fn new(turn: &str) -> Self {
        let policy: Value = serde_json::from_str(POLICY).expect("reviewed event policy");
        let policy = policy["groups"].as_array().unwrap().iter().flat_map(|group| {
            group["events"].as_array().unwrap().iter().map(|event|
                (event.as_str().unwrap().to_owned(),group["handling"].as_str().unwrap().to_owned()))
        }).collect();
        Self {turn:turn.into(), session:None, native_turn:None, policy, seen:BTreeSet::new(),unknown:BTreeSet::new(),
            last_message:None,pending_final:None,notices:BTreeMap::new(),result_type:None,failure:None}
    }
    pub fn set_session(&mut self, id: &str) { self.session=Some(id.into()); }

    fn message(&mut self, id: String, text: &str, origin: &str, phase: &str) -> Vec<Value> {
        if text.trim().is_empty() {return vec![];}
        let previous=self.last_message.as_ref().filter(|m|!m.tools_since && m.text==text && m.origin!=origin);
        let id=previous.map(|m|m.id.clone()).unwrap_or(id);
        self.last_message=Some(PublicMessage{id:id.clone(),text:text.into(),origin:origin.into(),tools_since:false});
        vec![json!({"kind":"assistant","id":id,"turnId":self.turn,"text":text,"phase":phase,"complete":true})]
    }
    fn notice(&mut self, key: &str, kind: &str, text: &str, status: &str) -> Vec<Value> {
        if self.notices.get(key).is_some_and(|(old, state)|old==text&&state==status) {return vec![];}
        self.notices.insert(key.into(),(text.into(),status.into()));
        vec![json!({"kind":"activity","activity":{"id":format!("{}:status:{key}",self.turn),"turnId":self.turn,"kind":kind,"text":text,"status":status}})]
    }
    fn settle_waits(&mut self) -> Vec<Value> {
        let mut result=Vec::new();
        for kind in ["queued","retrying"] {
            if let Some((text,status))=self.notices.get(kind).cloned() {
                if status=="running" {result.extend(self.notice(kind,kind,&text,"completed"));}
            }
        }
        result
    }

    pub fn accept(&mut self, event: &Value) -> Result<Vec<Value>, &'static str> {
        let kind=event["type"].as_str().ok_or("zcode_event_invalid")?;
        let Some(handling)=self.policy.get(kind) else {
            return Ok(if self.unknown.insert(kind.into()) {vec![json!({"kind":"provider_event_unmapped","provider":"zcode","eventType":safe_tag(kind),"turnId":self.turn})]} else {vec![]});
        };
        if handling=="sdk_owned" || handling=="disabled" {return Ok(vec![]);}
        if kind=="model_complete" && event["payload"]["querySource"].as_str().is_some_and(|s|s!="main_turn") {return Ok(vec![]);}
        if self.session.as_deref().is_some_and(|id|event["sessionId"].as_str()!=Some(id)) {return Err("zcode_event_session_mismatch");}
        if kind=="turn_started" {
            let id=event["turnId"].as_str().ok_or("zcode_turn_identity_missing")?;
            if self.native_turn.as_deref().is_some_and(|old|old!=id) {return Err("zcode_event_turn_mismatch");}
            self.native_turn=Some(id.into());
        } else if event["turnId"].as_str().is_some_and(|id|self.native_turn.as_deref().is_some_and(|old|old!=id)) {return Err("zcode_event_turn_mismatch");}
        let id=event["id"].as_str().filter(|s|!s.is_empty()).ok_or("zcode_event_id_missing")?;
        if !self.seen.insert(id.into()) {return Ok(vec![]);}
        let p=&event["payload"];
        let message_id=format!("{}:{id}",self.turn);
        let mut out=Vec::new();
        match kind {
            "turn_started" => out.push(json!({"kind":"provider_turn_started","provider":"zcode","nativeTurnId":self.native_turn,"turnId":self.turn})),
            "model_complete" => {
                // A compaction/subagent model response is not an assistant reply.
                if p["querySource"].as_str().is_some_and(|s|s!="main_turn") {return Ok(out);}
                out.extend(self.settle_waits());
                let text=p["content"].as_str().ok_or("zcode_model_content_invalid")?;
                if p["toolCallCount"].as_u64().unwrap_or(0)>0 {
                    out.extend(self.message(message_id,text,kind,"commentary"));
                } else if !text.trim().is_empty() {
                    self.pending_final=Some(PublicMessage{id:message_id,text:text.into(),origin:kind.into(),tools_since:false});
                }
            }
            "assistant_message" => {
                let text=p["content"].as_str().ok_or("zcode_message_content_invalid")?;
                if !self.pending_final.as_ref().is_some_and(|m|m.text==text) {
                    out.extend(self.message(message_id,text,kind,"commentary"));
                }
            }
            "turn_complete" => {
                let result=p["resultType"].as_str().ok_or("zcode_turn_result_missing")?;
                self.result_type=Some(result.into());
                if result!="success" && result!="cancelled" {self.failure=Some(if result.starts_with("error_max_"){"zcode_resource_limit"}else{"zcode_provider_unavailable"}.into());}
                let text=p["response"].as_str().unwrap_or("");
                let message=self.pending_final.take().filter(|m|m.text==text);
                out.extend(self.message(message.map(|m|m.id).unwrap_or(message_id),text,kind,if result=="success"{"final_answer"}else{"partial_answer"}));
                out.extend(self.settle_waits());
            }
            "tool_call_scheduled"|"tool_call_started"|"tool_call_progress"|"tool_call_result"|"tool_call_error" => {
                let tool_id=p["toolCallId"].as_str().ok_or("zcode_tool_identity_missing")?;
                if matches!(kind,"tool_call_scheduled"|"tool_call_started") {
                    if let Some(message)=self.pending_final.take() {
                        out.extend(self.message(message.id,&message.text,"model_complete","commentary"));
                    }
                }
                if let Some(message)=&mut self.last_message {message.tools_since=true;}
                out.push(json!({"kind":"native_public_event","provider":"zcode","turnId":self.turn,"event":event}));
                let status=if matches!(kind,"tool_call_scheduled"|"tool_call_started"|"tool_call_progress") {"running"}
                    else if kind=="tool_call_error"||p["result"]["success"]==false {"failed"} else {"completed"};
                out.push(json!({"kind":"activity","activity":{"id":tool_id,"turnId":self.turn,"kind":p["toolName"].as_str().unwrap_or(kind),"text":p.to_string(),"status":status}}));
            }
            "model_network_status" => {
                match p["type"].as_str().unwrap_or("") {
                    "model_request_queued" => out.extend(self.notice("queued","queued","Waiting for Provider","running")),
                    "model_retry_scheduled"|"model_retry_started" => out.extend(self.notice("retrying","retrying","Provider is retrying the model request","running")),
                    "model_request_started" if p["attempt"].as_u64().unwrap_or(1)>1 => out.extend(self.notice("retrying","retrying","Provider is retrying the model request","running")),
                    "model_request_completed" => out.extend(self.settle_waits()),
                    _ => {}
                }
            }
            "compact_started" => out.extend(self.notice("compact","compacting","Compacting context","running")),
            "compact_completed"|"compact_boundary"|"session_compacted" => out.extend(self.notice("compact","compacting","Context compacted","completed")),
            "compact_failed" => out.extend(self.notice("compact","compacting","Context compaction did not complete","failed")),
            "model_anomaly_warning" => out.extend(self.notice(&format!("warning:{id}"),"provider_notice",&format!("Provider warning: {}",safe_tag(p["category"].as_str().unwrap_or("model_warning"))),"completed")),
            "model_error"|"turn_error"|"error" => {
                let code=error_code(p);
                if kind=="turn_error" {self.failure=Some(code.into());}
                out.extend(self.notice(if kind=="model_error"{"model-error"}else{"turn-error"},"provider_notice",code,"failed"));
            }
            "model_selected" => out.push(json!({"kind":"inference_observed","provider":"zcode","turnId":self.turn,
                "selection":p.get("modelSelection").map(selection).unwrap_or(Value::Null),"effectiveReasoningLevel":p["effectiveReasoningLevel"]})),
            "turn_execution_model_fallback" => {
                out.push(json!({"kind":"inference_observed","provider":"zcode","turnId":self.turn,"selection":selection(&p["toModelSelection"])}));
                out.extend(self.notice("model-fallback","provider_notice","Provider changed the execution model for this turn","completed"));
            }
            "stream_recovery_started"|"stream_recovery_retry_started" => out.extend(self.notice("stream-recovery","retrying","Provider is recovering the response stream","running")),
            "stream_recovery_blocked" => out.extend(self.notice("stream-recovery","provider_notice","Provider could not recover the response stream","failed")),
            "permission_requested"|"permission_resolved"|"permission_denied" => {
                let key=format!("permission:{}",p["toolCallId"].as_str().unwrap_or(id));
                let (text,status)=match kind {"permission_requested"=>("Provider is checking tool permission","running"),"permission_denied"=>("Tool permission denied","failed"),_=>("Tool permission check finished","completed")};
                out.extend(self.notice(&key,"provider_notice",text,status));
            }
            "interrupt"|"cancel" => out.extend(self.notice("interruption","provider_notice","Provider is stopping the turn","running")),
            "system_message" if p["type"]=="interrupted" => out.extend(self.notice("interruption","provider_notice","Provider interrupted the turn","completed")),
            _ => {}
        }
        Ok(out)
    }

    /// SDK completion does not bypass transport/cleanup failures.
    pub fn terminal(&self, native: &Value) -> Result<&'static str, String> {
        let outcome=&native["outcome"];
        if native["sdkClosed"]==false || outcome["failure"]["family"]=="cleanup" {return Err("zcode_cleanup_failed".into());}
        if outcome["kind"]=="cancelled" || self.result_type.as_deref()==Some("cancelled") || self.failure.as_deref()==Some("zcode_cancelled") {return Ok("cancelled");}
        if let Some(code)=&self.failure {return Err(code.clone());}
        if outcome["kind"]=="completed" && self.result_type.as_deref()==Some("success") {return Ok("completed");}
        Err(outcome["failure"]["code"].as_str().map(safe_tag).unwrap_or_else(||"zcode_turn_incomplete".into()))
    }
}

fn selection(value: &Value) -> Value { json!({"providerId":value["providerId"],"modelId":value["modelId"],"reasoningLevel":value["options"]["reasoningLevel"]}) }
fn safe_tag(value: &str) -> String {value.chars().filter(|c|c.is_ascii_alphanumeric()||['_','-','.'].contains(c)).take(100).collect()}
fn error_code(payload: &Value) -> &'static str {
    let error=payload.get("error").unwrap_or(payload);
    let reason=error["attribution"]["reason"].as_str().unwrap_or("");
    let code=error["code"].as_str().or(error["type"].as_str()).unwrap_or("");
    if matches!(reason,"auth_failed") || code=="model_request_auth_missing" {"zcode_auth_failed"}
    else if matches!(reason,"rate_limited"|"offpeak_queued") || code=="model_rate_limited" {"zcode_rate_limited"}
    else if reason=="context_exceeded" || code=="model_context_exceeded" {"zcode_context_exceeded"}
    else if reason=="cancelled" || matches!(code,"cancelled"|"turn_cancelled"|"model_request_cancelled") {"zcode_cancelled"}
    else if matches!(code,"tool_max_calls"|"storage_error") {"zcode_resource_limit"}
    else if matches!(reason,"provider_not_configured"|"invalid_request") || matches!(code,"invalid_model_selection"|"model_config_missing"|"provider_not_found"|"provider_not_configured"|"model_not_found"|"invalid_model_request"|"configuration_error") {"zcode_configuration_invalid"}
    else {"zcode_provider_unavailable"}
}
