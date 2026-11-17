//! TAH's application-owned "角色与功能设定". A role is context configuration,
//! never an automatically repeated user message or an optional Skill.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io, path::Path};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoleAndCapabilities {
    pub schema_version: u32,
    pub id: String,
    pub version: String,
    pub name: String,
    template: String,
}

pub struct RoleContext<'a> {
    pub interaction_language: &'a str,
    pub skill_access: &'a str,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleReceipt {
    pub id: String,
    pub version: String,
    pub name: String,
    pub provider: String,
    pub definition_sha256: String,
    /// Hash of the provider configuration text, not of its full rendered context.
    pub configuration_sha256: String,
}

impl RoleAndCapabilities {
    pub fn load(path: &Path) -> io::Result<Self> {
        if fs::metadata(path)?.len() > 64 * 1024 {
            return Err(io::Error::other("role definition too large"));
        }
        let value: Self = serde_json::from_slice(&fs::read(path)?)?;
        if value.schema_version != 1
            || value.id.is_empty()
            || value.version.is_empty()
            || value.name.is_empty()
            || value.template.trim().is_empty()
        {
            return Err(io::Error::other("invalid role definition"));
        }
        Ok(value)
    }

    pub fn render(&self, context: RoleContext<'_>) -> io::Result<String> {
        let text = self
            .template
            .replace("{{interaction_language}}", context.interaction_language)
            .replace("{{skill_access}}", context.skill_access);
        if text.contains("{{") {
            return Err(io::Error::other("unknown role template variable"));
        }
        Ok(text)
    }

    pub fn receipt(&self, provider: &str, configuration: &str) -> RoleReceipt {
        RoleReceipt {
            id: self.id.clone(),
            version: self.version.clone(),
            name: self.name.clone(),
            provider: provider.into(),
            definition_sha256: sha256(&self.template),
            configuration_sha256: sha256(configuration),
        }
    }
}

pub fn sha256(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
