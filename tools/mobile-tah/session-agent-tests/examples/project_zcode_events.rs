use alma_session_agent_tests::session_agent_zcode_events::ZcodeEvents;
use serde_json::{Value,json};
fn main() {
    let file=std::env::args().nth(1).expect("SDK public-event JSON path");
    let events:Vec<Value>=serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let mut projector=ZcodeEvents::new("public-event-audit");
    projector.set_session(events[0]["sessionId"].as_str().unwrap());
    let mut output=Vec::new();
    for event in &events {output.extend(projector.accept(event).unwrap());}
    let commentary=output.iter().position(|e|e["kind"]=="assistant"&&e["phase"]=="commentary"&&e["text"]=="I will read the shared notes skill.").expect("public intermediate message must survive projection");
    let tool=output.iter().position(|e|e["kind"]=="activity"&&e["activity"]["kind"]=="Skill").expect("actual skill activity");
    assert!(commentary<tool);
    assert!(output.iter().any(|e|e["kind"]=="assistant"&&e["phase"]=="final_answer"&&e["text"]=="The shared skill was read."));
    println!("{}",json!({"passed":true,"officialSDKEvents":events.len(),"projectedEvents":output.len(),"publicMessageBeforeActualTool":true,"finalAnswerPreserved":true}));
}
