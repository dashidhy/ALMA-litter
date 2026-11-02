// Harness-only shims, never linked into the app. The parser and all hydration
// functions are source copies; shell/path platform integration is not tested.
pub type LegacyAppPathString = String;
pub type CodexErrorInfo = serde_json::Value;
pub type ReasoningEffort = serde_json::Value;
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AbsolutePathBuf(std::path::PathBuf);
impl AbsolutePathBuf {
    pub fn from_absolute_path_checked(path: &str) -> Result<Self, ()> {
        if std::path::Path::new(path).is_absolute() { Ok(Self(path.into())) } else { Err(()) }
    }
    pub fn to_string_lossy(&self) -> std::borrow::Cow<'_, str> { self.0.to_string_lossy() }
}
impl From<AbsolutePathBuf> for String {
    fn from(path: AbsolutePathBuf) -> Self { path.0.to_string_lossy().into_owned() }
}
mod codex_utils_absolute_path { pub use crate::AbsolutePathBuf; }
mod codex_protocol {
    pub mod models { include!("core_models.rs"); }
    pub mod sandbox { pub type SandboxType = serde_json::Value; }
    pub mod items { pub type ModelInvocationContext = serde_json::Value; }
}
mod codex_shell_command {
    pub mod parse_command {
        pub fn extract_shell_command(_: &[String]) -> Option<(&str, &str)> { None }
    }
}
