#[path = "../../../../ALMA-codex/ios/native/src/persistent_home.rs"]
pub mod persistent_home;
#[path = "../../../../ALMA-codex/ios/native/src/scoped_files.rs"]
pub mod scoped_files;
#[path = "../../../shared/rust-bridge/codex-mobile-client/src/session_agent_role.rs"]
pub mod session_agent_role;
#[path = "../../../shared/rust-bridge/codex-mobile-client/src/session_agent_role_adapters.rs"]
pub mod session_agent_role_adapters;
#[path = "../../../shared/rust-bridge/codex-mobile-client/src/session_agent_store.rs"]
pub mod session_agent_store;
#[path = "../../../shared/rust-bridge/codex-mobile-client/src/session_agent_zcode_events.rs"]
pub mod session_agent_zcode_events;
#[path = "../../../shared/rust-bridge/codex-mobile-client/src/session_agent_codex_events.rs"]
pub mod session_agent_codex_events;

#[cfg(test)]
mod tests {
    use super::session_agent_store::*;
    use serde_json::json;
    use std::fs;
    use std::io::Write;
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn role_extraction_keeps_codex_instructions_byte_identical() {
        use super::session_agent_role::RoleAndCapabilities;
        use super::session_agent_role_adapters::{NativeRoleConfiguration, ProviderRoleAdapter};
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../shared/session-agent/roles/role-and-capabilities.json");
        let definition = RoleAndCapabilities::load(&path).unwrap();
        for language in ["简体中文", "English"] {
            let role = ProviderRoleAdapter::Codex
                .prepare_context(
                    &definition,
                    language,
                    "/workspace/shared/skills/builtin-v1",
                    "alma-builtin-v1",
                )
                .unwrap();
            let NativeRoleConfiguration::CodexDeveloperInstructions(actual) = role.configuration
            else {
                panic!("wrong role channel")
            };
            let expected = include_str!("fixtures/codex-role-before-extraction.txt")
                .replace("{SKILL_ROOT}", "shared/skills/builtin-v1")
                .replace("{language}", language);
            assert_eq!(actual, expected);
            assert_eq!(
                role.receipt.configuration_sha256,
                super::session_agent_role::sha256(&expected)
            );
        }
    }

    #[test]
    fn provider_adapters_preserve_one_role_and_expose_distinct_native_channels() {
        use super::session_agent_role::RoleAndCapabilities;
        use super::session_agent_role_adapters::{NativeRoleConfiguration, ProviderRoleAdapter};
        let definition = RoleAndCapabilities::load(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../shared/session-agent/roles/role-and-capabilities.json"),
        )
        .unwrap();
        let kimi = ProviderRoleAdapter::Kimi
            .prepare_context(
                &definition,
                "简体中文",
                "/workspace/shared/skills/builtin-v1",
                "alma-builtin-v1",
            )
            .unwrap();
        let zcode = ProviderRoleAdapter::Zcode
            .prepare_context(
                &definition,
                "简体中文",
                "/workspace/shared/skills/builtin-v1",
                "alma-builtin-v1",
            )
            .unwrap();
        assert_eq!(
            kimi.receipt.definition_sha256,
            zcode.receipt.definition_sha256
        );
        let NativeRoleConfiguration::KimiSystemFile {
            relative_path,
            contents,
        } = kimi.configuration
        else {
            panic!("wrong Kimi channel")
        };
        assert_eq!(relative_path, "SYSTEM.md");
        assert!(contents.starts_with("${base_prompt}\n\n"));
        assert_eq!(contents.matches("You are Alma's assistant").count(), 1);
        assert!(!contents.contains("skills.list"));
        let NativeRoleConfiguration::ZcodeSystemPrompt(body) = zcode.configuration else {
            panic!("wrong ZCode channel")
        };
        assert_eq!(body.matches("You are Alma's assistant").count(), 1);
        assert_eq!(contents.strip_prefix("${base_prompt}\n\n").unwrap(), body);
    }

    fn package() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../shared/session-agent/skills/builtin-v1")
    }

    fn workspace_root() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        SessionStore::install_skills(root.path(), &package()).unwrap();
        root
    }

    #[test]
    fn inference_edits_only_persist_settings_and_preserve_thread_journal_and_assets() {
        for provider in ["codex","kimi","zcode"] {
            let root=workspace_root();let mut store=SessionStore::open(root.path().to_owned()).unwrap();
            store.state.provider_id=provider.into();store.state.thread_id=Some("same-native-thread".into());
            store.state.model=Some("a".into());store.state.effort=Some("low".into());store.save_state().unwrap();
            store.record(json!({"kind":"user","id":"u","text":"Existing history"}),true).unwrap();
            store.record(json!({"kind":"started","turnId":"t"}),true).unwrap();
            store.record(json!({"kind":"finished","status":"completed","turnId":"t"}),true).unwrap();
            let journal=root.path().join("sessions").join(&store.state.session_id).join("conversation/events.jsonl");
            let before=fs::read(&journal).unwrap();let sequence=store.conversation.sequence;
            let models=json!([{"id":"a","model":"a","defaultReasoningEffort":"low","supportedReasoningEfforts":[{"reasoningEffort":"low"}]},
                {"id":"b","model":"b","defaultReasoningEffort":"medium","supportedReasoningEfforts":[{"reasoningEffort":"medium"},{"reasoningEffort":"high"}]}]);
            store.configure_inference(&json!({"model":"b"}),&models).unwrap();assert_eq!(store.state.effort.as_deref(),Some("medium"));
            store.configure_inference(&json!({"effort":"high"}),&models).unwrap();
            assert!(store.configure_inference(&json!({"model":"unknown"}),&models).is_err());
            assert!(store.configure_inference(&json!({"effort":"max"}),&models).is_err());
            assert_eq!(store.state.model.as_deref(),Some("b"));assert_eq!(store.state.effort.as_deref(),Some("high"));
            assert_eq!(store.state.thread_id.as_deref(),Some("same-native-thread"));assert_eq!(store.conversation.sequence,sequence);
            assert_eq!(fs::read(&journal).unwrap(),before);
            let reopened=SessionStore::open(root.path().to_owned()).unwrap();assert_eq!(reopened.state.model.as_deref(),Some("b"));assert_eq!(reopened.state.effort.as_deref(),Some("high"));
        }
    }

    #[test]
    fn live_delivery_snapshot_and_replay_share_tool_ownership_for_all_providers() {
        for provider in ["codex", "kimi", "zcode"] {
            let root = workspace_root();
            let mut store = SessionStore::open(root.path().to_owned()).unwrap();
            store.record(json!({"kind":"user","id":"u1","text":"read"}), true).unwrap();
            store.record(json!({"kind":"started","turnId":"t1"}), true).unwrap();
            let mut start = json!({"kind":"activity","activity":{"id":"read1","kind":"Read","text":"transcript.md","status":"running"}});
            if provider == "kimi" { start["turnId"] = json!("t1"); }
            else { start["activity"]["turnId"] = json!("t1"); }
            let live = store.record(start, true).unwrap();
            assert_eq!(live["activity"]["turnId"], "t1", "{provider}");
            let mut result = live.clone();
            result["activity"]["status"] = json!("completed");
            result["activity"]["text"] = json!("long result".repeat(1000));
            if provider == "kimi" {
                result["activity"].as_object_mut().unwrap().remove("turnId");
                result["activity"]["kind"] = json!("tool");
            }
            let delivered = store.record(result, true).unwrap();
            assert_eq!(delivered["activity"]["turnId"], "t1");
            assert_eq!(delivered["activity"]["kind"], "Read");
            assert_eq!(delivered["activity"]["text"].as_str().unwrap().len(), 11000);
            store.record(json!({"kind":"finished","turnId":"t1","status":"completed"}), true).unwrap();
            let reopened = SessionStore::open(root.path().to_owned()).unwrap();
            let log = reopened.working_log("u1").unwrap();
            assert_eq!(log["activities"][0]["turnId"], delivered["activity"]["turnId"]);
            assert_eq!(log["activities"][0]["kind"], delivered["activity"]["kind"]);
            assert_eq!(log["activities"][0]["text"], delivered["activity"]["text"]);
        }
    }

    #[test]
    fn legacy_outer_turn_events_and_late_results_keep_their_original_turn() {
        let mut conversation = Conversation::default();
        conversation.apply(&json!({"kind":"started","turnId":"t1"}));
        conversation.apply(&json!({"kind":"activity","turnId":"t1","activity":{"id":"read1","kind":"Read","text":"source","status":"running"}}));
        conversation.apply(&json!({"kind":"started","turnId":"t2"}));
        conversation.apply(&json!({"kind":"activity","activity":{"id":"read1","kind":"tool","text":"result","status":"completed"}}));
        assert_eq!(conversation.activities[0].turn_id.as_deref(), Some("t1"));
        assert_eq!(conversation.activities[0].kind, "Read");
        conversation.apply(&json!({"kind":"activity","turnId":"t1","activity":{"id":"late","kind":"Read","text":"source","status":"completed"}}));
        assert_eq!(conversation.activities[1].turn_id.as_deref(), Some("t1"));
    }

    #[test]
    fn public_tool_history_projects_status_instead_of_native_result_bodies() {
        let mut c = Conversation::default();
        c.apply(&json!({"kind":"started","turnId":"turn"}));
        c.apply(&json!({"kind":"activity","activity":{"id":"z","kind":"Read","text":json!({"toolCallId":"z","toolName":"Read","arguments":{"path":"transcript.md"}}).to_string(),"status":"running"}}));
        c.apply(&json!({"kind":"activity","activity":{"id":"z","kind":"tool_call_result","text":json!({"toolCallId":"z","duration":12.5,"result":{"success":true,"output":"PRIVATE FILE BODY"}}).to_string(),"status":"completed"}}));
        assert_eq!(c.activities[0].kind,"Read");
        assert_eq!(c.activities[0].text,"Read: transcript.md\nCompleted (total=13ms)");
        c.apply(&json!({"kind":"activity","activity":{"id":"k","kind":"Read","text":"\"Read\"","status":"running"}}));
        c.apply(&json!({"kind":"activity","activity":{"id":"k","kind":"tool","text":json!("PRIVATE FILE BODY").to_string(),"status":"completed"}}));
        assert_eq!(c.activities[1].text,"Completed: Read · 17 characters returned");
        assert!(!c.activities.iter().any(|a|a.text.contains("PRIVATE")));
    }

    #[test]
    fn actual_build35_zcode_history_recovers_skill_paths_and_ranges_without_rewriting() {
        let root = workspace_root();
        let store = SessionStore::open(root.path().to_owned()).unwrap();
        let journal = root.path().join("sessions").join(&store.state.session_id).join("conversation/events.jsonl");
        // Captured phone lifecycle shapes; file/Skill bodies replaced by a sentinel.
        let original = include_str!("fixtures/zcode-working-details.jsonl");
        fs::write(&journal, original).unwrap();
        let reopened = SessionStore::open(root.path().to_owned()).unwrap();
        let c = &reopened.conversation;
        assert!(c.activities.iter().any(|a|a.text.contains("Skill: asr-review")));
        assert!(c.activities.iter().any(|a|a.text.contains("List: . · pattern **/*")));
        assert!(c.activities.iter().any(|a|a.text.contains("Read: transcript.md · lines 778–1554")));
        assert!(!c.activities.iter().any(|a|a.text.contains("FILE_BODY_MUST_NOT_BE_RENDERED") || a.text.contains("/workspace/sessions/")));
        let full = reopened.working_log(&c.turns[0].id).unwrap();
        // The full log has a turn-local sequence; compare order and contents,
        // not its counter against the whole-conversation sequence.
        let without_sequence = |mut rows: serde_json::Value| {
            for row in rows.as_array_mut().unwrap() {row.as_object_mut().unwrap().remove("sequence");}
            rows
        };
        assert_eq!(without_sequence(full["activities"].clone()), without_sequence(serde_json::to_value(&c.activities).unwrap()));
        assert_eq!(fs::read_to_string(journal).unwrap(), original);
    }

    #[test]
    fn scheduled_arguments_survive_argumentless_start_progress_and_completion() {
        let root = workspace_root();
        let mut store = SessionStore::open(root.path().to_owned()).unwrap();
        store.record(json!({"kind":"user","id":"u","text":"inspect"}),true).unwrap();
        store.record(json!({"kind":"started","turnId":"t"}),true).unwrap();
        for (id,kind,input,expected) in [
            ("skill","Skill",json!({"skill":"asr-review"}),"Skill: asr-review"),
            ("glob","Glob",json!({"pattern":"*.md","path":"/workspace/sessions/s/workspace/assets"}),"List: assets · pattern *.md"),
            ("read","Read",json!({"file_path":"/workspace/sessions/s/workspace/transcript.md","offset":778,"limit":777}),"Read: transcript.md · lines 778–1554"),
            ("search","Grep",json!({"pattern":"NVIDIA","path":"transcript.md"}),"Search: transcript.md · pattern NVIDIA"),
            ("web","WebSearch",json!({"query":"NVIDIA CUDA terminology"}),"Web search: NVIDIA CUDA terminology"),
            ("write","Write",json!({"file_path":"assets/notes.md","content":"SECRET"}),"Write: assets/notes.md · 6 bytes requested"),
            ("edit","Edit",json!({"file_path":"assets/notes.md","old_string":"old","new_string":"new","replace_all":true}),"Edit: assets/notes.md · replace all occurrences · 3 → 3 characters"),
        ] {
            store.record(json!({"kind":"native_public_event","provider":"zcode","turnId":"t","event":{"type":"tool_call_scheduled","payload":{"toolCallId":id,"toolName":kind,"input":input}}}),false).unwrap();
            for status in ["running","running","completed"] {
                let payload = if status=="running" {json!({"toolCallId":id,"toolName":kind})} else {json!({"toolCallId":id,"duration":5,"result":{"success":true,"content":"SECRET"}})};
                let event=store.record(json!({"kind":"activity","turnId":"t","activity":{"id":id,"kind":if status=="running"{kind}else{"tool_call_result"},"text":payload.to_string(),"status":status}}),true).unwrap();
                assert_eq!(event["activity"]["callDetail"],expected);
                assert!(event["activity"]["text"].as_str().unwrap().starts_with(expected));
                assert!(!event["activity"]["text"].as_str().unwrap().contains("SECRET"));
                if status=="completed" {assert!(event["activity"]["text"].as_str().unwrap().contains("Completed"));}
            }
        }
        store.record(json!({"kind":"finished","status":"completed","turnId":"t"}),true).unwrap();
        let before=serde_json::to_value(&store.conversation.activities).unwrap();
        let after=SessionStore::open(root.path().to_owned()).unwrap();
        assert_eq!(before,serde_json::to_value(&after.conversation.activities).unwrap());
    }

    #[test]
    fn app_resource_update_changes_shared_instructions_without_changing_session() {
        let root = workspace_root();
        let original = SessionStore::open(root.path().to_owned()).unwrap();
        let resource = tempfile::tempdir().unwrap();
        for (_, _, relative) in SKILLS {
            let file = resource.path().join(relative);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::copy(package().join(relative), &file).unwrap();
        }
        let updated = resource.path().join("asr-review/SKILL.md");
        let text = fs::read_to_string(&updated).unwrap() + "\nApp resource revision.\n";
        fs::write(&updated, &text).unwrap();
        SessionStore::install_skills(root.path(), resource.path()).unwrap();
        let reopened = SessionStore::open(root.path().to_owned()).unwrap();
        assert_eq!(reopened.state.session_id, original.state.session_id);
        assert_eq!(reopened.state.source_sha256, original.state.source_sha256);
        assert_eq!(
            fs::read_to_string(root.path().join(SKILL_ROOT).join("asr-review/SKILL.md")).unwrap(),
            text
        );
        fs::write(
            resource.path().join("structured-notes/SKILL.md"),
            "invalid package",
        )
        .unwrap();
        assert!(SessionStore::install_skills(root.path(), resource.path()).is_err());
        assert_eq!(
            fs::read_to_string(root.path().join(SKILL_ROOT).join("asr-review/SKILL.md")).unwrap(),
            text
        );
    }

    #[test]
    fn container_relocation_preserves_selected_rollout_and_owner() {
        use super::persistent_home::relocated_rollout_path;
        use std::path::Path;
        let home = Path::new("/new/Alma/provider-state/codex/auth/session");
        let path = Path::new(
            "/old/Alma/provider-state/codex/auth/session/sessions/2026/11/16/selected.jsonl",
        );
        assert_eq!(
            relocated_rollout_path(home, path).unwrap().unwrap(),
            home.join("sessions/2026/11/16/selected.jsonl")
        );
        assert!(
            relocated_rollout_path(home, &home.join("sessions/2026/11/16/selected.jsonl"))
                .unwrap()
                .is_none()
        );
        assert!(
            relocated_rollout_path(
                home,
                Path::new("/old/Alma/provider-state/codex/other/session/sessions/selected.jsonl")
            )
            .is_err()
        );
        assert!(
            relocated_rollout_path(
                home,
                Path::new("/old/Alma/provider-state/codex/auth/session/../other.jsonl")
            )
            .is_err()
        );
        assert!(
            relocated_rollout_path(
                home,
                Path::new("/old/Alma/provider-state/codex/auth/session/config.toml")
            )
            .is_err()
        );
    }

    #[test]
    fn old_sessions_default_to_codex_and_guest_ids_round_trip_unchanged() {
        let root = workspace_root();
        let mut store = SessionStore::open(root.path().to_owned()).unwrap();
        let file = root.path().join("sessions").join(&store.state.session_id).join("conversation/session.json");
        let mut old = serde_json::to_value(&store.state).unwrap();
        old.as_object_mut().unwrap().remove("providerId");
        fs::write(&file, serde_json::to_vec(&old).unwrap()).unwrap();
        assert_eq!(SessionStore::open(root.path().to_owned()).unwrap().state.provider_id, "codex");
        for (provider, prefix) in [("kimi", "session_"), ("zcode", "sess_")] {
            store = SessionStore::create(root.path().to_owned()).unwrap();
            store.state.provider_id = provider.into();
            let thread = format!("{prefix}{}", uuid::Uuid::new_v4());
            store.state.thread_id = Some(thread.clone());
            store.bind(&"b".repeat(64)).unwrap();
            store.save_state().unwrap();
            let restored = SessionStore::open(root.path().to_owned()).unwrap();
            assert_eq!(restored.state.provider_id, provider);
            assert_eq!(restored.state.thread_id.as_deref(), Some(thread.as_str()));
            assert!(!restored.state.has_user_requests);
            assert!(restored.conversation.messages.is_empty());
            assert!(restored.assets().unwrap().is_empty());
        }
    }

    #[test]
    fn two_workspaces_share_one_immutable_package() {
        let root = workspace_root();
        let a = SessionStore::open(root.path().to_owned()).unwrap();
        let skill = root.path().join(SKILL_ROOT).join("asr-review/SKILL.md");
        let inode = fs::metadata(&skill).unwrap().ino();
        let b = SessionStore::create(root.path().to_owned()).unwrap();
        assert_ne!(a.state.session_id, b.state.session_id);
        assert!(a.assets().unwrap().is_empty());
        assert!(b.assets().unwrap().is_empty());
        assert!(!a.workspace().join(".agents").exists());
        assert_eq!(fs::metadata(&skill).unwrap().ino(), inode);
        SessionStore::select(root.path().to_owned(), &a.state.session_id).unwrap();
        assert_eq!(
            SessionStore::open(root.path().to_owned())
                .unwrap()
                .state
                .session_id,
            a.state.session_id
        );
        SessionStore::select(root.path().to_owned(), &b.state.session_id).unwrap();
        fs::remove_dir_all(root.path().join("sessions").join(&a.state.session_id)).unwrap();
        assert_eq!(fs::metadata(&skill).unwrap().ino(), inode);
        assert!(SessionStore::open(root.path().to_owned()).is_ok());
    }

    #[test]
    fn native_identity_and_partial_reply_survive_reopen_without_resubmission() {
        let root = workspace_root();
        let mut store = SessionStore::open(root.path().to_owned()).unwrap();
        store.bind(&"a".repeat(64)).unwrap();
        store.state.thread_id = Some("native-thread".into());
        store.save_state().unwrap();
        store
            .record(json!({"kind":"user","id":"u1","text":"question"}), true)
            .unwrap();
        store
            .record(json!({"kind":"user","id":"u1","text":"question"}), true)
            .unwrap();
        store
            .record(json!({"kind":"started","turnId":"t1"}), true)
            .unwrap();
        store
            .record(
                json!({"kind":"assistant","id":"a1","delta":"partial answer"}),
                false,
            )
            .unwrap();
        drop(store);
        let mut reopened = SessionStore::open(root.path().to_owned()).unwrap();
        assert_eq!(reopened.state.thread_id.as_deref(), Some("native-thread"));
        assert!(reopened.state.has_user_requests);
        assert_eq!(reopened.conversation.messages.len(), 2);
        assert_eq!(reopened.conversation.messages[1].text, "partial answer");
        assert_eq!(reopened.conversation.status, "interrupted");
        assert!(reopened.bind(&"b".repeat(64)).is_err());
        assert_eq!(
            reopened.state.authorization_id.as_deref(),
            Some("a".repeat(64).as_str())
        );
    }

    #[test]
    fn assets_are_direct_files_and_private_paths_cannot_be_read() {
        let root = workspace_root();
        let store = SessionStore::open(root.path().to_owned()).unwrap();
        fs::write(store.workspace().join("assets/note.md"), "changed directly").unwrap();
        assert_eq!(store.read("assets/note.md").unwrap(), "changed directly");
        assert_eq!(store.assets().unwrap().len(), 1);
        assert!(
            store
                .read("assets/../../conversation/session.json")
                .is_err()
        );
        assert!(store.read("../provider-state/codex/auth.json").is_err());
        assert!(
            store
                .read("shared/skills/builtin-v1/asr-review/SKILL.md")
                .is_err()
        );
        assert_eq!(
            fingerprint(store.read("transcript.md").unwrap().as_bytes()),
            store.state.source_sha256
        );
    }

    #[test]
    fn truncated_last_journal_record_is_not_replayed_but_middle_corruption_fails() {
        let root = workspace_root();
        let mut store = SessionStore::open(root.path().to_owned()).unwrap();
        store
            .record(json!({"kind":"user","id":"u1","text":"saved"}), true)
            .unwrap();
        let log = root
            .path()
            .join("sessions")
            .join(&store.state.session_id)
            .join("conversation/events.jsonl");
        fs::OpenOptions::new()
            .append(true)
            .open(&log)
            .unwrap()
            .write_all(b"{\"kind\":")
            .unwrap();
        let reopened = SessionStore::open(root.path().to_owned()).unwrap();
        assert_eq!(reopened.conversation.messages.len(), 1);
        fs::OpenOptions::new()
            .append(true)
            .open(&log)
            .unwrap()
            .write_all(b"not-json\n")
            .unwrap();
        assert!(SessionStore::open(root.path().to_owned()).is_err());
    }

    #[test]
    fn source_tampering_does_not_silently_reseed_workspace() {
        let root = workspace_root();
        let store = SessionStore::open(root.path().to_owned()).unwrap();
        fs::write(store.workspace().join("transcript.md"), "changed").unwrap();
        assert!(SessionStore::open(root.path().to_owned()).is_err());
        assert_eq!(
            fs::read_to_string(store.workspace().join("transcript.md")).unwrap(),
            "changed"
        );
    }
    #[test]
    fn turn_ownership_phases_and_full_working_log_survive_reopen() {
        let root = workspace_root();
        let mut store = SessionStore::open(root.path().to_owned()).unwrap();
        store.record(json!({"kind":"user","id":"u1","text":"first","timestampMs":1000}),true).unwrap();
        store.record(json!({"kind":"started","turnId":"t1","timestampMs":1100}),true).unwrap();
        store.record(json!({"kind":"assistant","id":"progress","text":"checking","phase":"commentary"}),false).unwrap();
        for index in 0..130 {
            store.record(json!({"kind":"activity","activity":{"id":format!("tool-{index}"),"kind":"commandExecution","text":"read file","status":"running"}}),false).unwrap();
            store.record(json!({"kind":"activity","activity":{"id":format!("tool-{index}"),"kind":"commandExecution","text":"read file","status":"completed"}}),false).unwrap();
        }
        store.record(json!({"kind":"assistant","id":"final","text":"done","phase":"final_answer","complete":true}),true).unwrap();
        store.record(json!({"kind":"finished","status":"completed","timestampMs":9000}),true).unwrap();
        store.record(json!({"kind":"user","id":"u2","text":"second","timestampMs":10000}),true).unwrap();
        store.record(json!({"kind":"started","turnId":"t2","timestampMs":11000}),true).unwrap();
        store.record(json!({"kind":"activity","activity":{"id":"second-tool","kind":"webSearch","text":"term","status":"completed"}}),false).unwrap();
        store.record(json!({"kind":"finished","status":"completed","timestampMs":12000}),true).unwrap();
        let restored = SessionStore::open(root.path().to_owned()).unwrap();
        assert_eq!(restored.conversation.turns.len(),2);
        assert_eq!(restored.conversation.turns[0].started_at_ms,Some(1000));
        assert_eq!(restored.conversation.turns[0].ended_at_ms,Some(9000));
        assert_eq!(restored.conversation.activities.len(),100);
        assert_eq!(restored.conversation.messages[2].phase.as_deref(),Some("final_answer"));
        let log=restored.working_log("u1").unwrap();
        assert_eq!(log["activities"].as_array().unwrap().len(),130);
        assert_eq!(log["limited"],false);
        assert!(log["activities"].as_array().unwrap().iter().all(|a|a["turnId"]=="t1"&&a["status"]=="completed"));
        assert_eq!(log["messages"].as_array().unwrap().len(),2);
        assert_eq!(log["messages"][0]["phase"],"commentary");
        assert!(log["messages"][0]["sequence"].as_u64()<log["activities"][0]["sequence"].as_u64());
        assert!(restored.working_log("another-session-user-id").is_err());
    }

    #[test]
    fn old_journal_can_be_grouped_without_inventing_timestamps_or_losing_text() {
        let mut c=Conversation::default();
        for event in [json!({"kind":"user","id":"u","text":"ask"}),json!({"kind":"started","turnId":"t"}),
            json!({"kind":"assistant","id":"a","delta":"part"}),
            json!({"kind":"activity","activity":{"id":"cmd","kind":"commandExecution","text":"ls","status":"completed"}}),
            json!({"kind":"assistant","id":"a","text":"part done","complete":true}),
            json!({"kind":"finished","status":"completed"})] {c.apply(&event);}
        assert_eq!(c.turns[0].started_at_ms,None);
        assert_eq!(c.turns[0].ended_at_ms,None);
        assert_eq!(c.messages[1].text,"part done");
        assert_eq!(c.activities[0].turn_id.as_deref(),Some("t"));
        c.apply(&json!({"kind":"assistant","id":"a","turnId":"t","text":"part done","phase":"final_answer","complete":true}));
        assert_eq!(c.messages.len(),2);
        assert_eq!(c.messages[1].phase.as_deref(),Some("final_answer"));
    }

}

#[cfg(test)]
#[path = "zcode_events.rs"]
mod zcode_events_tests;

#[cfg(test)]
mod codex_event_tests {
    use super::{session_agent_codex_events::auxiliary, session_agent_store::Conversation};
    use serde_json::json;

    #[test]
    fn compaction_and_retry_do_not_complete_the_user_turn() {
        let mut state = Conversation::default();
        state.apply(&json!({"kind":"user","id":"u","text":"make notes"}));
        state.apply(&json!({"kind":"started","turnId":"t"}));
        for event in [json!({"method":"thread/compacted","params":{}}), json!({"method":"error","params":{"turnId":"t","willRetry":true,"error":{"message":"private body"}}})] {
            let projected=auxiliary(&event,Some("t"),&state.activities).unwrap();
            assert!(!projected.to_string().contains("private body"));
            state.apply(&projected);
            assert_eq!(state.status,"running");
        }
        let maintenance=auxiliary(&json!({"method":"thread/compacted","params":{}}),None,&[]).unwrap();
        assert_eq!(maintenance["kind"],"maintenance");
    }

    #[test]
    fn codex_projects_public_summaries_and_plans_only_for_the_current_turn() {
        let private=json!({"method":"item/reasoning/textDelta","params":{"turnId":"t","delta":"private"}});
        assert!(auxiliary(&private,Some("t"),&[]).is_none());
        let public=json!({"method":"item/reasoning/summaryTextDelta","params":{"turnId":"t","itemId":"i","delta":"Reviewing source"}});
        assert_eq!(auxiliary(&public,Some("t"),&[]).unwrap()["activity"]["text"],"Reviewing source");
        assert!(auxiliary(&public,Some("other"),&[]).is_none());
        let plan=json!({"method":"turn/plan/updated","params":{"turnId":"t","plan":[{"step":"Read transcript","status":"completed"},{"step":"Write notes","status":"inProgress"}]}});
        assert_eq!(auxiliary(&plan,Some("t"),&[]).unwrap()["activity"]["text"],"[x] Read transcript\n[-] Write notes");
    }
}
