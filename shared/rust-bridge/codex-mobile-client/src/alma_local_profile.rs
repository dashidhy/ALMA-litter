//! Opt-in ALMA local base profile for the vendored Codex 0.166 engine.
//!
//! This is NOT an attempt permission profile. The trusted attempt owner supplies
//! the actor/guardian role, frozen roots, permission profile, approval policy,
//! shell environment, EnvironmentManager and scoped filesystem/backend. Nothing
//! here grants filesystem or shell-network access, changes credentials/provider/
//! model selection, or overwrites those settings. Provider Web is a separate
//! trusted ability; it never enables shell network access.
//!
//! Apply only in ALMA's local `--no-default-features` lane, before BOTH config
//! builds and each thread's config resolution; never to remote/default Litter.
//! Use an isolated controller config home, `.without_project_context()` and
//! `.strict_config(true)`, then `validate_alma_local_config` via the builder's
//! `build_with_validation`. Empty TOML tables merge: validation is mandatory.
//!
//! Codex 0.166 REMOVED the realtime feature gate. Setting it false does nothing.
//! The local dispatcher must reject realtime operations (and other ungranted
//! APIs), and must not install realtime startup overrides. This module cannot
//! disable that RPC surface. Likewise history.persistence=none disables command
//! history, not rollouts: the attempt owner must request ephemeral threads.

use codex_config::TomlValue;
use codex_config::config_toml::ConfigToml;
use std::io;

/// `trusted_provider_web` must come from the frozen attempt's official-provider
/// Web grant, never from model text, config.toml, UI preference, or shell network
/// permission. Use false until that grant has been validated. No I/O occurs here.
pub(crate) fn alma_local_cli_overrides(trusted_provider_web: bool) -> Vec<(String, TomlValue)> {
    let mut overrides: Vec<(String, TomlValue)> = DISABLED_FEATURES
        .iter()
        .map(|key| (format!("features.{key}"), false.into()))
        .chain(ENABLED_FEATURES.iter().map(|key| (format!("features.{key}"), true.into())))
        .collect();
    for key in [
        "agents.enabled",
        "allow_login_shell",
        "analytics.enabled",
        "feedback.enabled",
        "show_raw_agent_reasoning",
        "tools.experimental_request_user_input.enabled",
        "tools.update_plan.enabled",
        "skills.bundled.enabled",
        "skills.include_instructions",
        "plugins._default.enabled",
        "check_for_update_on_startup",
        "otel.log_user_prompt",
        "otel.log_agent_responses",
        "otel.log_guardian_assessments",
    ] {
        overrides.push((key.into(), false.into()));
    }
    for (key, value) in [
        ("history.persistence", "none"),
        ("model_reasoning_summary", "concise"),
        ("otel.exporter", "none"),
        ("otel.trace_exporter", "none"),
        ("otel.metrics_exporter", "none"),
        ("web_search", if trusted_provider_web { "live" } else { "disabled" }),
    ] {
        overrides.push((key.into(), value.into()));
    }
    overrides.push(("project_doc_max_bytes".into(), 0.into()));
    overrides.push(("notify".into(), TomlValue::Array(vec![])));
    overrides.push(("project_doc_fallback_filenames".into(), TomlValue::Array(vec![])));
    for key in ["mcp_servers", "hooks"] {
        overrides.push((key.into(), TomlValue::Table(Default::default())));
    }
    // tools.web_search is optional in 0.166; top-level web_search controls the
    // provider tool's availability. No deprecated web_search_* feature toggles.
    overrides
}

/// Reject incompatible inherited config before ConfigBuilder materializes it.
/// This checks only our base contract. The caller must independently validate
/// harness overrides, managed requirements and the FINAL resolved config, plus
/// attempt roots/role/environment and later thread/turn overrides. Do not retry
/// a validation failure using an unrestricted/default config.
pub(crate) fn validate_alma_local_config(
    config: &ConfigToml,
    trusted_provider_web: bool,
) -> io::Result<()> {
    let invalid = |message: String| io::Error::new(io::ErrorKind::InvalidInput, message);
    if config.profile.is_some() {
        return Err(invalid("ALMA local config cannot select an inherited named profile".into()));
    }
    let entries = config.features.as_ref().map(|features| features.entries()).unwrap_or_default();
    for (key, enabled) in &entries {
        if REMOVED_FEATURES.contains(&key.as_str()) || LEGACY_WEB_FEATURES.contains(&key.as_str()) {
            return Err(invalid(format!("ALMA local feature {key} is removed or deprecated; it is not a supported ability gate")));
        }
        if !DISABLED_FEATURES.contains(&key.as_str())
            && !ENABLED_FEATURES.contains(&key.as_str())
            && !CALLER_ENGINE_FEATURES.contains(&key.as_str())
        {
            return Err(invalid(format!("ALMA local feature {key} is unknown or an unsupported alias")));
        }
        if DISABLED_FEATURES.contains(&key.as_str()) && *enabled {
            return Err(invalid(format!("ALMA local feature {key} must be disabled")));
        }
    }
    for (keys, expected) in [(DISABLED_FEATURES, false), (ENABLED_FEATURES, true)] {
        for key in keys {
            if entries.get(*key) != Some(&expected) {
                return Err(invalid(format!("ALMA local feature {key} must explicitly be {expected}")));
            }
        }
    }
    // Serialize the real typed consumer so optional/defaulted fields and nested
    // settings are checked without maintaining a second shadow config type.
    let actual = serde_json::to_value(config).map_err(io::Error::other)?;
    for (path, expected) in alma_local_cli_overrides(trusted_provider_web) {
        if path.starts_with("features.") || path == "hooks" {
            continue;
        }
        let value = path.split('.').try_fold(&actual, |value, part| value.get(part));
        let expected = serde_json::to_value(expected).map_err(io::Error::other)?;
        if value != Some(&expected) {
            return Err(invalid(format!("ALMA local setting {path} does not match the trusted base profile")));
        }
    }
    if config.hooks.as_ref().is_some_and(|hooks| !hooks.events.is_empty() || !hooks.state.is_empty()) {
        return Err(invalid("ALMA local config contains inherited hooks".into()));
    }
    Ok(())
}

/// Check the resolved ManagedFeatures AFTER upstream requirements/normalization.
/// Fail on a conflict; never mutate features to defeat a managed requirement.
/// Removed registry entries can remain default-on because upstream ignores
/// their toggles. They do not certify an ability gate (notably realtime).
pub(crate) fn validate_alma_local_effective_features(
    enabled_keys: impl IntoIterator<Item = &'static str>,
) -> io::Result<()> {
    let enabled: std::collections::BTreeSet<_> = enabled_keys.into_iter().collect();
    for key in &enabled {
        if !ENABLED_FEATURES.contains(key)
            && !CALLER_ENGINE_FEATURES.contains(key)
            && !REMOVED_FEATURES.contains(key)
        {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, format!(
                "ALMA local resolved feature {key} is outside the base profile"
            )));
        }
    }
    for key in ENABLED_FEATURES {
        if !enabled.contains(key) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, format!(
                "ALMA local required feature {key} is disabled by the resolved config"
            )));
        }
    }
    Ok(())
}

// Match Mac TAH native-profile.ts intent, extended for this engine's additional
// optional capabilities. Regression compares this inventory with the ACTUAL
// registry; upstream additions/removals require an explicit review.
pub(crate) const DISABLED_FEATURES: &[&str] = &[
    "agent_message_board",
    "analytics_plan_history",
    "api_key_cyber_access_programs",
    "api_key_model_discovery",
    "app_server_websocket_compression",
    "apply_patch_streaming_events",
    "apps",
    "artifact",
    "async_compaction",
    "auth_elicitation",
    "background_paginated_rollout_migration",
    "bedrock_setup_wizard",
    "browser_annotation_api",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "chronicle",
    "cli_daybreak",
    "code_mode",
    "code_mode_host",
    "code_mode_host_grpc",
    "code_mode_interrupt",
    "code_mode_only",
    "code_mode_only_strict_3p_tools",
    "code_mode_prewarm",
    "code_mode_tool_search",
    "codex_apps_mcp_2026_07_28",
    "computer_use",
    "concurrent_reasoning_summaries",
    "content_item_kinds",
    "context_management",
    "critical_path_timing",
    "current_time_reminder",
    "cwd_relative_turn_diffs",
    "daemon_auto_start",
    "default_mode_request_user_input",
    "defer_mailbox_preemption",
    "deferred_executor",
    "deferred_tool_world_state",
    "enable_mcp_apps",
    "executed_tool_call_metadata",
    "executor_capability_discovery",
    "executor_capability_discovery_v2",
    "external_agent_memory_import",
    "fast_mode",
    "goals",
    "guardian_approval",
    "guardian_conversation_history_tools",
    "guardian_enhanced_node_repl_transcripts",
    "guardian_native_multi_agent_history",
    "guardian_node_repl_transcript_images",
    "guardian_recorded_items",
    "guardian_reuse_parent_compaction",
    "guardian_root_handoff_context",
    "guardian_trust_orchestrator_connectors",
    "guardianv2",
    "guardianv2_decisions_comparison",
    "guardianv3",
    "hooks",
    "image_generation",
    "image_resize_notice",
    "in_app_browser",
    "in_app_chat",
    "in_app_dictation",
    "in_app_local_automation",
    "in_app_updates",
    "in_app_voice",
    "incremental_tools",
    "local_thread_store_compression",
    "login_shell_package_path",
    "mcp_2026_07_28",
    "mcp_connection_sharing",
    "mcp_oauth_refresh_coordination",
    "mcp_tool_list_changed",
    "memories",
    "mentions_v2",
    "model_catalog_in_context",
    "multi_agent",
    "multi_agent_v2",
    "multi_agent_v2_dynamic_tools",
    "multi_env_copy_file",
    "non_prefixed_mcp_tool_names",
    "nonfatal_clock_read_errors",
    "omit_app_server_notification_media",
    "omit_skill_descriptions",
    "output_token_replay",
    "plugin_discovery_prefetch",
    "plugin_sharing",
    "plugins",
    "powershell_shell_version",
    "prediction_preserve_parent_tools",
    "prevent_idle_sleep",
    "psp",
    "reasoning_effort_override",
    "recommended_plugins",
    "remote_plugin",
    "request_permissions_tool",
    "retain_client_developer_messages",
    "retain_client_tool_outputs",
    "rollout_budget",
    "runtime_agent_instances",
    "runtime_metrics",
    "send_message_to_user_async",
    "shell_snapshot",
    "shell_snapshot_v2",
    "simplified_selection_hints",
    "skill_catalog_deltas",
    "skill_mcp_dependency_install",
    "skill_search",
    "skip_host_skill_discovery",
    "sleep_tool",
    "standalone_web_search",
    "step_model_switching",
    "subagent_default_context_limits",
    "subagent_thread_environments",
    "terminal_visualization_instructions",
    "token_budget",
    "tool_call_mcp_elicitation",
    "tool_suggest",
    "tui_multi_backend",
    "ultrafast_mode",
    "unbounded_connection_retries",
    "unified_image_budget",
    "untrusted_as_tool_output",
    "use_agent_identity",
    "use_xaa",
    "view_image",
    "wake_on_agent_messages",
    "workspace_dependencies",
];

// Preserve engine security, sandbox, approval, credential and transport controls.
// They are not ALMA abilities. Disabling every bit would weaken such controls as
// write_stdin_approval or override the caller's network proxy policy.
pub(crate) const CALLER_ENGINE_FEATURES: &[&str] = &[
    "compaction_image_budget",
    "credential_masking",
    "enable_request_compression",
    "exec_permission_approvals",
    "instant_interrupt",
    "network_proxy",
    "prefer_mxc",
    "respect_system_proxy",
    "secret_auth_storage",
    "system_proxy_fallback",
    "unified_exec_tty",
    "use_legacy_landlock",
    "windows_sandbox_service",
    "write_stdin_approval",
];

pub(crate) const ENABLED_FEATURES: &[&str] = &[
    "shell_tool",
    "unified_exec",
];

// Accepted by upstream for compatibility, but top-level web_search is the
// authoritative mode. Reject inherited aliases instead of treating them as a
// grant (and avoid generating deprecation warnings for the base profile).
pub(crate) const LEGACY_WEB_FEATURES: &[&str] = &["web_search_cached", "web_search_request"];

// Compatibility-only keys are deliberately never emitted, even as false.
// In particular realtime_conversation is default-on and ignored by apply_map.
pub(crate) const REMOVED_FEATURES: &[&str] = &[
    "apply_patch_freeform",
    "apply_patch_preserve_line_endings",
    "apps_mcp_path_override",
    "code_mode_buffered_exec",
    "code_mode_tool_description_first",
    "codex_git_commit",
    "collaboration_modes",
    "elevated_windows_sandbox",
    "enable_fanout",
    "experimental_windows_sandbox",
    "external_migration",
    "guardian_ext",
    "guardianv2.thread_context",
    "image_detail_original",
    "item_ids",
    "js_repl",
    "js_repl_tools_only",
    "local_thread_store_shared_compression",
    "multi_agent_mode",
    "personality",
    "plugin_hooks",
    "realtime_conversation",
    "remote_compaction_v2",
    "remote_control",
    "remote_models",
    "request_rule",
    "resize_all_images",
    "responses_websockets",
    "responses_websockets_v2",
    "search_tool",
    "send_async_message",
    "shell_zsh_fork",
    "skill_env_var_dependency_prompt",
    "sqlite",
    "stable_environment_tools",
    "steer",
    "terminal_resize_reflow",
    "tool_search",
    "tool_search_always_defer_mcp_tools",
    "transcript_v2",
    "tui_app_server",
    "unavailable_dummy_tools",
    "undo",
    "unified_exec_zsh_fork",
    "use_linux_sandbox_bwrap",
    "workspace_owner_usage_nudge",
    "worktrees",
];
