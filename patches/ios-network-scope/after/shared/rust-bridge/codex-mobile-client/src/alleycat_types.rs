//! Transport-independent records and runtime-name normalization.
use crate::types::AgentRuntimeKind;

pub const ALLEYCAT_PROTOCOL_VERSION: u32 = 1;
pub const ALLEYCAT_ALPN: &[u8] = b"alleycat/1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPairPayload {
    pub version: u32,
    pub node_id: String,
    pub token: String,
    pub relay: Option<String>,
    pub host_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentInfo {
    pub name: String,
    pub display_name: String,
    pub wire: AgentWire,
    pub available: bool,
    /// UI-facing hints from the alleycat host (label/sort/beta/aliases).
    /// `None` means the host is older or doesn't ship rich metadata; the
    /// client falls back to generic rendering.
    pub presentation: Option<AgentPresentation>,
    /// Behavioral capability flags that gate UI logic (Amp reasoning lock,
    /// SSH-bridge eligibility, direct-Codex-port routing) without litter
    /// branching on the agent name.
    pub capabilities: Option<AgentCapabilities>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentPresentation {
    pub title: Option<String>,
    pub is_beta: bool,
    pub sort_order: i32,
    pub description: Option<String>,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentCapabilities {
    pub locks_reasoning_effort_after_activity: bool,
    pub visible_modes: Option<Vec<String>>,
    pub supports_ssh_bridge: bool,
    pub uses_direct_codex_port: bool,
    pub supports_thread_permission_overrides: bool,
    pub reports_effective_thread_permissions: bool,
}

/// Map an alleycat-advertised agent (`name` + `display_name`) to the
/// canonical runtime-kind id litter uses internally. Known agents get
/// their well-known alias normalized (e.g. `pi.dev` → `pi`,
/// `factory-droid` → `droid`) so the rest of the code can match against
/// stable ids. Anything else falls through to the agent's own
/// lowercased name (or display name if name is empty), so new agents
/// advertised by alleycat work without a litter release.
pub fn agent_runtime_kind(name: &str, display_name: &str) -> Option<AgentRuntimeKind> {
    let name = name.trim().to_ascii_lowercase();
    let display_name = display_name.trim().to_ascii_lowercase();
    let candidate = if name.is_empty() {
        display_name.as_str()
    } else {
        name.as_str()
    };
    let canonical = match candidate {
        "codex" => Some("codex"),
        "pi" | "pi.dev" | "pidev" => Some("pi"),
        "omp" | "oh-my-pi" | "oh_my_pi" | "oh my pi" => Some("omp"),
        "amp" | "ampcode" | "amp-code" | "amp_code" => Some("amp"),
        "opencode" | "open-code" | "open_code" => Some("opencode"),
        "claude" | "claude-code" | "claude_code" => Some("claude"),
        "droid" | "factory" | "factory-droid" | "factory_droid" => Some("droid"),
        "hermes" => Some("hermes"),
        _ if display_name == "codex" => Some("codex"),
        _ if display_name == "pi" || display_name == "pi.dev" => Some("pi"),
        _ if display_name == "omp" || display_name == "oh my pi" => Some("omp"),
        _ if display_name == "amp" || display_name == "amp code" => Some("amp"),
        _ if display_name == "opencode" || display_name == "open code" => Some("opencode"),
        _ if display_name == "claude" || display_name == "claude code" => Some("claude"),
        _ if display_name == "droid"
            || display_name == "factory"
            || display_name == "factory droid" =>
        {
            Some("droid")
        }
        _ if display_name == "hermes" => Some("hermes"),
        _ => None,
    };
    if let Some(kind) = canonical {
        return Some(kind.to_string());
    }
    if candidate.is_empty() {
        return None;
    }
    Some(candidate.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentWire {
    Websocket,
    Jsonl,
}

#[derive(Debug, thiserror::Error)]
pub enum AlleycatError {
    #[error("invalid pair payload: {0}")]
    InvalidPayload(String),
    #[error("protocol version mismatch: payload={payload} client={client}")]
    ProtocolMismatch { payload: u32, client: u32 },
    #[error("host rejected request: {0}")]
    Rejected(String),
    #[error("transport error: {0}")]
    Transport(String),
}

