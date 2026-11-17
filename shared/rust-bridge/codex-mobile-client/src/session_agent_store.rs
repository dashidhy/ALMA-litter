//! Provider-neutral prototype persistence. Business assets are direct-write;
//! this journal records dialogue, never stages/publishes agent file changes.
use crate::scoped_files::{Access, ScopedFiles};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const SKILL_ROOT: &str = "shared/skills/builtin-v1";
pub const SKILL_BUNDLE: &str = "builtin-v1";
const SOURCE: &str = include_str!("../../../session-agent/fixtures/nvidia-transcript.md");
pub const SKILLS: [(&str, &str, &str); 2] = [
    (
        "asr-review",
        "审核ASR并保存修订版转写与共享疑点索引",
        "asr-review/SKILL.md",
    ),
    (
        "structured-notes",
        "根据转写与已有审查成果生成或修改结构化笔记",
        "structured-notes/SKILL.md",
    ),
];

pub fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
pub fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn default_provider() -> String { "codex".into() }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub version: u32,
    pub session_id: String,
    #[serde(default = "default_provider")]
    pub provider_id: String,
    pub source_sha256: String,
    pub authorization_id: Option<String>,
    pub thread_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub language: String,
    #[serde(default)]
    pub has_user_requests: bool,
    #[serde(default)]
    pub role_and_capabilities: Option<crate::session_agent_role::RoleReceipt>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub role: String,
    pub text: String,
    pub status: String,
    pub turn_id: Option<String>,
    pub skill: Option<String>,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub sequence: u64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub status: String,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub sequence: u64,
    #[serde(default)]
    pub detail_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_detail: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTurn {
    pub id: String,
    pub turn_id: Option<String>,
    pub status: String,
    pub started_at_ms: Option<u64>,
    pub ended_at_ms: Option<u64>,
}

pub fn with_event_time(mut event: Value) -> Value {
    if event.get("timestampMs").is_none() {
        if let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
            event["timestampMs"] = json!(now.as_millis() as u64);
        }
    }
    event
}

#[derive(Default)]
pub struct Conversation {
    pub messages: Vec<Message>,
    pub activities: Vec<Activity>,
    pub turns: Vec<ConversationTurn>,
    pub active_turn: Option<String>,
    pub status: String,
    pub sequence: u64,
    native_calls: BTreeMap<(Option<String>, String), (String, String)>,
}

impl Conversation {
    fn resolved_activity(&self, event: &Value) -> Option<Activity> {
        let mut activity: Activity = serde_json::from_value(event["activity"].clone()).ok()?;
        let previous = self.activities.iter().find(|item| item.id == activity.id);
        activity.turn_id = activity.turn_id
            .or_else(|| event["turnId"].as_str().map(str::to_owned))
            .or_else(|| previous.and_then(|item| item.turn_id.clone()))
            .or_else(|| self.active_turn.clone());
        let native = self.native_calls.get(&(activity.turn_id.clone(), activity.id.clone()));
        // Some native result events omit the tool name. Keep its start label.
        if activity.kind == "tool" || activity.kind.starts_with("tool_call_") {
            if let Some(previous) = previous {
                activity.kind = previous.kind.clone();
            } else if let Some((kind, _)) = native {
                activity.kind = kind.clone();
            }
        }
        let payload = serde_json::from_str::<Value>(&activity.text).ok();
        activity.call_detail = activity.call_detail
            .or_else(|| payload.as_ref().filter(|p|p.get("toolCallId").is_some())
                .and_then(|p|p.get("input").or(p.get("arguments")))
                .and_then(|input|zcode_call_detail(&activity.kind, input)))
            .or_else(|| native.map(|(_, detail)|detail.clone()))
            .or_else(|| previous.and_then(|p|p.call_detail.clone()));
        activity.text = public_activity_detail(&activity);
        Some(activity)
    }

    fn normalized_event(&self, mut event: Value) -> Value {
        if event["kind"] == "activity" {
            if let Some(activity) = self.resolved_activity(&event) {
                event["activity"] = serde_json::to_value(activity).expect("activity is serializable");
            }
        }
        event
    }

    pub fn apply(&mut self, event: &Value) {
        self.apply_bounded(event, 100);
    }

    fn apply_bounded(&mut self, event: &Value, activity_limit: usize) {
        self.sequence += 1;
        match event["kind"].as_str().unwrap_or("") {
            "native_public_event" if event["provider"] == "zcode" => {
                // ZCode puts arguments on scheduled, not started/result. Keep
                // this public description through the whole tool lifecycle.
                // Also recovers build35 history without rewriting its journal.
                let native = &event["event"];
                let payload = &native["payload"];
                if native["type"] == "tool_call_scheduled" {
                    if let (Some(id), Some(kind)) = (payload["toolCallId"].as_str(), payload["toolName"].as_str()) {
                        if let Some(detail) = zcode_call_detail(kind, &payload["input"]) {
                            let owner = event["turnId"].as_str().map(str::to_owned).or_else(|| self.active_turn.clone());
                            self.native_calls.insert((owner,id.into()),(kind.into(),detail));
                        }
                    }
                }
            }
            "user" => {
                let id = event["id"].as_str().unwrap_or("");
                if !self.messages.iter().any(|m| m.id == id) {
                    self.messages.push(Message {
                        id: id.into(),
                        role: "user".into(),
                        text: event["text"].as_str().unwrap_or("").into(),
                        status: "pending".into(),
                        skill: event["skill"].as_str().map(str::to_owned),
                        turn_id: None,
                        sequence: self.sequence,
                        ..Message::default()
                    });
                    self.turns.push(ConversationTurn {
                        id: id.into(),
                        status: "sending".into(),
                        started_at_ms: event["timestampMs"].as_u64(),
                        ..ConversationTurn::default()
                    });
                }
                self.status = "sending".into();
            }
            "started" => {
                self.active_turn = event["turnId"].as_str().map(str::to_owned);
                if let Some(message) = self
                    .messages
                    .iter_mut()
                    .rev()
                    .find(|m| m.role == "user" && m.status == "pending")
                {
                    message.turn_id = self.active_turn.clone();
                    message.status = "sent".into();
                }
                self.status = "running".into();
                if let Some(turn) = self
                    .turns
                    .iter_mut()
                    .rev()
                    .find(|t| t.status == "sending" || t.turn_id == self.active_turn)
                {
                    turn.turn_id = self.active_turn.clone();
                    turn.status = "running".into();
                    if turn.started_at_ms.is_none() {
                        turn.started_at_ms = event["timestampMs"].as_u64();
                    }
                }
            }
            "assistant" => {
                let id = event["id"].as_str().unwrap_or("");
                let index = self
                    .messages
                    .iter()
                    .position(|m| m.id == id)
                    .unwrap_or_else(|| {
                        self.messages.push(Message {
                            id: id.into(),
                            role: "assistant".into(),
                            status: "streaming".into(),
                            turn_id: event["turnId"]
                                .as_str()
                                .map(str::to_owned)
                                .or_else(|| self.active_turn.clone()),
                            sequence: self.sequence,
                            ..Message::default()
                        });
                        self.messages.len() - 1
                    });
                let message = &mut self.messages[index];
                if let Some(id) = event["turnId"].as_str() {
                    message.turn_id = Some(id.into());
                }
                if let Some(phase) = event["phase"].as_str() {
                    message.phase = Some(phase.into());
                }
                if let Some(text) = event["text"].as_str() {
                    message.text = text.into();
                }
                if let Some(delta) = event["delta"].as_str() {
                    message.text.push_str(delta);
                }
                if event["complete"] == true {
                    message.status = "complete".into();
                }
            }
            "reconciled" => {
                if let Some(turn) = self
                    .turns
                    .iter_mut()
                    .find(|t| Some(t.id.as_str()) == event["id"].as_str())
                {
                    turn.turn_id = event["turnId"].as_str().map(str::to_owned);
                    turn.status = event["status"].as_str().unwrap_or("interrupted").into();
                }
                if let Some(message) = self
                    .messages
                    .iter_mut()
                    .find(|m| Some(m.id.as_str()) == event["id"].as_str())
                {
                    message.turn_id = event["turnId"].as_str().map(str::to_owned);
                    message.status = if event["status"] == "completed" {
                        "sent"
                    } else {
                        "interrupted"
                    }
                    .into();
                }
            }
            "activity" => {
                if let Some(mut activity) = self.resolved_activity(event) {
                    if activity.status != "running" {
                        self.native_calls.remove(&(activity.turn_id.clone(), activity.id.clone()));
                    }
                    if let Some(existing) = self.activities.iter_mut().find(|a| a.id == activity.id)
                    {
                        activity.sequence = existing.sequence;
                        if activity.turn_id.is_none() {
                            activity.turn_id = existing.turn_id.clone();
                        }
                        *existing = activity;
                    } else {
                        activity.sequence = self.sequence;
                        self.activities.push(activity);
                    }
                    if self.activities.len() > activity_limit {
                        self.activities
                            .drain(..self.activities.len() - activity_limit);
                    }
                }
            }
            "finished" => {
                self.status = event["status"].as_str().unwrap_or("interrupted").into();
                let turn_id = event["turnId"].as_str().or(self.active_turn.as_deref());
                if let Some(turn) = self.turns.iter_mut().rev().find(|t| {
                    turn_id.is_some_and(|id| t.turn_id.as_deref() == Some(id))
                        || (turn_id.is_none() && t.status == "sending")
                }) {
                    turn.status = self.status.clone();
                    turn.ended_at_ms = event["timestampMs"].as_u64();
                }
                for message in &mut self.messages {
                    if message.status == "streaming" || message.status == "pending" {
                        message.status = if self.status == "completed" {
                            "complete"
                        } else {
                            "interrupted"
                        }
                        .into();
                    }
                }
                self.active_turn = None;
                self.native_calls.clear();
            }
            _ => {}
        }
    }
}

/// Legacy public tool-detail semantics. Old Session Agent journals can contain
/// native payloads: project those on read without rewriting their stored bytes.
/// New Kimi events already use the original TAH tool-details implementation.
fn public_activity_detail(activity: &Activity) -> String {
    let with_call = |result: String| -> String {
        match activity.call_detail.as_deref() {
            Some(call) if activity.status == "running" => call.into(),
            Some(call) if !result.starts_with(call) => format!("{call}\n{result}"),
            _ => result,
        }
    };
    let Ok(payload) = serde_json::from_str::<Value>(&activity.text) else { return with_call(activity.text.clone()) };
    if payload.get("toolCallId").is_some() {
        if activity.status == "running" { return with_call(activity.kind.clone()); }
        // Port of ZCode TAH toolCompletionDetail: public status and numeric
        // timings, never the SDK's full result/error payload.
        let result = &payload["result"];
        let error = payload.get("error").unwrap_or(&result["error"]);
        let mut parts = Vec::new();
        if let Some(kind) = error["type"].as_str() {
            if ["tool_timeout", "tool_execution_failed", "tool_not_found", "tool_cancelled", "tool_max_calls", "invalid_input", "permission_denied", "permission_escalation", "permission_timeout", "storage_error", "cancelled", "unknown_error"].contains(&kind) {
                parts.push(kind.to_owned());
            }
        }
        let perf = &result["perf"];
        for (name, value) in [
            ("total", payload.get("duration").unwrap_or(&perf["totalMs"])),
            ("permission", &perf["permissionWaitMs"]),
            ("read", &perf["detail"]["filesystem"]["readMs"]),
            ("write", &perf["detail"]["filesystem"]["writeMs"]),
            ("match", &perf["detail"]["patch"]["matchMs"]),
        ] {
            if let Some(value) = value.as_f64().filter(|v| v.is_finite() && (0.0..=3_600_000.0).contains(v)) {
                parts.push(format!("{name}={}ms", value.round()));
            }
        }
        let label = if ["WebSearch", "WebFetch", "webReader", "Bash"].contains(&activity.kind.as_str()) { format!("{}: ", activity.kind) } else { String::new() };
        let status = if activity.status == "failed" || result["success"] == false || payload.get("error").is_some() { "Tool returned an error" } else { "Completed" };
        return with_call(format!("{label}{status}{}", if parts.is_empty() {String::new()} else {format!(" ({})",parts.join(", "))}));
    }
    // Compatibility for pre-fix Kimi history, whose raw tool results were JSON
    // strings/blocks. They were never intended to be public working-log bodies.
    if ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "FetchURL", "Skill", "mcp__alma_files__copy_file", "mcp__alma_files__delete_file"].contains(&activity.kind.as_str()) {
        let prefix = if activity.status == "running" {""} else if activity.status == "failed" {"Failed: "} else {"Completed: "};
        let amount = if activity.kind == "Read" && activity.status == "completed" {
            payload.as_str().map(|s| format!(" · {} characters returned",s.encode_utf16().count())).unwrap_or_default()
        } else {String::new()};
        return format!("{prefix}{}{amount}",activity.kind);
    }
    activity.text.clone()
}

fn zcode_call_detail(kind: &str, input: &Value) -> Option<String> {
    if !input.is_object() { return None; }
    fn field(value: &Value) -> Option<String> {
        value.as_str().map(|s|s.chars().map(|c|if c.is_control(){' '}else{c}).take(1600).collect())
    }
    fn path(value: &Value) -> Option<String> {
        field(value).map(|s| {
            if let Some(rest) = s.strip_prefix("/workspace/sessions/") {
                if let Some((_, relative)) = rest.split_once("/workspace/") { return relative.to_owned(); }
            }
            s.strip_prefix("/workspace/").unwrap_or(&s).to_owned()
        })
    }
    let target = path(input.get("file_path").or(input.get("path")).unwrap_or(&Value::Null));
    let mut parts = Vec::new();
    let label = match kind {
        "Skill" => { parts.push(field(&input["skill"]).or_else(||field(&input["name"]))?); "Skill" }
        "Read" => {
            parts.push(target?);
            let offset = input["offset"].as_u64().unwrap_or(1).max(1);
            if let Some(limit) = input["limit"].as_u64().filter(|n|*n>0) {
                if let Some(end) = offset.checked_add(limit-1) { parts.push(format!("lines {offset}–{end}")); }
            } else if input.get("offset").is_some() { parts.push(format!("from line {offset}")); }
            "Read"
        }
        "Glob" | "Grep" => {
            parts.push(target.unwrap_or_else(||".".into()));
            for key in ["pattern","glob","type"] { if let Some(value)=field(&input[key]) {parts.push(format!("{key} {value}"));} }
            if kind=="Glob" {"List"} else {"Search"}
        }
        "Write" | "Edit" => {
            parts.push(target?);
            if kind=="Write" {
                if let Some(content)=input["content"].as_str() {parts.push(format!("{} bytes requested",content.len()));}
                "Write"
            } else {
                parts.push(if input["replace_all"]==true {"replace all occurrences"} else {"replace first occurrence"}.into());
                if let (Some(old),Some(new))=(input["old_string"].as_str(),input["new_string"].as_str()) {parts.push(format!("{} → {} characters",old.encode_utf16().count(),new.encode_utf16().count()));}
                "Edit"
            }
        }
        "WebSearch" => {parts.push(field(&input["query"])?);"Web search"}
        "WebFetch" | "webReader" => {parts.push(field(&input["url"])?);"Web fetch"}
        "Bash" => {parts.push(field(&input["command"])?);"Command"}
        "mcp__alma_files__copy_file" => {parts.push(format!("{} → {}",path(&input["source"])?,path(&input["destination"])?));"Copy"}
        "mcp__alma_files__delete_file" => {parts.push(target?);"Delete"}
        _ => return None,
    };
    Some(format!("{label}: {}",parts.join(" · ")))
}

pub struct SessionStore {
    pub root: PathBuf,
    pub state: SessionState,
    pub conversation: Conversation,
}

impl SessionStore {
    pub fn open(root: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&root)?;
        Self::validate_shared_skills(&root)?;
        let pointer = root.join("session-agent.json");
        if !pointer.exists() {
            return Self::create(root);
        }
        let pointer: Value =
            serde_json::from_slice(&fs::read(pointer)?).map_err(io::Error::other)?;
        let id = pointer["sessionId"]
            .as_str()
            .ok_or_else(|| invalid("missing current session"))?;
        Self::open_session(root, id)
    }

    pub fn create(root: PathBuf) -> io::Result<Self> {
        Self::validate_shared_skills(&root)?;
        let state = SessionState {
            version: 1,
            provider_id: default_provider(),
            session_id: Uuid::new_v4().to_string(),
            source_sha256: fingerprint(SOURCE.as_bytes()),
            authorization_id: None,
            thread_id: None,
            model: None,
            effort: None,
            language: "简体中文".into(),
            has_user_requests: false,
            role_and_capabilities: None,
        };
        let store = Self {
            root,
            state,
            conversation: Conversation::default(),
        };
        fs::create_dir_all(store.workspace().join("assets"))?;
        atomic_write(&store.workspace().join("transcript.md"), SOURCE.as_bytes())?;
        store.save_state()?;
        atomic_write(
            &store.root.join("session-agent.json"),
            &serde_json::to_vec(&json!({"sessionId":store.state.session_id}))?,
        )?;
        Ok(store)
    }

    pub fn open_session(root: PathBuf, id: &str) -> io::Result<Self> {
        if Uuid::parse_str(id).is_err() {
            return Err(invalid("invalid session identity"));
        }
        Self::validate_shared_skills(&root)?;
        let state: SessionState = serde_json::from_slice(&fs::read(
            root.join("sessions")
                .join(id)
                .join("conversation/session.json"),
        )?)?;
        if state.session_id != id {
            return Err(invalid("session identity mismatch"));
        }
        if state.version != 1 || Uuid::parse_str(&state.session_id).is_err() {
            return Err(invalid("unknown session state"));
        }
        let workspace = root
            .join("sessions")
            .join(&state.session_id)
            .join("workspace");
        if fingerprint(&fs::read(workspace.join("transcript.md"))?) != state.source_sha256 {
            return Err(invalid("original transcript changed"));
        }
        let mut store = Self {
            root,
            state,
            conversation: Conversation::default(),
        };
        let journal = store.journal_path();
        match fs::read(&journal) {
            Ok(bytes) => {
                let complete_end = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
                for line in bytes[..complete_end]
                    .split(|b| *b == b'\n')
                    .filter(|line| !line.is_empty())
                {
                    let event: Value = serde_json::from_slice(line)
                        .map_err(|_| invalid("conversation journal is corrupt"))?;
                    store.conversation.apply(&event);
                }
                if complete_end < bytes.len() {
                    OpenOptions::new()
                        .write(true)
                        .open(&journal)?
                        .set_len(complete_end as u64)?;
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        // Pending native work is reconciled by the runtime; never resubmit it.
        if matches!(store.conversation.status.as_str(), "sending" | "running") {
            store.record(json!({"kind":"finished","status":"interrupted"}), true)?;
        }
        Ok(store)
    }

    pub fn select(root: PathBuf, id: &str) -> io::Result<Self> {
        let store = Self::open_session(root, id)?;
        atomic_write(
            &store.root.join("session-agent.json"),
            &serde_json::to_vec(&json!({"sessionId":store.state.session_id}))?,
        )?;
        Ok(store)
    }

    /// Install the App's signed resource package once at application scope.
    /// The host supplies the bundle location; no agent/UI path selects content.
    pub fn install_skills(root: &Path, package: &Path) -> io::Result<()> {
        let files = SKILLS
            .iter()
            .map(|(name, _, relative)| {
                let bytes = fs::read(package.join(relative))?;
                Self::validate_skill(name, &bytes)?;
                Ok((root.join(SKILL_ROOT).join(relative), bytes))
            })
            .collect::<io::Result<Vec<_>>>()?;
        // Validate the complete package before changing the installed copy.
        for (path, bytes) in files {
            if !path.exists() || fs::read(&path)? != bytes {
                atomic_write(&path, &bytes)?;
            }
        }
        Ok(())
    }

    fn validate_shared_skills(root: &Path) -> io::Result<()> {
        for (name, _, relative) in SKILLS {
            Self::validate_skill(name, &fs::read(root.join(SKILL_ROOT).join(relative))?)?;
        }
        Ok(())
    }

    fn validate_skill(name: &str, bytes: &[u8]) -> io::Result<()> {
        if bytes.is_empty() || bytes.len() > 128 * 1024 {
            return Err(invalid("invalid shared skill size"));
        }
        let text =
            std::str::from_utf8(bytes).map_err(|_| invalid("invalid shared skill encoding"))?;
        let metadata = text
            .strip_prefix("---\n")
            .and_then(|s| s.split_once("\n---"))
            .map(|(s, _)| s)
            .ok_or_else(|| invalid("missing shared skill metadata"))?;
        if !metadata.lines().any(|line| line == format!("name: {name}")) {
            return Err(invalid("shared skill identity mismatch"));
        }
        Ok(())
    }

    pub fn workspace_relative(&self) -> String {
        format!("sessions/{}/workspace", self.state.session_id)
    }
    pub fn workspace(&self) -> PathBuf {
        self.root.join(self.workspace_relative())
    }
    pub fn save_state(&self) -> io::Result<()> {
        atomic_write(
            &self
                .root
                .join("sessions")
                .join(&self.state.session_id)
                .join("conversation/session.json"),
            &serde_json::to_vec(&self.state)?,
        )
    }

    /// Edit next-turn settings against the already loaded catalog. No provider
    /// startup or history event belongs to this local persistence operation.
    pub fn configure_inference(&mut self, input: &Value, catalog: &Value) -> io::Result<()> {
        let rows = catalog.as_array().filter(|r|!r.is_empty()).ok_or_else(||invalid("model_catalog_unavailable"))?;
        let requested = input.get("model").map(|v|v.as_str().ok_or_else(||invalid("invalid_model"))).transpose()?;
        let wanted = requested.or(self.state.model.as_deref()).ok_or_else(||invalid("selected_model_unavailable"))?;
        let model = rows.iter().find(|m|m["model"]==wanted || m["id"]==wanted).ok_or_else(||invalid("selected_model_unavailable"))?;
        let name = model["model"].as_str().or(model["id"].as_str()).ok_or_else(||invalid("model_catalog_invalid"))?;
        let efforts = model["supportedReasoningEfforts"].as_array().ok_or_else(||invalid("model_catalog_invalid"))?;
        let allowed = |value: &str|efforts.iter().any(|e|e["reasoningEffort"]==value);
        let explicit = input.get("effort").map(|v|v.as_str().ok_or_else(||invalid("invalid_effort"))).transpose()?;
        if explicit.is_some_and(|e|!allowed(e)) {return Err(invalid("selected_effort_unavailable"));}
        let unchanged = self.state.model.as_deref()==Some(name);
        let effort = explicit.or_else(||if unchanged {self.state.effort.as_deref().filter(|e|allowed(e))} else {None})
            .or_else(||model["defaultReasoningEffort"].as_str().filter(|e|allowed(e)))
            .or_else(||efforts.first().and_then(|e|e["reasoningEffort"].as_str()))
            .ok_or_else(||invalid("selected_effort_unavailable"))?.to_owned();
        let old = self.state.clone();
        self.state.model = Some(name.into()); self.state.effort = Some(effort);
        if let Err(error)=self.save_state() {self.state=old;return Err(error);}
        Ok(())
    }
    fn journal_path(&self) -> PathBuf {
        self.root
            .join("sessions")
            .join(&self.state.session_id)
            .join("conversation/events.jsonl")
    }

    /// Return exactly the normalized event persisted and applied to the store.
    /// Live UI delivery and journal replay must share the same turn ownership.
    pub fn record(&mut self, event: Value, durable: bool) -> io::Result<Value> {
        let event = self.conversation.normalized_event(with_event_time(event));
        // Persist this before admitting a request. A missing native thread may
        // only be replaced if it has never carried user work, even after a
        // crash between journal writes or later conversation pruning.
        if event["kind"] == "user" && !self.state.has_user_requests {
            self.state.has_user_requests = true;
            self.save_state()?;
        }
        let mut bytes = serde_json::to_vec(&event)?;
        bytes.push(b'\n');
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.journal_path())?;
        file.write_all(&bytes)?;
        if durable {
            file.sync_data()?;
        }
        self.conversation.apply(&event);
        Ok(event)
    }

    /// Read only the selected turn's public events from the durable journal.
    /// The snapshot's 100-row preview limit must not truncate the full log.
    pub fn working_log(&self, id: &str) -> io::Result<Value> {
        let turn = self
            .conversation
            .turns
            .iter()
            .find(|t| t.id == id)
            .ok_or_else(|| invalid("unknown turn"))?;
        let mut view = Conversation::default();
        let mut active: Option<String> = None;
        let mut limited = false;
        for line in io::BufReader::new(fs::File::open(self.journal_path())?).lines() {
            let line = line?;
            let event: Value =
                serde_json::from_str(&line).map_err(|_| invalid("invalid working log"))?;
            match event["kind"].as_str().unwrap_or("") {
                "started" => active = event["turnId"].as_str().map(str::to_owned),
                "finished" => active = None,
                "assistant" | "activity" | "native_public_event" => {
                    let owner = event["turnId"]
                        .as_str()
                        .or(event["activity"]["turnId"].as_str())
                        .or(active.as_deref());
                    if owner.is_some() && owner == turn.turn_id.as_deref() {
                        view.active_turn = turn.turn_id.clone();
                        if view.activities.len() >= 5000
                            && !view
                                .activities
                                .iter()
                                .any(|a| Some(a.id.as_str()) == event["activity"]["id"].as_str())
                        {
                            limited = true;
                        }
                        view.apply_bounded(&event, 5000);
                    }
                }
                _ => {}
            }
        }
        limited |= view.activities.iter().any(|a| a.detail_truncated);
        Ok(
            json!({"turn":turn,"messages":view.messages,"activities":view.activities,"limited":limited}),
        )
    }

    pub fn bind(&mut self, authorization: &str) -> io::Result<()> {
        if !authorization.bytes().all(|b| b.is_ascii_hexdigit()) || authorization.len() != 64 {
            return Err(invalid("invalid authorization identity"));
        }
        if self
            .state
            .authorization_id
            .as_deref()
            .is_some_and(|old| old != authorization)
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "This conversation belongs to a different authorization",
            ));
        }
        self.state.authorization_id = Some(authorization.into());
        self.save_state()
    }

    pub fn read(&self, path: &str) -> io::Result<String> {
        if path != "transcript.md" && !path.starts_with("assets/") {
            return Err(invalid("not a business resource"));
        }
        let bytes = ScopedFiles::open(&self.workspace(), Access::ReadOnly)?
            .read_file(Path::new(path), 8 * 1024 * 1024)?;
        String::from_utf8(bytes).map_err(|_| invalid("asset is not UTF-8 text"))
    }

    pub fn assets(&self) -> io::Result<Vec<Value>> {
        let files = ScopedFiles::open(&self.workspace(), Access::ReadOnly)?;
        let mut pending = vec!["assets".to_string()];
        let mut result = vec![];
        let mut visited = 0;
        while let Some(dir) = pending.pop() {
            for name in files.list_names(Some(Path::new(&dir)), 1024)? {
                visited += 1;
                if visited > 4096 {
                    return Err(invalid("asset directory limit"));
                }
                let Some(name) = name.to_str() else { continue };
                let path = format!("{dir}/{name}");
                let meta = match files.metadata(Path::new(&path)) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if meta.is_dir() {
                    if path.matches('/').count() < 16 {
                        pending.push(path);
                    }
                } else {
                    result.push(json!({"path":path,"bytes":meta.len()}));
                }
            }
        }
        result.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
        Ok(result)
    }

    pub fn snapshot(&self, busy: bool, ready: bool, error: Option<&str>, models: &Value) -> Value {
        json!({"version":1,"provider":self.state.provider_id,"sessionId":self.state.session_id,"threadId":self.state.thread_id,
            "sourceTitle":"NVIDIA × StepFun","skillBundle":SKILL_BUNDLE,"language":self.state.language,
            "model":self.state.model,"effort":self.state.effort,"models":models,
            "busy":busy,"ready":ready,"status":self.conversation.status,"error":error,
            "sequence":self.conversation.sequence,"messages":self.conversation.messages,
            "activities":self.conversation.activities,
            "turns":self.conversation.turns,
            "roleAndCapabilities":self.state.role_and_capabilities,
            "skills":SKILLS.iter().map(|(id,description,_)|json!({"id":id,"description":description})).collect::<Vec<_>>()})
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("missing storage parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".write-{}", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        fs::File::open(parent)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
