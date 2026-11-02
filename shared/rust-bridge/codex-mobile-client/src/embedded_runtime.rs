//! Immutable, explicitly injected execution context for one embedded runtime.
//! The factory caller supplies enforcing execution and matching native file views.
//! The OnceLock registry is retained only for the legacy qualification path.

use codex_config::TomlValue;
use codex_core::config::Config;
use codex_exec_server::{EnvironmentInfo, EnvironmentManager, ExecBackend, ExecutorFileSystem};
use std::io;
use std::sync::{Arc, OnceLock};

pub(crate) struct EmbeddedRuntime {
    backend: Arc<dyn ExecBackend>,
    filesystem: Arc<dyn ExecutorFileSystem>,
    info: EnvironmentInfo,
    pub provider_web: bool,
    config_overrides: Vec<(String, TomlValue)>,
    validate_config: Arc<dyn Fn(&Config) -> io::Result<()> + Send + Sync>,
}

static RUNTIME: OnceLock<Arc<EmbeddedRuntime>> = OnceLock::new();

pub(crate) fn register(
    backend: Arc<dyn ExecBackend>,
    filesystem: Arc<dyn ExecutorFileSystem>,
    info: EnvironmentInfo,
    provider_web: bool,
    config_overrides: Vec<(String, TomlValue)>,
    validate_config: Arc<dyn Fn(&Config) -> io::Result<()> + Send + Sync>,
) -> io::Result<()> {
    RUNTIME
        .set(EmbeddedRuntime::new(
            backend,
            filesystem,
            info,
            provider_web,
            config_overrides,
            validate_config,
        )?)
        .map_err(|_| io::Error::other("embedded runtime is already registered"))
}

pub(crate) fn installed() -> io::Result<Arc<EmbeddedRuntime>> {
    RUNTIME.get().cloned().ok_or_else(|| {
        io::Error::other(
            "ALMA local workspace has not been prepared; native execution fallback is disabled",
        )
    })
}

impl EmbeddedRuntime {
    /// Build a fresh context without publishing it or selecting process state.
    /// The caller owns scope admission/drain and may share one sealed iSH instance
    /// beneath distinct backend/file-view objects. Never retarget a live context.
    pub(crate) fn new(
        backend: Arc<dyn ExecBackend>,
        filesystem: Arc<dyn ExecutorFileSystem>,
        info: EnvironmentInfo,
        provider_web: bool,
        config_overrides: Vec<(String, TomlValue)>,
        validate_config: Arc<dyn Fn(&Config) -> io::Result<()> + Send + Sync>,
    ) -> io::Result<Arc<Self>> {
        if filesystem.mutation_preflight().is_none() {
            return Err(io::Error::other(
                "embedded native filesystem lacks batch authorization",
            ));
        }
        Ok(Arc::new(Self {
            backend,
            filesystem,
            info,
            provider_web,
            config_overrides,
            validate_config,
        }))
    }

    pub fn config_overrides(&self) -> Vec<(String, TomlValue)> {
        self.config_overrides.clone()
    }
    pub fn guest_cwd(&self) -> io::Result<std::path::PathBuf> {
        self.info
            .cwd
            .as_ref()
            .ok_or_else(|| io::Error::other("embedded cwd missing"))?
            .to_abs_path()
            .map(|path| path.to_path_buf())
    }

    pub fn manager(&self, config: &Config) -> io::Result<Arc<EnvironmentManager>> {
        (self.validate_config)(config)?;
        EnvironmentManager::from_embedded(
            self.backend.clone(),
            self.filesystem.clone(),
            self.info.clone(),
            config.http_client_factory(),
        )
        .map(Arc::new)
        .map_err(io::Error::other)
    }
}
