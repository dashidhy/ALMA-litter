//! Native-only configuration/authentication seam below the mobile Codex Adapter.
//!
//! `load` resolves configuration before the scope factory binds its enforcing
//! environment. `into_start_args` then requires that exact immutable environment;
//! there is no ambient/test environment fallback. Neither operation handshakes.
//! The caller forwards the Adapter's real initialize/initialized exchange, then
//! awaits `install_native_tokens` before allowing account/model/quota/turn calls.
//! Tokens arrive through the existing typed native record, never a JS payload.

use crate::auth_refresh::ChatgptAuthRefreshTokens;
use crate::embedded_runtime::EmbeddedRuntime;
use crate::provider_backend::ProviderBackend;
use codex_app_server::in_process::{EmbeddedNetworkPolicy, InProcessStartArgs};
use codex_app_server_protocol::{
    ClientInfo, InitializeCapabilities, InitializeParams, LoginAccountParams, LoginAccountResponse,
};
use codex_arg0::Arg0DispatchPaths;
use codex_cloud_config::managed_config_bundle_loader;
use codex_config::{CloudConfigBundleLoader, LoaderOverrides, TomlValue};
use codex_core::config::{Config, ConfigBuilder};
use codex_feedback::CodexFeedback;
use codex_login::{
    AuthConfig, AuthManager, CodexAuth, ExternalAuth, ExternalAuthFuture, ExternalAuthRefreshContext,
};
use codex_protocol::config_types::ForcedLoginMethod;
use codex_protocol::protocol::SessionSource;
use std::collections::HashSet;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};

const CHANNEL_CAPACITY: usize = 256;
const MAX_ACCESS_TOKEN_BYTES: usize = 32 * 1024;
const MAX_ACCOUNT_ID_BYTES: usize = 512;
const MAX_PLAN_BYTES: usize = 128;
const ALMA_CLIENT_NAME: &str = "@alma/tah-codex-guest";
const MOBILE_CA_BUNDLE: &[u8] = include_bytes!("cacert.pem");
static PROCESS_INIT: OnceLock<Result<PathBuf>> = OnceLock::new();

/// No upstream error strings, request payloads or account identity escape this
/// boundary. In particular RPC errors may echo the supplied account or token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum RuntimeConfigError {
    #[error("mobile provider process initialization failed or conflicts with prior initialization")]
    ProcessInit,
    #[error("mobile provider process must be initialized before creating clients")]
    ProcessNotInitialized,
    #[error("invalid private provider home or explicit guest cwd")]
    InvalidPaths,
    #[error("invalid or duplicate trusted provider overrides")]
    InvalidOverrides,
    #[error("native ChatGPT credentials are invalid")]
    InvalidCredentials,
    #[error("effective requirements reject the native ChatGPT account")]
    AuthPolicy,
    #[error("provider bootstrap configuration failed")]
    BootstrapConfig,
    #[error("provider bootstrap authentication failed")]
    BootstrapAuth,
    #[error("provider effective configuration failed")]
    ResolvedConfig,
    #[error("provider configuration differs from its explicit execution context")]
    ExecutionMismatch,
    #[error("provider native credential installation failed")]
    LoginFailed,
    #[error("provider returned an unexpected native credential receipt")]
    LoginReceipt,
    #[error("provider temporary native credential cleanup failed")]
    CredentialCleanup,
}

type Result<T> = std::result::Result<T, RuntimeConfigError>;

/// One app-start-only operation, BEFORE starting the host Tokio runtime or
/// constructing any Codex HTTP/WebSocket/auth client. `support` is a private,
/// persistent native directory, not a per-attempt home or guest mount. Repeated
/// calls with the same canonical path are read-only; another path/config fails.
/// This does not select CODEX_HOME, HOME, SSH_HOME, CURL_HOME or process cwd.
///
/// # Safety
/// The first call may set SSL_CERT_FILE. The caller must ensure exclusive access
/// to the process environment during that first call (including foreign code),
/// as required by std::env::set_var. A Rust mutex alone cannot provide that.
/// Invoke synchronously during native startup, never from a JS/async task.
pub(crate) unsafe fn initialize_mobile_provider_process(support: &Path) -> Result<()> {
    let canonical = support
        .canonicalize()
        .map_err(|_| RuntimeConfigError::ProcessInit)?;
    if !normalized_absolute(&canonical) || !canonical.is_dir() {
        return Err(RuntimeConfigError::ProcessInit);
    }
    let state = PROCESS_INIT.get_or_init(|| {
        let pem = canonical.join("alma-provider-cacert.pem");
        // CODEX_CA_CERTIFICATE has precedence over SSL_CERT_FILE in the real
        // upstream shared HTTP/WebSocket trust-store loader. Never ignore a
        // conflicting higher-precedence setting or silently replace its roots.
        for key in ["CODEX_CA_CERTIFICATE", "SSL_CERT_FILE"] {
            if let Some(existing) = std::env::var_os(key)
                && !existing.is_empty()
                && Path::new(&existing) != pem
            {
                return Err(RuntimeConfigError::ProcessInit);
            }
        }
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pem)
        {
            Ok(mut file) => {
                file.write_all(MOBILE_CA_BUNDLE)
                    .map_err(|_| RuntimeConfigError::ProcessInit)?;
                file.sync_all().map_err(|_| RuntimeConfigError::ProcessInit)?;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let metadata = std::fs::symlink_metadata(&pem)
                    .map_err(|_| RuntimeConfigError::ProcessInit)?;
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || metadata.len() != MOBILE_CA_BUNDLE.len() as u64
                    || std::fs::read(&pem).map_err(|_| RuntimeConfigError::ProcessInit)?
                        != MOBILE_CA_BUNDLE
                {
                    return Err(RuntimeConfigError::ProcessInit);
                }
            }
            Err(_) => return Err(RuntimeConfigError::ProcessInit),
        }
        use codex_login::default_client::{SetOriginatorError, originator, set_default_originator};
        match set_default_originator(ALMA_CLIENT_NAME.into()) {
            Ok(()) | Err(SetOriginatorError::AlreadyInitialized) => {}
            Err(SetOriginatorError::InvalidHeaderValue) => {
                return Err(RuntimeConfigError::ProcessInit);
            }
        }
        if originator().value != ALMA_CLIENT_NAME {
            return Err(RuntimeConfigError::ProcessInit);
        }
        // SAFETY: forwarded from the first-call startup precondition above.
        unsafe {
            std::env::set_var("SSL_CERT_FILE", &pem);
        }
        Ok(canonical.clone())
    });
    if state.as_ref().map_err(|error| *error)? != &canonical {
        return Err(RuntimeConfigError::ProcessInit);
    }
    require_process_initialized()
}

fn require_process_initialized() -> Result<()> {
    let support = PROCESS_INIT
        .get()
        .ok_or(RuntimeConfigError::ProcessNotInitialized)?
        .as_ref()
        .map_err(|error| *error)?;
    let pem = support.join("alma-provider-cacert.pem");
    if std::env::var_os("SSL_CERT_FILE").as_deref() != Some(pem.as_os_str())
        || codex_login::default_client::originator().value != ALMA_CLIENT_NAME
        || std::env::var_os("CODEX_CA_CERTIFICATE")
            .is_some_and(|value| !value.is_empty() && value != pem.as_os_str())
    {
        return Err(RuntimeConfigError::ProcessInit);
    }
    Ok(())
}

/// Deliberately neither Serialize nor Debug: the cloud loader owns a native
/// bootstrap auth provider. This object must not enter a JS/UniFFI result DTO.
pub(crate) struct PreparedRuntimeConfig {
    config: Arc<Config>,
    cli_overrides: Vec<(String, TomlValue)>,
    loader_overrides: LoaderOverrides,
    cloud_config_bundle: CloudConfigBundleLoader,
    embedded_network_policy: EmbeddedNetworkPolicy,
    provider_web: bool,
}

impl PreparedRuntimeConfig {
    /// `controller_home` is an existing private scope-factory directory outside
    /// the iSH mount; `guest_cwd` is its logical workspace path. The caller owns
    /// both roots and their lifetime. It supplies the COMPLETE trusted native
    /// overrides (including model, effort, tool and filesystem configuration).
    /// No profile entries are added, removed, flattened or silently overwritten.
    ///
    /// Uses the real bootstrap -> authenticated managed requirements -> resolved
    /// ConfigBuilder path. Loading may contact the official config service; it
    /// never starts inference. A failure is not retried with bootstrap defaults.
    pub(crate) async fn load(
        controller_home: PathBuf,
        guest_cwd: PathBuf,
        cli_overrides: Vec<(String, TomlValue)>,
        provider_web: bool,
        tokens: &ChatgptAuthRefreshTokens,
    ) -> Result<Self> {
        require_process_initialized()?;
        validate_paths(&controller_home, &guest_cwd)?;
        validate_overrides(&cli_overrides)?;
        let native_auth = parse_native_auth(tokens)?;
        let loader_overrides = LoaderOverrides::default();
        let embedded_network_policy = EmbeddedNetworkPolicy::load(&loader_overrides).await;
        let builder = || {
            ConfigBuilder::default()
                .codex_home(controller_home.clone())
                .fallback_cwd(Some(guest_cwd.clone()))
                .cli_overrides(cli_overrides.clone())
                .loader_overrides(loader_overrides.clone())
                .without_project_context()
                .strict_config(true)
        };
        let base_config = builder()
            .build()
            .await
            .map_err(|_| RuntimeConfigError::BootstrapConfig)?;
        validate_resolved_paths(&base_config, &controller_home, &guest_cwd)?;
        let bootstrap_auth = embedded_network_policy.bind_bootstrap_auth(base_config.auth_config());
        validate_auth_policy(&bootstrap_auth, &tokens.account_id)?;
        let bootstrap_http = bootstrap_auth.auth_route_config.http_client_factory().clone();
        let auth_manager = AuthManager::shared_from_auth_config(
            bootstrap_auth,
            /* enable_codex_api_key_env */ false,
        )
        .await
        .map_err(|_| RuntimeConfigError::BootstrapAuth)?;
        // ExternalAuth only installs an in-memory auth value. It does not write
        // auth.json, copy a desktop credential, or implement a second refresh
        // mechanism. This bootstrap provider is confined to config discovery.
        let mut bootstrap_cleanup = BootstrapCredentialCleanup {
            home: controller_home.clone(),
            armed: true,
        };
        auth_manager
            .set_external_auth(Arc::new(BootstrapNativeAuth(native_auth)))
            .await
            .map_err(|_| RuntimeConfigError::BootstrapAuth)?;
        let cloud_config_bundle = managed_config_bundle_loader(
            auth_manager,
            base_config.chatgpt_base_url.clone(),
            base_config.codex_home.to_path_buf(),
            bootstrap_http,
            base_config.config_layer_stack.requirements_toml(),
        );
        let mut resolved_config = builder()
            .cloud_config_bundle(cloud_config_bundle.clone())
            .build()
            .await
            .map_err(|_| RuntimeConfigError::ResolvedConfig)?;
        validate_resolved_paths(&resolved_config, &controller_home, &guest_cwd)?;
        validate_auth_policy(&resolved_config.auth_config(), &tokens.account_id)?;
        let expected_web = if provider_web {
            codex_protocol::config_types::WebSearchMode::Live
        } else {
            codex_protocol::config_types::WebSearchMode::Disabled
        };
        if resolved_config.web_search_mode.value() != expected_web {
            return Err(RuntimeConfigError::ExecutionMismatch);
        }
        embedded_network_policy.activate(&mut resolved_config);
        // The native handle owner now owns cleanup, including a failed start.
        // App Server startup intentionally sees this home-keyed ephemeral auth.
        bootstrap_cleanup.armed = false;
        Ok(Self {
            config: Arc::new(resolved_config),
            cli_overrides,
            loader_overrides,
            cloud_config_bundle,
            embedded_network_policy,
            provider_web,
        })
    }

    pub(crate) fn config(&self) -> Arc<Config> {
        self.config.clone()
    }

    pub(crate) fn cli_overrides(&self) -> Vec<(String, TomlValue)> {
        self.cli_overrides.clone()
    }

    /// Call only AFTER PreparedScope.bind(config(), cli_overrides()). The bound
    /// context validates the resolved native permissions/environment itself.
    pub(crate) fn into_start_args(
        self,
        execution: Arc<EmbeddedRuntime>,
    ) -> Result<InProcessStartArgs> {
        if execution.config_overrides() != self.cli_overrides
            || execution.provider_web != self.provider_web
            || execution
                .guest_cwd()
                .map_err(|_| RuntimeConfigError::ExecutionMismatch)?
                != self.config.cwd.to_path_buf()
        {
            return Err(RuntimeConfigError::ExecutionMismatch);
        }
        let environment_manager = execution
            .manager(&self.config)
            .map_err(|_| RuntimeConfigError::ExecutionMismatch)?;
        Ok(InProcessStartArgs {
            arg0_paths: Arg0DispatchPaths::default(),
            config: self.config,
            cli_overrides: self.cli_overrides,
            loader_overrides: self.loader_overrides,
            strict_config: true,
            cloud_config_bundle: self.cloud_config_bundle,
            embedded_network_policy: self.embedded_network_policy,
            feedback: CodexFeedback::new(),
            log_db: None,
            state_db: None,
            thread_config_loader: Arc::new(codex_config::NoopThreadConfigLoader),
            environment_manager,
            config_warnings: Vec::new(),
            session_source: SessionSource::VSCode,
            enable_codex_api_key_env: false,
            // Required by upstream's args type, UNUSED by start_uninitialized.
            // The Adapter's actual wire initialize is the sole real handshake.
            initialize: InitializeParams {
                client_info: ClientInfo {
                    name: ALMA_CLIENT_NAME.into(),
                    version: "1.0.0".into(),
                    title: Some("ALMA TAH Codex Guest".into()),
                },
                capabilities: Some(InitializeCapabilities {
                    experimental_api: true,
                    request_attestation: false,
                    opt_out_notification_methods: None,
                    ..Default::default()
                }),
            },
            channel_capacity: CHANNEL_CAPACITY,
        })
    }
}

/// Private native wrapper calls this once after forwarding/awaiting initialized
/// and before releasing that notify to JS or admitting account/model requests.
/// The wrapper owns one-shot state, account pinning, cancellation and refresh;
/// the helper neither fabricates initialize nor returns credentials to the JS
/// Adapter. Keep account/chatgptAuthTokens/refresh on the native event handler.
pub(crate) async fn install_native_tokens(
    backend: &ProviderBackend,
    tokens: ChatgptAuthRefreshTokens,
) -> Result<()> {
    // Parse before enqueue so malformed credentials never reach the transport.
    let _ = parse_native_auth(&tokens)?;
    let params = LoginAccountParams::ChatgptAuthTokens {
        access_token: tokens.access_token,
        chatgpt_account_id: tokens.account_id,
        chatgpt_plan_type: tokens.plan_type,
    };
    let params = serde_json::to_value(params).map_err(|_| RuntimeConfigError::InvalidCredentials)?;
    let receipt = backend
        .request("account/login/start", params)
        .await
        .map_err(|_| RuntimeConfigError::LoginFailed)?;
    validate_login_receipt(receipt)
}

/// Call after runtime close/drain, and when a prepared start is abandoned. This
/// removes ONLY upstream's process-local ephemeral entry for the private home;
/// it neither signs the user out of Keychain nor deletes/revokes their account.
/// Do not call while the corresponding runtime/config loader can still run.
pub(crate) fn clear_native_tokens(controller_home: &Path) -> Result<()> {
    if !normalized_absolute(controller_home) {
        return Err(RuntimeConfigError::InvalidPaths);
    }
    codex_login::logout(
        controller_home,
        codex_login::AuthCredentialsStoreMode::Ephemeral,
        codex_login::AuthKeyringBackendKind::default(),
    )
    .map(|_| ())
    .map_err(|_| RuntimeConfigError::CredentialCleanup)
}

struct BootstrapCredentialCleanup {
    home: PathBuf,
    armed: bool,
}

impl Drop for BootstrapCredentialCleanup {
    fn drop(&mut self) {
        if self.armed {
            let _ = clear_native_tokens(&self.home);
        }
    }
}

struct BootstrapNativeAuth(CodexAuth);

impl ExternalAuth for BootstrapNativeAuth {
    fn resolve(&self) -> ExternalAuthFuture<'_, CodexAuth> {
        Box::pin(async { Ok(self.0.clone()) })
    }

    fn refresh(&self, _context: ExternalAuthRefreshContext) -> ExternalAuthFuture<'_, CodexAuth> {
        // Never claim a stale snapshot was refreshed. The native credential
        // owner must obtain a fresh token before retrying failed bootstrap.
        Box::pin(async { Err(io::Error::other("native bootstrap credential refresh required")) })
    }
}

fn parse_native_auth(tokens: &ChatgptAuthRefreshTokens) -> Result<CodexAuth> {
    for (value, max) in [
        (tokens.access_token.as_str(), MAX_ACCESS_TOKEN_BYTES),
        (tokens.account_id.as_str(), MAX_ACCOUNT_ID_BYTES),
    ] {
        if value.is_empty()
            || value.len() > max
            || value.trim() != value
            || value.chars().any(char::is_control)
        {
            return Err(RuntimeConfigError::InvalidCredentials);
        }
    }
    if tokens.plan_type.as_deref().is_some_and(|plan| {
        plan.is_empty() || plan.len() > MAX_PLAN_BYTES || plan.chars().any(char::is_control)
    }) {
        return Err(RuntimeConfigError::InvalidCredentials);
    }
    CodexAuth::from_external_chatgpt_tokens(
        &tokens.access_token,
        &tokens.account_id,
        tokens.plan_type.as_deref(),
    )
    .map_err(|_| RuntimeConfigError::InvalidCredentials)
}

fn validate_auth_policy(config: &AuthConfig, account_id: &str) -> Result<()> {
    config.validate().map_err(|_| RuntimeConfigError::AuthPolicy)?;
    if !config.is_login_method_allowed(ForcedLoginMethod::Chatgpt)
        || config
            .effective_chatgpt_workspaces()
            .is_some_and(|ids| !ids.iter().any(|id| id == account_id))
    {
        return Err(RuntimeConfigError::AuthPolicy);
    }
    Ok(())
}

fn normalized_absolute(path: &Path) -> bool {
    path.is_absolute()
        && path != Path::new("/")
        && path.components().all(|part| matches!(part, Component::RootDir | Component::Normal(_)))
        && path.to_str().is_some_and(|text| {
            !text.chars().any(char::is_control)
                && !text.contains("//")
                && !text.contains("/./")
                && !text.ends_with("/.")
                && !text.ends_with('/')
        })
}

fn validate_paths(home: &Path, cwd: &Path) -> Result<()> {
    if !normalized_absolute(home)
        || !normalized_absolute(cwd)
        || home.starts_with(cwd)
        || cwd.starts_with(home)
    {
        return Err(RuntimeConfigError::InvalidPaths);
    }
    let metadata = std::fs::symlink_metadata(home).map_err(|_| RuntimeConfigError::InvalidPaths)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(RuntimeConfigError::InvalidPaths);
    }
    // Do not create/change roots, chmod a caller directory, or touch auth files.
    // Parent-chain ownership and mount separation belong to ProviderScopeFactory.
    Ok(())
}

fn validate_overrides(overrides: &[(String, TomlValue)]) -> Result<()> {
    if overrides.is_empty() || overrides.len() > 512 {
        return Err(RuntimeConfigError::InvalidOverrides);
    }
    let mut keys = HashSet::new();
    for (key, _) in overrides {
        if key.is_empty() || key.len() > 1024 || !keys.insert(key) || key.chars().any(char::is_control) {
            return Err(RuntimeConfigError::InvalidOverrides);
        }
    }
    Ok(())
}

fn validate_resolved_paths(config: &Config, home: &Path, cwd: &Path) -> Result<()> {
    if config.codex_home.as_path() != home || config.cwd.as_path() != cwd {
        return Err(RuntimeConfigError::ExecutionMismatch);
    }
    Ok(())
}

fn validate_login_receipt(receipt: serde_json::Value) -> Result<()> {
    match serde_json::from_value::<LoginAccountResponse>(receipt) {
        Ok(LoginAccountResponse::ChatgptAuthTokens {}) => Ok(()),
        _ => Err(RuntimeConfigError::LoginReceipt),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_external_chatgpt_receipt_is_accepted() {
        assert_eq!(
            validate_login_receipt(serde_json::json!({"type":"chatgptAuthTokens"})),
            Ok(()),
        );
        for value in [
            serde_json::json!({"type":"apiKey"}),
            serde_json::json!({}),
            serde_json::Value::Null,
        ] {
            assert_eq!(
                validate_login_receipt(value),
                Err(RuntimeConfigError::LoginReceipt),
            );
        }
    }

    #[test]
    fn paths_cannot_select_ambient_or_ambiguous_working_directory() {
        for path in [
            "", ".", "/", "workspace/a", "/workspace/../home",
            "/workspace//a", "/workspace/./a", "/workspace/a/", "/workspace/a\n",
        ] {
            assert!(!normalized_absolute(Path::new(path)));
        }
        assert!(normalized_absolute(Path::new("/workspace/attempts/owned/view")));
    }

    #[test]
    fn duplicate_overrides_cannot_silently_replace_an_earlier_value() {
        assert_eq!(
            validate_overrides(&[
                ("model".into(), "one".into()),
                ("model".into(), "two".into()),
            ]),
            Err(RuntimeConfigError::InvalidOverrides),
        );
        assert_eq!(
            validate_overrides(&[("features.code_mode".into(), false.into())]),
            Ok(()),
        );
    }

    #[test]
    fn malformed_native_auth_produces_only_constant_errors() {
        let tokens = ChatgptAuthRefreshTokens {
            access_token: "not-a-token".into(),
            account_id: "private-account".into(),
            plan_type: None,
        };
        assert_eq!(
            parse_native_auth(&tokens).err(),
            Some(RuntimeConfigError::InvalidCredentials),
        );
        let message = RuntimeConfigError::InvalidCredentials.to_string();
        assert!(!message.contains(&tokens.access_token));
        assert!(!message.contains(&tokens.account_id));
    }
}
