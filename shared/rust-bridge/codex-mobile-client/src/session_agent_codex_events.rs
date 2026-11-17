use serde_json::{Value, json};
use crate::session_agent_store::Activity;

/// Additional public notifications. A maintenance completion must never end
/// the user's active turn; only turn/completed owns that transition.
pub fn auxiliary(event: &Value, active_turn: Option<&str>, activities: &[Activity]) -> Option<Value> {
    let method=event["method"].as_str()?;
    let p=&event["params"];
    if let (Some(active),Some(received))=(active_turn,p["turnId"].as_str()) {
        if active!=received {return None;}
    }
    let (kind,text,status)=match method {
        "item/reasoning/summaryTextDelta" => {
            let turn=active_turn?;
            let id=format!("{turn}:reasoning-summary:{}",p["itemId"].as_str()?);
            let previous=activities.iter().find(|a|a.id==id).map(|a|a.text.as_str()).unwrap_or("");
            let text=format!("{previous}{}",p["delta"].as_str()?);
            return Some(json!({"kind":"activity","activity":{"id":id,"kind":"reasoning_summary","turnId":turn,"text":text.chars().take(20000).collect::<String>(),"status":"completed"}}));
        }
        "thread/compacted" => ("compacting","Context compacted".to_owned(),"completed"),
        "turn/plan/updated" => {
            let steps=p["plan"].as_array()?;
            let text=steps.iter().take(64).filter_map(|step|step["step"].as_str().map(|text| {
                let mark=match step["status"].as_str(){Some("completed")=>"[x]",Some("inProgress")=>"[-]",_=>"[ ]"};
                format!("{mark} {}",text.chars().take(512).collect::<String>())
            })).collect::<Vec<_>>().join("\n");
            ("plan",text,"completed")
        }
        "error" if p["willRetry"]==true => ("retrying","Provider is retrying the request".to_owned(),"running"),
        "error" => ("provider_notice","Provider reported an error".to_owned(),"failed"),
        _ => return None,
    };
    Some(if let Some(turn)=active_turn {
        json!({"kind":"activity","activity":{"id":format!("{turn}:{kind}"),"kind":kind,"turnId":turn,"text":text,"status":status}})
    } else {json!({"kind":"maintenance","operation":kind,"status":status})})
}
