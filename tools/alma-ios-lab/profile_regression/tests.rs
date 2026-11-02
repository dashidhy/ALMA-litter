use crate::alma_local_profile::*;
use codex_config::config_toml::ConfigToml;
use codex_config::{TomlValue, build_cli_overrides_layer, merge_toml_values};
use codex_features::{FEATURES, Feature, FeatureConfigSource, FeatureOverrides, Features, Stage};
use std::collections::BTreeSet;

fn layer(web: bool) -> TomlValue {
    build_cli_overrides_layer(&alma_local_cli_overrides(web))
}

fn parse(value: TomlValue) -> ConfigToml {
    value.try_into().expect("actual Codex ConfigToml deserialization")
}

fn features(config: &ConfigToml) -> Features {
    Features::from_sources(
        FeatureConfigSource { features: config.features.as_ref(), ..Default::default() },
        FeatureConfigSource::default(),
        FeatureOverrides::default(),
    )
}

#[test]
fn actual_consumer_accepts_both_web_modes_with_strict_config() {
    for web in [false, true] {
        let value = layer(web);
        let text = toml::to_string(&value).unwrap();
        assert!(codex_config::config_error_from_ignored_toml_fields::<ConfigToml>(
            "alma-local-profile.toml", &text
        ).is_none(), "base has unknown/ignored fields");
        let cfg = parse(value);
        validate_alma_local_config(&cfg, web).unwrap();
        assert!(validate_alma_local_config(&cfg, !web).is_err());
        assert_eq!(cfg.web_search, Some(if web {
            codex_protocol::config_types::WebSearchMode::Live
        } else {
            codex_protocol::config_types::WebSearchMode::Disabled
        }));
        assert!(cfg.model.is_none());
        assert!(cfg.model_provider.is_none());
    }
}

#[test]
fn effective_feature_consumer_disables_capabilities_preserves_engine_controls() {
    let defaults = Features::with_defaults();
    for web in [false, true] {
        let effective = features(&parse(layer(web)));
        for spec in FEATURES {
            if DISABLED_FEATURES.contains(&spec.key) {
                assert!(!effective.enabled(spec.id), "{} remains on", spec.key);
            } else if ENABLED_FEATURES.contains(&spec.key) {
                assert!(effective.enabled(spec.id), "{} is off", spec.key);
            } else {
                assert_eq!(effective.enabled(spec.id), defaults.enabled(spec.id), "{} changed", spec.key);
            }
        }
        assert!(effective.enabled(Feature::ShellTool));
        assert!(effective.enabled(Feature::UnifiedExec));
        assert!(effective.enabled(Feature::WriteStdinApproval));
        validate_alma_local_effective_features(effective.enabled_features().into_iter().map(|feature| feature.key())).unwrap();
    }
}

#[test]
fn resolved_feature_conflicts_are_rejected_without_overriding_requirements() {
    let base = features(&parse(layer(false)));
    let mut pinned_on = base.clone();
    pinned_on.enable(Feature::Goals);
    assert!(validate_alma_local_effective_features(pinned_on.enabled_features().into_iter().map(|feature| feature.key())).is_err());
    assert!(pinned_on.enabled(Feature::Goals));
    let mut pinned_off = base;
    pinned_off.disable(Feature::UnifiedExec);
    assert!(validate_alma_local_effective_features(pinned_off.enabled_features().into_iter().map(|feature| feature.key())).is_err());
    assert!(!pinned_off.enabled(Feature::UnifiedExec));
    assert!(validate_alma_local_effective_features(["shell_tool", "unified_exec", "new_unreviewed_feature"]).is_err());
}

#[test]
fn pinned_inventory_covers_actual_registry_without_unknown_or_obsolete_toggles() {
    let groups = [DISABLED_FEATURES, ENABLED_FEATURES, CALLER_ENGINE_FEATURES, REMOVED_FEATURES, LEGACY_WEB_FEATURES];
    let mut keys = BTreeSet::new();
    for group in groups {
        for key in group {
            assert!(keys.insert(*key), "duplicate classification: {key}");
        }
    }
    assert_eq!(keys, FEATURES.iter().map(|spec| spec.key).collect());
    for spec in FEATURES {
        assert_eq!(REMOVED_FEATURES.contains(&spec.key), spec.stage == Stage::Removed, "{} lifecycle drift", spec.key);
        if LEGACY_WEB_FEATURES.contains(&spec.key) {
            assert_eq!(spec.stage, Stage::Deprecated);
        }
    }
    let entries = parse(layer(false)).features.unwrap().entries();
    for key in REMOVED_FEATURES.iter().chain(LEGACY_WEB_FEATURES) {
        assert!(!entries.contains_key(*key), "emitted ineffective/deprecated flag {key}");
    }
}

#[test]
fn exact_current_mac_profile_features_are_disabled_or_explicitly_retired() {
    let mac = std::fs::read_to_string(std::env::var("ALMA_MAC_NATIVE_PROFILE").unwrap()).unwrap();
    let array = mac.split("const DISABLED_CODEX_FEATURES = Object.freeze([").nth(1).unwrap()
        .split("] as const)").next().unwrap();
    let mut count = 0;
    for line in array.lines() {
        let key = line.trim().trim_end_matches(',').trim_matches('"');
        if key.is_empty() { continue; }
        count += 1;
        assert!(DISABLED_FEATURES.contains(&key) || REMOVED_FEATURES.contains(&key), "unmapped Mac feature: {key}");
    }
    assert!(count > 60, "Mac source shape changed");
}

#[test]
fn retired_realtime_flag_really_is_ignored_and_must_not_be_claimed_as_a_gate() {
    let mut upstream = Features::with_defaults();
    assert!(upstream.enabled(Feature::RealtimeConversation));
    upstream.apply_map(&std::collections::BTreeMap::from([("realtime_conversation".into(), false)]));
    assert!(upstream.enabled(Feature::RealtimeConversation), "review 0.166 realtime contract");
    let mut value = layer(false);
    merge_toml_values(&mut value, &toml::from_str::<TomlValue>("[features]\nrealtime_conversation=false").unwrap());
    assert!(validate_alma_local_config(&parse(value), false).unwrap_err().to_string().contains("not a supported ability gate"));
}

#[test]
fn inherited_mcp_is_rejected_despite_empty_table_overlay() {
    let mut value: TomlValue = toml::from_str("[mcp_servers.host]\ncommand='never-executed'").unwrap();
    merge_toml_values(&mut value, &layer(false));
    let cfg = parse(value);
    assert_eq!(cfg.mcp_servers.len(), 1, "must exercise actual recursive merge");
    assert!(validate_alma_local_config(&cfg, false).unwrap_err().to_string().contains("mcp_servers"));
}

#[test]
fn inherited_hook_state_and_selected_profiles_are_rejected() {
    for inherited in [
        "[hooks.state.untrusted]\nenabled=true",
        "profile='host'\n[profiles.host.features]\ngoals=true",
    ] {
        let mut value: TomlValue = toml::from_str(inherited).unwrap();
        merge_toml_values(&mut value, &layer(false));
        assert!(validate_alma_local_config(&parse(value), false).is_err());
    }
}

#[test]
fn unknown_alias_removed_and_missing_flags_fail_closed() {
    for key in ["future_unreviewed_capability", "connectors", "realtime_conversation", "web_search_request"] {
        let mut value = layer(false);
        value["features"].as_table_mut().unwrap().insert(key.into(), false.into());
        assert!(validate_alma_local_config(&parse(value), false).is_err(), "accepted {key}");
    }
    let mut value = layer(false);
    value["features"].as_table_mut().unwrap().remove("shell_snapshot");
    assert!(validate_alma_local_config(&parse(value), false).is_err());
}

#[test]
fn structured_feature_merge_cannot_reenable_capabilities() {
    let mut value: TomlValue = toml::from_str("[features.code_mode]\nenabled=true\n[features.multi_agent_v2]\nenabled=true").unwrap();
    merge_toml_values(&mut value, &layer(false));
    let cfg = parse(value);
    validate_alma_local_config(&cfg, false).unwrap();
    assert!(!features(&cfg).enabled(Feature::CodeMode));
    assert!(!features(&cfg).enabled(Feature::MultiAgentV2));
}

#[test]
fn permission_roots_role_network_and_environment_remain_caller_owned() {
    for (role, access) in [("actor", "write"), ("guardian", "read")] {
        let trusted = format!(r#"
default_permissions = "alma-{role}"
approval_policy = "never"
[permissions.alma-{role}.filesystem]
":minimal" = "read"
"/alma/frozen" = "read"
"/alma/frozen/output" = "{access}"
[permissions.alma-{role}.network]
enabled = false
[shell_environment_policy]
inherit = "none"
[shell_environment_policy.set]
HOME = "/alma/frozen"
BASH_ENV = "/dev/null"
ENV = "/dev/null"
PATH = "/bin"
[features]
network_proxy = true
credential_masking = true
write_stdin_approval = true
"#);
        for web in [false, true] {
            let mut value: TomlValue = toml::from_str(&trusted).unwrap();
            let before = value.clone();
            merge_toml_values(&mut value, &layer(web));
            for key in ["default_permissions", "approval_policy", "permissions", "shell_environment_policy"] {
                assert_eq!(value.get(key), before.get(key), "profile modified {key}");
            }
            assert!(value.get("sandbox_mode").is_none());
            assert!(value.get("sandbox_workspace_write").is_none());
            let cfg = parse(value);
            validate_alma_local_config(&cfg, web).unwrap();
            for feature in [Feature::NetworkProxy, Feature::CredentialMasking, Feature::WriteStdinApproval] {
                assert!(features(&cfg).enabled(feature));
            }
        }
    }
}

#[test]
fn privacy_and_interaction_settings_cannot_drift() {
    for (key, value) in [
        ("allow_login_shell", true.into()),
        ("history.persistence", "save-all".into()),
        ("analytics.enabled", true.into()),
        ("project_doc_max_bytes", 8192.into()),
        ("tools.experimental_request_user_input.enabled", true.into()),
        ("features.goals", true.into()),
    ] {
        let mut overrides = alma_local_cli_overrides(false);
        overrides.push((key.into(), value));
        assert!(validate_alma_local_config(&parse(build_cli_overrides_layer(&overrides)), false).is_err(), "accepted {key}");
    }
}
