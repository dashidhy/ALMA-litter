//! Native context-bootstrap projections used by each persistent-session adapter.
use crate::session_agent_role::{RoleAndCapabilities, RoleContext, RoleReceipt};
use std::io;

#[derive(Clone, Copy)]
pub enum ProviderRoleAdapter {
    Codex,
    Kimi,
    Zcode,
}

pub enum NativeRoleConfiguration {
    /// Only for thread/start or thread/resume, never turn/start input text.
    CodexDeveloperInstructions(String),
    /// Write under the host-selected private Kimi home before creating context.
    /// Kimi expands base_prompt; this is not the final rendered system body.
    KimiSystemFile {
        relative_path: &'static str,
        contents: String,
    },
    /// ZCode replaces default system-body sections; its fixed prefix remains.
    /// The persistent adapter supplies this as the native system body.
    ZcodeSystemPrompt(String),
}

pub struct PreparedRole {
    pub receipt: RoleReceipt,
    pub configuration: NativeRoleConfiguration,
}

impl ProviderRoleAdapter {
    pub fn prepare_context(
        self,
        role: &RoleAndCapabilities,
        language: &str,
        skills_root: &str,
        capability_root: &str,
    ) -> io::Result<PreparedRole> {
        let access = match self {
            Self::Codex => format!(
                "Shared skills are installed once at {skills_root}, exposed by the {capability_root} capability root. They belong to the executor authority, not cloud: use skills.list with authority kind executor and pass its returned package to skills.read."
            ),
            Self::Kimi | Self::Zcode => format!(
                "Shared skills are installed once at {skills_root}. Use the native Skill tool to find and read the relevant instructions."
            ),
        };
        let body = role.render(RoleContext {
            interaction_language: language,
            skill_access: &access,
        })?;
        let (provider, text) = match self {
            Self::Codex => ("codex", body),
            Self::Kimi => ("kimi", format!("${{base_prompt}}\n\n{body}")),
            Self::Zcode => ("zcode", body),
        };
        let receipt = role.receipt(provider, &text);
        let configuration = match self {
            Self::Codex => NativeRoleConfiguration::CodexDeveloperInstructions(text),
            Self::Kimi => NativeRoleConfiguration::KimiSystemFile {
                relative_path: "SYSTEM.md",
                contents: text,
            },
            Self::Zcode => NativeRoleConfiguration::ZcodeSystemPrompt(text),
        };
        Ok(PreparedRole {
            receipt,
            configuration,
        })
    }
}
