fn item(phase: Option<MessagePhase>) -> p::ThreadItem {
    p::ThreadItem::untimed(p::ThreadItemPayload::AgentMessage { id:"answer".into(), text:"final".into(), phase,
        memory_citation:None, delivery:None, questions:None })
}
fn turn(status:p::TurnStatus) -> p::Turn {
    p::Turn { id:"turn".into(),root_turn_id:None,items:vec![item(Some(MessagePhase::FinalAnswer))],
        items_view:p::TurnItemsView::Full,status,error:None,started_at:None,completed_at:None,duration_ms:None }
}
#[test] fn final_phase_is_required() {
    assert!(final_message(&item(None)).is_none());
    assert!(final_message(&item(Some(MessagePhase::Commentary))).is_none());
    assert_eq!(final_message(&item(Some(MessagePhase::FinalAnswer))),Some(("answer","final")));
}
#[test] fn interrupted_without_error_is_not_rewritten() {
    let n=p::ServerNotification::TurnCompleted(p::TurnCompletedNotification {thread_id:"thread".into(),turn:turn(p::TurnStatus::Interrupted)});
    let (v,_)=frame(n,"thread","turn",MAX_EVENTS).unwrap().unwrap();
    assert_eq!(v["params"]["turn"]["status"],"interrupted");
    assert_eq!(v["kind"],"notification");
    assert!(v["params"]["turn"]["error"].is_null());
}
#[test] fn wrong_thread_and_turn_are_excluded() {
    for (thread,turn_id) in [("other","turn"),("thread","other")] {
        let n=p::ServerNotification::TurnCompleted(p::TurnCompletedNotification {thread_id:"thread".into(),turn:turn(p::TurnStatus::Completed)});
        assert!(frame(n,thread,turn_id,MAX_EVENTS).unwrap().is_none());
    }
}
#[test] fn reasoning_is_removed_from_terminal_items() {
    let reasoning:p::ThreadItem=serde_json::from_value(json!({"type":"reasoning","id":"private","summary":[],"content":["PRIVATE"]})).unwrap();
    let mut t=turn(p::TurnStatus::Completed);t.items.push(reasoning);
    let n=p::ServerNotification::TurnCompleted(p::TurnCompletedNotification {thread_id:"thread".into(),turn:t});
    let (v,_)=frame(n,"thread","turn",MAX_EVENTS).unwrap().unwrap();
    assert!(!v.to_string().contains("PRIVATE"));
    assert_eq!(v["params"]["turn"]["items"].as_array().unwrap().len(),1);
}
#[test] fn raw_reasoning_delta_is_excluded() {
    let n:p::ServerNotification=serde_json::from_value(json!({"method":"item/reasoning/textDelta","params":{
        "threadId":"thread","turnId":"turn","itemId":"private","contentIndex":0,"delta":"PRIVATE"}})).unwrap();
    assert!(frame(n,"thread","turn",MAX_EVENTS).unwrap().is_none());
}
#[test] fn reroute_fails_closed() {
    let n:p::ServerNotification=serde_json::from_value(json!({"method":"model/rerouted","params":{
        "threadId":"thread","turnId":"turn","fromModel":"original","toModel":"other","reason":"highRiskCyberActivity"}})).unwrap();
    assert_eq!(frame(n,"thread","turn",MAX_EVENTS).unwrap_err(),"unexpected_scoped_notification");
}
#[test] fn json_byte_bound_is_enforced() {
    assert!(bounded(&"123",4).is_err());assert_eq!(bounded(&"123",5).unwrap().1,5);
}
#[test] fn fingerprint_requires_lowercase_sha256() {
    assert!(digest(&"a".repeat(64)));assert!(!digest(&"A".repeat(64)));assert!(!digest("account-id"));
}
#[test] fn quota_excludes_identity_and_unrecognized_nested_fields() {
    let raw=json!({"rateLimits":{"email":"PRIVATE"},"accountId":"PRIVATE",
        "rateLimitUpsell":{"email":"PRIVATE"},"ordinaryUsageAllowed":true});
    let quota=quota_observation(raw).unwrap();
    assert_eq!(quota["ordinaryUsageAllowed"],true);
    assert!(!quota.to_string().contains("PRIVATE"));
    assert!(quota.get("accountId").is_none());
}
