use alma_session_agent_tests::session_agent_store::Conversation;
use serde_json::{Value, json};

fn main() {
    let file = std::env::args().nth(1).expect("journal path");
    let mut conversation = Conversation::default();
    for line in std::fs::read_to_string(file).unwrap().lines() {
        conversation.apply(&serde_json::from_str::<Value>(line).unwrap());
    }
    println!("{}", json!({"messages":conversation.messages,"activities":conversation.activities,
        "turns":conversation.turns,"status":conversation.status,"sequence":conversation.sequence}));
}
