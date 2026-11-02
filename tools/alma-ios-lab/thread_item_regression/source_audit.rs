use std::collections::{HashMap, HashSet};
use syn::visit::Visit;

#[test]
fn all_scoped_files_parse_and_payload_constructors_match_upstream_fields() {
    let source = std::fs::read_to_string(std::env::var("THREAD_ITEM_UPSTREAM_ITEM").unwrap()).unwrap();
    let protocol = syn::parse_file(&source).unwrap();
    let payload = protocol.items.iter().find_map(|item| match item {
        syn::Item::Enum(item) if item.ident == "ThreadItemPayload" => Some(item),
        _ => None,
    }).unwrap();
    let fields: HashMap<_, HashSet<_>> = payload.variants.iter().map(|variant| {
        (variant.ident.to_string(), variant.fields.iter().filter_map(|field| field.ident.as_ref().map(ToString::to_string)).collect())
    }).collect();
    struct Audit<'a> { fields: &'a HashMap<String, HashSet<String>>, constructors: usize }
    impl<'ast> Visit<'ast> for Audit<'_> {
        fn visit_path(&mut self, path: &'ast syn::Path) {
            let segments: Vec<_> = path.segments.iter().map(|s| s.ident.to_string()).collect();
            if segments.len() >= 2 && segments[segments.len()-2] == "ThreadItem" {
                assert!(!self.fields.contains_key(segments.last().unwrap()), "old enum syntax remains: {segments:?}");
            }
            syn::visit::visit_path(self, path);
        }
        fn visit_macro(&mut self, node: &'ast syn::Macro) {
            if node.path.is_ident("vec") {
                use syn::parse::Parser;
                if let Ok(expressions) = syn::punctuated::Punctuated::<syn::Expr, syn::Token![,]>::parse_terminated.parse2(node.tokens.clone()) {
                    // The parsed temporary AST has a shorter lifetime; use a
                    // fresh visitor and carry its count back to this one.
                    let mut nested = Audit { fields: self.fields, constructors: 0 };
                    for expr in &expressions { nested.visit_expr(expr); }
                    self.constructors += nested.constructors;
                }
            }
        }
        fn visit_expr_struct(&mut self, node: &'ast syn::ExprStruct) {
            let segments: Vec<_> = node.path.segments.iter().map(|s| s.ident.to_string()).collect();
            if segments.len() >= 2 && segments[segments.len()-2] == "ThreadItemPayload" {
                assert!(node.rest.is_none(), "do not hide missing constructor fields");
                let actual = node.fields.iter().map(|field| match &field.member {
                    syn::Member::Named(name) => name.to_string(),
                    _ => panic!("unexpected field"),
                }).collect::<HashSet<_>>();
                assert_eq!(&actual, self.fields.get(segments.last().unwrap()).unwrap(), "{segments:?}");
                self.constructors += 1;
            }
            syn::visit::visit_expr_struct(self, node);
        }
    }
    let mut audit = Audit { fields: &fields, constructors: 0 };
    let root = std::env::var("THREAD_ITEM_MOBILE_SRC").unwrap();
    for file in ["conversation.rs", "session/events.rs", "mobile_client/event_loop.rs", "store/reconcile.rs", "mobile_client/store_listener.rs", "ffi/app_store.rs", "store/reducer.rs", "ffi/client.rs", "perf_profile.rs", "mobile_client/thread_projection.rs", "types/server_requests.rs", "types/models.rs", "mobile_client/dynamic_tools.rs", "mobile_client/mod.rs"] {
        let source = std::fs::read_to_string(format!("{root}/{file}")).unwrap();
        audit.visit_file(&syn::parse_file(&source).unwrap_or_else(|error| panic!("{file}: {error}")));
    }
    assert!(audit.constructors >= 30);
}

#[test]
fn completion_and_routing_guards_keep_the_wrapper() {
    let root = std::env::var("THREAD_ITEM_MOBILE_SRC").unwrap();
    let read = |file: &str| std::fs::read_to_string(format!("{root}/{file}")).unwrap();
    let reducer = read("store/reducer.rs");
    let completed = reducer.split("UiEvent::ItemCompleted { key, notification } => {").nth(1).unwrap().split("UiEvent::").next().unwrap();
    assert!(completed.contains("&notification.item.payload"));
    assert!(completed.contains("ThreadItemPayload::DynamicToolCall"));
    assert!(completed.contains("clear_dynamic_tool_arg_buffers_for_item(key, &item_id)"));
    assert!(completed.contains("ThreadItemPayload::Plan"));
    assert!(completed.contains("notification.item.clone()"));
    let events = read("session/events.rs");
    for kind in ["ItemStarted", "ItemCompleted"] {
        let branch = events.split(&format!("ServerNotification::{kind}(n) => {{")).nth(1).unwrap().split("ServerNotification::").next().unwrap();
        assert!(branch.contains("notification: n.clone()"));
    }
    let listener = read("mobile_client/store_listener.rs");
    let plan = listener.split("fn maybe_persist_thread_mode_from_event(").nth(1).unwrap().split("fn maybe_hydrate_collab_agent_metadata").next().unwrap();
    assert!(plan.contains("let UiEvent::ItemCompleted"));
    assert!(plan.contains("&notification.item.payload"));
    assert!(plan.contains("ThreadItemPayload::Plan"));
    let client = read("ffi/client.rs");
    assert!(client.split_whitespace().collect::<String>().contains("ThreadItemPayload::AgentMessage{text,..}=&notification.item.payload"));
}

#[test]
fn removed_optional_apis_fail_before_rpc_and_fork_uses_turn_id() {
    let root = std::env::var("THREAD_ITEM_MOBILE_SRC").unwrap();
    let read = |file: &str| std::fs::read_to_string(format!("{root}/{file}")).unwrap();
    for (file, name) in [
        ("ffi/client.rs", "resolve_realtime_handoff"),
        ("ffi/client.rs", "finalize_realtime_handoff"),
        ("mobile_client/mod.rs", "edit_message"),
    ] {
        let source = read(file);
        let method = source.split(&format!("pub async fn {name}(")).nth(1).unwrap()
            .split("pub async fn ").next().unwrap();
        assert!(method.contains("Err("));
        assert!(method.contains("unsupported"));
        assert!(!method.contains(".await"), "{name} must reject before RPC");
        assert!(!method.contains("blocking_async!"));
        assert!(!method.contains("request_typed"));
    }
    let source = read("mobile_client/mod.rs");
    let fork = source.split("pub async fn fork_thread_from_message(").nth(1).unwrap()
        .split("pub async fn ").next().unwrap();
    assert!(fork.find("fork_boundary_turn_id(").unwrap() < fork.find(".server_thread_fork(").unwrap());
    assert!(fork.contains("params.last_turn_id = Some(last_turn_id)"));
    assert!(!source.contains("upstream::ThreadRollback"));
    assert!(read("types/server_requests.rs").contains("detached review is unsupported"));
    assert!(!read("session/events.rs").contains("ServerNotification::DynamicToolCallArgumentsDelta"));
}
