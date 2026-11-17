use crate::session_agent_store::Conversation;
use crate::session_agent_zcode_events::{ZcodeEvents, POLICY};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn event(id: &str, kind: &str, payload: Value) -> Value {
    json!({"id":id,"type":kind,"sessionId":"sess-native","turnId":"native-turn","payload":payload})
}
fn setup() -> (ZcodeEvents, Conversation) {
    let mut p=ZcodeEvents::new("alma-turn");p.set_session("sess-native");
    let mut c=Conversation::default();c.apply(&json!({"kind":"user","id":"u","text":"review"}));
    c.apply(&json!({"kind":"started","turnId":"alma-turn"}));(p,c)
}
fn accept(p: &mut ZcodeEvents,c: &mut Conversation,e: Value) -> Vec<Value> {
    let rows=p.accept(&e).unwrap();for row in &rows {c.apply(row);}rows
}

#[test]
fn actual_public_text_is_forwarded_with_tool_rounds_and_final_is_not_duplicated() {
    let (mut p,mut c)=setup();
    let text="我先检索几个关键专名再动手修正。";
    let e=event("model-1","model_complete",json!({"content":text,"toolCallCount":1,"querySource":"main_turn","reasoning":"PRIVATE_REASONING"}));
    accept(&mut p,&mut c,e.clone());assert!(accept(&mut p,&mut c,e).is_empty());
    accept(&mut p,&mut c,event("message-1","assistant_message",json!({"content":text})));
    assert_eq!(c.messages.iter().filter(|m|m.role=="assistant").count(),1);
    assert_eq!(c.messages.last().unwrap().phase.as_deref(),Some("commentary"));
    accept(&mut p,&mut c,event("tool","tool_call_started",json!({"toolCallId":"tool1","toolName":"Read"})));
    accept(&mut p,&mut c,event("model-2","model_complete",json!({"content":"Done","toolCallCount":0,"querySource":"main_turn"})));
    accept(&mut p,&mut c,event("message-2","assistant_message",json!({"content":"Done"})));
    accept(&mut p,&mut c,event("final","turn_complete",json!({"response":"Done","resultType":"success"})));
    assert_eq!(c.messages.iter().filter(|m|m.role=="assistant").count(),2);
    assert_eq!(c.messages.last().unwrap().phase.as_deref(),Some("final_answer"));
    assert_eq!(c.status,"running","SDK text cannot finish the host before cleanup");
    assert_eq!(p.terminal(&json!({"outcome":{"kind":"completed"},"sdkClosed":true})).unwrap(),"completed");
    assert!(p.terminal(&json!({"outcome":{"kind":"completed"},"sdkClosed":false})).is_err());
}

#[test]
fn same_text_in_distinct_tool_rounds_is_not_accidentally_deduplicated() {
    let (mut p,mut c)=setup();
    for i in 0..2 {
        accept(&mut p,&mut c,event(&format!("m{i}"),"model_complete",json!({"content":"继续检查。","toolCallCount":1})));
        accept(&mut p,&mut c,event(&format!("t{i}"),"tool_call_started",json!({"toolCallId":format!("call{i}"),"toolName":"Read"})));
    }
    assert_eq!(c.messages.iter().filter(|m|m.role=="assistant").count(),2);
}

#[test]
fn older_model_complete_without_count_waits_for_tool_or_final_boundary() {
    let (mut p,mut c)=setup();
    assert!(accept(&mut p,&mut c,event("m","model_complete",json!({"content":"Read next."}))).is_empty());
    accept(&mut p,&mut c,event("tool","tool_call_scheduled",json!({"toolCallId":"t","toolName":"Read","input":{"file_path":"transcript.md"}})));
    assert_eq!(c.messages.last().unwrap().phase.as_deref(),Some("commentary"));
    assert!(c.messages.last().unwrap().sequence<c.activities[0].sequence);
}

#[test]
fn warnings_retries_compaction_and_errors_are_public_but_private_bodies_are_not() {
    let (mut p,mut c)=setup();let mut output=Vec::new();
    for (id,kind,payload) in [
        ("q","model_network_status",json!({"type":"model_request_queued"})),
        ("r","model_network_status",json!({"type":"model_retry_scheduled","attempt":2})),
        ("c","compact_started",json!({"summary":"PRIVATE_SUMMARY"})),
        ("d","compact_completed",json!({"summary":"PRIVATE_SUMMARY"})),
        ("w","model_anomaly_warning",json!({"category":"repeated_tool_call"})),
        ("s","model_streaming",json!({"kind":"reasoning_delta","delta":"PRIVATE_REASONING"})),
        ("req","model_request",json!({"prompt":"PRIVATE_PROMPT"})),
        ("err","turn_error",json!({"error":{"code":"model_rate_limited","message":"PRIVATE_ERROR"}})),
    ] {output.extend(accept(&mut p,&mut c,event(id,kind,payload)));}
    assert!(!serde_json::to_string(&output).unwrap().contains("PRIVATE_"));
    assert!(c.activities.iter().any(|a|a.kind=="retrying"));
    assert!(c.activities.iter().any(|a|a.kind=="compacting"&&a.status=="completed"));
    assert!(c.activities.iter().any(|a|a.text=="zcode_rate_limited"));
    assert_eq!(c.status,"running");
    assert_eq!(p.terminal(&json!({"outcome":{"kind":"failed"},"sdkClosed":true})).unwrap_err(),"zcode_rate_limited");
}

#[test]
fn cancellation_and_partial_answers_do_not_become_success() {
    let (mut p,mut c)=setup();
    accept(&mut p,&mut c,event("cancelled","turn_complete",json!({"response":"Partial text","resultType":"cancelled"})));
    assert_eq!(c.messages.last().unwrap().phase.as_deref(),Some("partial_answer"));
    assert_eq!(p.terminal(&json!({"outcome":{"kind":"failed"},"sdkClosed":true})).unwrap(),"cancelled");
    assert!(p.terminal(&json!({"outcome":{"kind":"failed","failure":{"family":"cleanup"}},"sdkClosed":false})).is_err());
}

#[test]
fn audit_policy_covers_every_pinned_official_event() {
    let policy:Value=serde_json::from_str(POLICY).unwrap();
    let mut known=BTreeSet::new();
    for group in policy["groups"].as_array().unwrap() {
        assert!(!group["reason"].as_str().unwrap().is_empty());
        for event in group["events"].as_array().unwrap() {assert!(known.insert(event.as_str().unwrap().to_owned()));}
    }
    let source=include_str!("../../../../ALMA-ZCode/apps/zcode-cli/packages/contracts/src/events/session.events.ts");
    let body=source.split("export const SessionEventType").nth(1).unwrap().split("} as const").next().unwrap();
    let official:BTreeSet<String>=body.lines().filter_map(|line| {
        let line=line.trim();if line.starts_with("//") {return None;}
        let (_,value)=line.split_once(": \"")?;Some(value.split('"').next()?.to_owned())
    }).collect();
    assert_eq!(known,official,"Review new SDK events deliberately before upgrading the pin");
}
