//! Shared mobile client library for iOS / Android.
//!
//! This crate owns the single public UniFFI surface for mobile. Keep shared
//! business logic here so Swift/Kotlin only compile one binding set.

// Upstream app-server dispatch futures exceed the default layout query depth on iOS.
#![recursion_limit = "256"]

// Provider sources are composed behind the existing single UniFFI facade.
// Kimi's shared execution imports resolve to the exact Codex fork modules below.
extern crate self as alma_codex_ios;

#[path = "../../../../../ALMA-codex/ios/native/src/auth_refresh.rs"]
pub mod auth_refresh;
pub mod tah_attempt;
#[path = "../../../../../ALMA-codex/ios/native/src/execution_fence.rs"]
pub mod execution_fence;
#[cfg(all(target_os="ios",not(target_abi="macabi"),feature="alma-code-mode-probe"))]
mod tah_runner;

#[uniffi::export(async_runtime="tokio")]
pub async fn tah_qualification_inspect(server_id:String,account_fingerprint:String) -> String {
    #[cfg(all(target_os="ios",not(target_abi="macabi"),feature="alma-code-mode-probe"))]
    { return tah_runner::discover(server_id,account_fingerprint).await.to_string(); }
    #[cfg(not(all(target_os="ios",not(target_abi="macabi"),feature="alma-code-mode-probe")))]
    { let _=(server_id,account_fingerprint); "{\"outcome\":\"failure\",\"failure\":\"qualification_unavailable\"}".into() }
}

#[uniffi::export(async_runtime="tokio")]
pub async fn tah_qualification_execute(server_id:String,account_fingerprint:String) -> String {
    #[cfg(all(target_os="ios",not(target_abi="macabi"),feature="alma-code-mode-probe"))]
    {
        let mut report=tah_runner::run(server_id.clone(),account_fingerprint).await;
        alma_workspace::close_attempt_admission();
        if let Ok(session)=ffi::shared::shared_mobile_client().get_session(&server_id) {session.disconnect().await;}
        let deadline=tokio::time::Instant::now()+std::time::Duration::from_secs(15);
        loop {
            match alma_workspace::attempt_health() {
                Some((0,false))=>{report["quiescenceObserved"]=serde_json::json!(true);break;}
                Some((_,true))|None=>{report["outcome"]=serde_json::json!("failure");report["failure"]=serde_json::json!("attempt_quarantined_or_missing");break;}
                _ if tokio::time::Instant::now()>=deadline=>{report["outcome"]=serde_json::json!("failure");report["failure"]=serde_json::json!("attempt_drain_timeout");break;}
                _=>tokio::time::sleep(std::time::Duration::from_millis(25)).await,
            }
        }
        if report["outcome"]=="observed" {
            match tah_attempt::capture_candidates() {
                Ok(snapshot)=>report["snapshot"]=snapshot,
                Err(_)=>{report["outcome"]=serde_json::json!("failure");report["failure"]=serde_json::json!("candidate_snapshot_failed");}
            }
        }
        report["requiresExternalProcessExitVerification"]=serde_json::json!(true);
        return report.to_string();
    }
    #[cfg(not(all(target_os="ios",not(target_abi="macabi"),feature="alma-code-mode-probe")))]
    { let _=(server_id,account_fingerprint); "{\"outcome\":\"failure\",\"failure\":\"qualification_unavailable\"}".into() }
}
#[path = "../../../../../ALMA-codex/ios/native/src/alma_local_profile.rs"]
mod alma_local_profile;
#[cfg(all(target_os = "ios", not(target_abi = "macabi"), feature = "alma-code-mode-probe"))]
#[path = "../../../../../ALMA-codex/ios/native/src/alma_code_mode.rs"]
mod alma_code_mode;
#[cfg(all(target_os = "ios", not(target_abi = "macabi"), feature = "alma-code-mode-probe"))]
#[path = "../../../../../ALMA-codex/ios/native/src/provider_backend.rs"]
mod provider_backend;
#[cfg(all(target_os = "ios", not(target_abi = "macabi"), feature = "alma-code-mode-probe"))]
#[path = "../../../../../ALMA-codex/ios/native/src/provider_scope.rs"]
pub mod provider_scope;
#[cfg(all(target_os = "ios", not(target_abi = "macabi"), feature = "alma-code-mode-probe"))]
#[path = "../../../../../ALMA-codex/ios/native/src/provider_bridge.rs"]
mod provider_bridge;
#[cfg(all(target_os = "ios", not(target_abi = "macabi"), feature = "alma-code-mode-probe"))]
#[path = "../../../../../ALMA-codex/ios/native/src/provider_runtime_config.rs"]
mod provider_runtime_config;
#[cfg(all(target_os = "ios", not(target_abi = "macabi"), feature = "alma-code-mode-probe"))]
mod mobile_tah_host;
#[cfg(all(target_os = "ios", not(target_abi = "macabi"), feature = "alma-code-mode-probe"))]
#[path = "../../../../../ALMA-ZCode/ios/native/src/lib.rs"]
mod zcode_native;
#[cfg(all(target_os = "ios", not(target_abi = "macabi"), feature = "alma-code-mode-probe"))]
mod mobile_zcode;
#[cfg(all(target_os = "ios", not(target_abi = "macabi"), feature = "alma-code-mode-probe"))]
#[path = "../../../../../ALMA-codex/ios/native/src/runtime_bootstrap.rs"]
mod runtime_bootstrap;
#[cfg(all(target_os = "ios", not(target_abi = "macabi"), feature = "alma-code-mode-probe"))]
#[path = "../../../../../ALMA-kimi-code/ios/native/src/kimi_backend.rs"]
mod kimi_backend;
#[cfg(all(target_os = "ios", not(target_abi = "macabi"), feature = "alma-code-mode-probe"))]
#[path = "../../../../../ALMA-kimi-code/ios/native/src/kimi_assets.rs"]
mod kimi_assets;

#[cfg(all(target_os = "ios", not(target_abi = "macabi")))]
#[path = "../../../../../ALMA-codex/ios/native/src/embedded_runtime.rs"]
mod embedded_runtime;
#[cfg(all(target_os = "ios", not(target_abi = "macabi")))]
mod alma_workspace;

#[cfg(all(target_os = "ios", not(target_abi = "macabi")))]
#[path = "../../../../../ALMA-codex/ios/native/src/ish_exec_backend.rs"]
pub mod ish_exec_backend;

#[cfg(unix)]
#[path = "../../../../../ALMA-codex/ios/native/src/scoped_files.rs"]
pub mod scoped_files;
#[cfg(unix)]
#[path = "../../../../../ALMA-codex/ios/native/src/scoped_executor_fs.rs"]
pub mod scoped_executor_fs;

#[cfg(all(target_os = "ios", not(target_abi = "macabi")))]
pub mod ish_runtime;

// Always-compiled UniFFI-visible types. The host cdylib that
// `generate-bindings.sh` feeds to uniffi-bindgen must contain these so the
// generated Swift/Kotlin has `IshRunResult` / `IshBootstrapError` /
// `ishBootstrap` / `ishDefaultCwd` / `ishRun` symbols on every lane.
#[path = "../../../../../ALMA-codex/ios/native/src/ish_types.rs"]
pub mod ish_types;
pub mod proot_types;

pub use ish_types::{IshBootstrapError, IshRunResult};
pub use proot_types::ProotBootstrapError;

/// One-time iSH bootstrap. Swift passes the bundle's `fs/` resource dir, the
/// app's Application Support dir, and the Documents dir; Rust does the
/// rootfs extraction and owned-job kernel boot. Replaces the old
/// `codex_ish_init` + `litter_install_ish_hook` C entry points.
///
/// Non-iOS targets (Catalyst, Android, host bindgen) return
/// `IshBootstrapError::Unsupported` — the kernel is iOS-only and not linked
/// into those builds.
#[uniffi::export]
pub fn ish_bootstrap(
    bundle_fs_path: String,
    application_support_dir: String,
    documents_dir: String,
) -> Result<(), IshBootstrapError> {
    #[cfg(all(target_os = "ios", not(target_abi = "macabi")))]
    {
        return ish_runtime::bootstrap(
            std::path::Path::new(&bundle_fs_path),
            std::path::Path::new(&application_support_dir),
            std::path::Path::new(&documents_dir),
        );
    }
    #[cfg(not(all(target_os = "ios", not(target_abi = "macabi"))))]
    {
        let _ = (bundle_fs_path, application_support_dir, documents_dir);
        Err(IshBootstrapError::Unsupported {
            detail: "iSH is iOS-only".into(),
        })
    }
}

/// Default working directory for iSH-backed local sessions. Always `/root`
/// (the standard Alpine home for the root user inside the fakefs). Safe to
/// call on every platform — it's a pure constant.
#[uniffi::export]
pub fn ish_default_cwd() -> String {
    "/root".to_string()
}

/// One-time Android proot bootstrap. Kotlin passes the app's native library
/// directory, the copied Alpine rootfs archive path, and the app data
/// directory; Rust extracts the rootfs and verifies that `libproot.so` can
/// enter it.
#[uniffi::export]
pub fn proot_bootstrap(
    proot_lib_dir: String,
    rootfs_archive: String,
    data_dir: String,
) -> Result<(), ProotBootstrapError> {
    #[cfg(target_os = "android")]
    {
        return proot_runtime::bootstrap(
            std::path::Path::new(&proot_lib_dir),
            std::path::Path::new(&rootfs_archive),
            std::path::Path::new(&data_dir),
        );
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (proot_lib_dir, rootfs_archive, data_dir);
        Err(ProotBootstrapError::Unsupported {
            detail: "proot is Android-only".into(),
        })
    }
}

/// Run `cmd` through the persistent iSH `/bin/sh`. An empty `cwd` means "no
/// cd wrapping" (run in the kernel's current dir). Output is merged
/// stdout+stderr; `exit_code` is the process exit code, or a negative
/// `ISH_E_*` value if dispatch failed.
///
/// Non-iOS targets return `exit_code = -1` and a stub "unsupported on this
/// platform" message so Swift callers can uniformly handle the failure.
#[uniffi::export]
pub fn ish_run(cmd: String, cwd: String) -> IshRunResult {
    #[cfg(all(target_os = "ios", not(target_abi = "macabi")))]
    {
        let cwd_opt = if cwd.is_empty() {
            None
        } else {
            Some(cwd.as_str())
        };
        let (exit_code, output) = ish_runtime::run(&cmd, cwd_opt, None);
        return IshRunResult { exit_code, output };
    }
    #[cfg(not(all(target_os = "ios", not(target_abi = "macabi"))))]
    {
        let _ = (cmd, cwd);
        IshRunResult {
            exit_code: -1,
            output: b"unsupported on this platform\n".to_vec(),
        }
    }
}

mod local_studio;
mod remote_dir_cache;
#[cfg(any(all(target_os = "ios", not(target_abi = "macabi")), test))]
mod mobile_exec_command;
mod shell_quoting;
pub(crate) mod ssh_scripts;
#[cfg(any(target_os = "android", test))]
mod tls_roots;

#[cfg(target_os = "android")]
mod android_context;
#[cfg(target_os = "android")]
pub mod android_exec;
#[cfg(target_os = "android")]
pub mod proot_runtime;

#[cfg(any(
    all(target_os = "ios", not(target_abi = "macabi")),
    target_os = "android",
    test
))]
pub mod shell_preflight;

mod alleycat_types;
pub mod network_scope;
#[cfg(feature = "remote-alleycat")]
pub mod alleycat;
#[cfg(not(feature = "remote-alleycat"))]
#[path = "alleycat_disabled.rs"]
pub mod alleycat;
pub mod cloud_sync;
pub mod conversation;
pub mod conversation_uniffi;
pub mod ffi;
mod home_cache;
pub mod hydration;
mod local_runtime_instructions;
pub mod local_server;
pub mod logging;
pub mod markdown_blocks;
mod mobile_client;
pub mod pair;
pub mod parser;
pub mod permissions;
pub mod pets;
pub mod plugin_refs;
pub mod preferences;
pub mod project;
pub mod reconnect;
pub mod recorder;
pub mod remote_path;
pub mod saved_apps;
pub mod runtime_settings;
pub mod session;
pub(crate) mod slingshot_url;
pub mod ssh;
pub mod ssh_bridge;
pub(crate) mod ssh_detect_cache;
pub mod ssh_detached_launcher;
pub mod ssh_launcher;
pub mod store;
pub mod terminal;
mod thread_modes;
pub mod transport;
pub mod thread_display_text;
pub mod types;
pub mod widget_guidelines;

#[cfg(test)]
mod perf_profile;

pub use mobile_client::*;

// ── Shared infra ─────────────────────────────────────────────────────────

use std::sync::atomic::{AtomicI64, Ordering};

static REQUEST_COUNTER: AtomicI64 = AtomicI64::new(1);
pub(crate) const MOBILE_ASYNC_THREAD_STACK_SIZE_BYTES: usize = 4 * 1024 * 1024;

pub(crate) fn next_request_id() -> i64 {
    REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)
}

#[derive(Debug, thiserror::Error)]
pub enum RpcClientError {
    #[error("RPC: {0}")]
    Rpc(String),
    #[error("Serialization: {0}")]
    Serialization(String),
}

uniffi::setup_scaffolding!();
