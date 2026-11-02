//! Trusted host scope factory. No TAH manifest, role, prompt, or outcome parser.
//! One factory owns one already-sealed iSH mount and serializes prepare through
//! explicit disposal. The host must supply the exact backing root used at boot.

use crate::embedded_runtime::EmbeddedRuntime;
use crate::execution_fence::{ExecutionFence, ExecutionPermit};
use crate::ish_exec_backend::{
    ExecutionLease, ExecutionPolicy, IshExecBackend, PolicyError, PreparedExecution,
};
use crate::provider_backend::ProviderExecutionScope;
use crate::scoped_executor_fs::ScopedExecutorFileSystem;
use crate::scoped_files::{Access, ScopedFiles};
use codex_config::TomlValue;
use codex_core::config::Config;
use codex_exec_server::{
    EnvironmentCapabilities, EnvironmentInfo, ExecParams, FileSystemSandboxContext, ShellInfo,
};
use codex_protocol::config_types::{
    ShellEnvironmentPolicyInherit, WebSearchMode, WindowsSandboxProxySettingsMode,
};
use codex_protocol::permissions::{
    FileSystemAccessMode, FileSystemPath, FileSystemSpecialPath, NetworkSandboxPolicy,
};
use codex_utils_path_uri::PathUri;
use ish_embed_host::{IshInstance, SpawnOpts, WorkspaceGrant, WorkspaceNetworkPolicy};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::io::{self, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const RUNTIME_READS: &[&str] = &["/bin", "/sbin", "/usr", "/lib", "/etc"];
const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 768;
const MAX_CAPTURE_ENTRIES: usize = 512;
const MAX_CAPTURE_FILES: usize = 256;
const DRAIN_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) struct ScopeFile {
    pub relative_path: String,
    pub bytes: Vec<u8>,
    pub sha256: [u8; 32],
}

pub(crate) struct ScopeSpec {
    pub scope_id: uuid::Uuid,
    pub read_only_files: Vec<ScopeFile>,
    pub writable_files: Vec<ScopeFile>,
    pub writable_directories: Vec<String>,
    pub writable_roots: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopeLayout {
    pub scope_id: String,
    #[serde(rename = "permissionProfileID")]
    pub permission_profile_id: String,
    pub workspace_root: String,
    pub controller_home: String,
    pub scratch_root: String,
    pub filesystem: BTreeMap<String, String>,
    pub shell_environment: HashMap<String, String>,
}

struct FactoryState {
    instance: Arc<IshInstance>,
    workspace: PathBuf,
    controllers: PathBuf,
    gate: Arc<Semaphore>,
    quarantined: Arc<AtomicBool>,
    used: Mutex<BTreeSet<uuid::Uuid>>,
}

pub(crate) struct ProviderScopeFactory {
    state: Arc<FactoryState>,
}

struct Resources {
    state: Arc<FactoryState>,
    root: PathBuf,
    controller: PathBuf,
    controller_created: bool,
    _lease: OwnedSemaphorePermit,
}

pub(crate) struct PreparedScope {
    layout: ScopeLayout,
    resources: Option<Resources>,
    writable_roots: Vec<String>,
    immutable: BTreeMap<String, [u8; 32]>,
}

impl ProviderScopeFactory {
    /// Both roots are host-owned, ordinary directories. Controller/auth storage
    /// must be outside the immutable native mount, and no factory may compete for
    /// this same instance. This constructor never boots/remounts the kernel.
    pub(crate) fn new(
        instance: Arc<IshInstance>,
        workspace: PathBuf,
        controllers: PathBuf,
    ) -> io::Result<Self> {
        if !instance.workspace_policy_enabled() || !instance.owned_jobs_enabled() {
            return Err(invalid("sealed owned iSH instance required"));
        }
        let workspace = workspace.canonicalize()?;
        let controllers = controllers.canonicalize()?;
        if workspace.starts_with(&controllers) || controllers.starts_with(&workspace) {
            return Err(invalid("controller and guest roots must be disjoint"));
        }
        ScopedFiles::open(&workspace, Access::ReadOnly)?;
        ScopedFiles::open(&controllers, Access::ReadOnly)?;
        std::fs::create_dir_all(workspace.join("attempts"))?;
        if !std::fs::symlink_metadata(workspace.join("attempts"))?.is_dir() {
            return Err(invalid("ordinary attempts directory required"));
        }
        Ok(Self {
            state: Arc::new(FactoryState {
                instance,
                workspace,
                controllers,
                gate: Arc::new(Semaphore::new(1)),
                quarantined: Arc::new(AtomicBool::new(false)),
                used: Mutex::new(BTreeSet::new()),
            }),
        })
    }

    pub(crate) async fn prepare(&self, spec: ScopeSpec) -> io::Result<PreparedScope> {
        validate_spec(&spec)?;
        if self.state.quarantined.load(Ordering::Acquire) {
            return Err(invalid("instance quarantined"));
        }
        let lease = self
            .state
            .gate
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| invalid("factory closed"))?;
        if self.state.quarantined.load(Ordering::Acquire) {
            return Err(invalid("instance quarantined"));
        }
        if !self
            .state
            .used
            .lock()
            .map_err(|_| invalid("factory poisoned"))?
            .insert(spec.scope_id)
        {
            return Err(invalid("scope identity already used"));
        }
        let id = spec.scope_id.to_string();
        let root = self.state.workspace.join("attempts").join(&id);
        let controller = self.state.controllers.join(&id);
        let scope_layout = layout(&id, "", &spec.writable_roots, &controller)?;
        std::fs::create_dir(&root)?;
        // Own cleanup as soon as the first private root exists.
        let mut prepared = PreparedScope {
            layout: scope_layout,
            resources: Some(Resources {
                state: self.state.clone(),
                root,
                controller,
                controller_created: false,
                _lease: lease,
            }),
            writable_roots: spec.writable_roots.clone(),
            immutable: BTreeMap::new(),
        };
        let resources = prepared.resources.as_mut().unwrap();
        std::fs::create_dir(&resources.controller)?;
        resources.controller_created = true;
        for child in ["view", "scratch", "scratch/home"] {
            std::fs::create_dir(resources.root.join(child))?;
        }
        let view = resources.root.join("view");
        for dir in spec.writable_roots.iter().chain(&spec.writable_directories) {
            std::fs::create_dir_all(view.join(dir))?;
        }
        for file in &spec.read_only_files {
            prepared
                .immutable
                .insert(file.relative_path.clone(), file.sha256);
        }
        for file in spec.read_only_files.into_iter().chain(spec.writable_files) {
            let destination = view.join(&file.relative_path);
            std::fs::create_dir_all(
                destination
                    .parent()
                    .ok_or_else(|| invalid("missing parent"))?,
            )?;
            let mut out = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)?;
            out.write_all(&file.bytes)?;
            out.sync_all()?;
        }
        Ok(prepared)
    }
}

impl PreparedScope {
    pub(crate) fn layout(&self) -> &ScopeLayout {
        &self.layout
    }
    /// One-shot binding after the Adapter has projected the mobile native profile
    /// using this layout. Neither model/effort nor Code Mode is changed here.
    pub(crate) fn bind(
        mut self,
        permission_profile_id: String,
        config: Arc<Config>,
        native_overrides: Vec<(String, TomlValue)>,
    ) -> io::Result<Arc<BoundScope>> {
        if permission_profile_id.is_empty()
            || permission_profile_id.len() > 128
            || !permission_profile_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(invalid("invalid native profile name"));
        }
        self.layout.permission_profile_id = permission_profile_id;
        validate_config(&config, &self.layout)?;
        let selected = native_overrides
            .iter()
            .filter(|(key, _)| key == "default_permissions")
            .collect::<Vec<_>>();
        if selected.len() != 1
            || selected[0].1.as_str() != Some(self.layout.permission_profile_id.as_str())
        {
            return Err(invalid("native override profile name mismatch"));
        }
        let resources = self
            .resources
            .as_ref()
            .ok_or_else(|| invalid("scope already bound"))?;
        let view = resources.root.join("view");
        let fence = Arc::new(ExecutionFence::default());
        let mut roots = vec![
            (
                uri(&self.layout.workspace_root)?,
                ScopedFiles::open(&view, Access::ReadOnly)?,
            ),
            (
                uri(&self.layout.scratch_root)?,
                ScopedFiles::open(&resources.root.join("scratch"), Access::ReadWrite)?,
            ),
        ];
        for root in &self.writable_roots {
            roots.push((
                uri(&format!("{}/{root}", self.layout.workspace_root))?,
                ScopedFiles::open(&view.join(root), Access::ReadWrite)?,
            ));
        }
        let files = Arc::new(
            ScopedExecutorFileSystem::with_readonly_ancestors(roots, 16 * 1024 * 1024)?
                .with_fence(fence.clone()),
        );
        let policy = Arc::new(ScopePolicy {
            instance: resources.state.instance.clone(),
            layout: self.layout.clone(),
            fence: fence.clone(),
            gate: Arc::new(Semaphore::new(1)),
            quarantined: resources.state.quarantined.clone(),
        });
        // Test actual grant construction before starting any native runtime.
        drop(
            policy
                .grant()
                .map_err(|_| invalid("scoped grant unavailable"))?,
        );
        let backend = Arc::new(
            IshExecBackend::new(resources.state.instance.clone(), policy, DRAIN_TIMEOUT)
                .map_err(|_| invalid("owned executor unavailable"))?,
        );
        let info = EnvironmentInfo {
            shell: ShellInfo {
                name: "bash".into(),
                path: "/bin/bash".into(),
            },
            executor_version: "0.166.0".into(),
            provider_id: None,
            cwd: Some(uri(&self.layout.workspace_root)?),
            user_home_dir: Some(uri(&format!("{}/home", self.layout.scratch_root))?),
            // This is executor metadata for the Linux guest, not the native App
            // Server initialize.platformOs receipt (which must remain genuine).
            platform_os: Some("linux".into()),
            prepend_path_dirs: vec![],
            temporary_directories: Some(vec![uri(&self.layout.scratch_root)?]),
            temp_dir: Some(uri(&self.layout.scratch_root)?),
            capabilities: EnvironmentCapabilities::default(),
        };
        let layout = self.layout.clone();
        let pinned_config = config.clone();
        let execution = EmbeddedRuntime::new(
            backend.clone(),
            files,
            info,
            config.web_search_mode.value() == WebSearchMode::Live,
            native_overrides,
            Arc::new(move |actual| {
                if actual != pinned_config.as_ref() {
                    return Err(invalid("resolved native profile changed"));
                }
                validate_config(actual, &layout)
            }),
        )?;
        Ok(Arc::new(BoundScope {
            layout: self.layout.clone(),
            writable_roots: self.writable_roots.clone(),
            immutable: self.immutable.clone(),
            execution,
            backend,
            fence,
            state: Mutex::new(BoundState {
                resources: self.resources.take(),
                runtime_claimed: false,
                runtime_complete: false,
                quiescent: false,
            }),
        }))
    }
}

impl Drop for PreparedScope {
    fn drop(&mut self) {
        if let Some(resources) = self.resources.take() {
            resources.remove_before_start();
        }
    }
}

impl Resources {
    fn remove_before_start(self) {
        for path in
            std::iter::once(&self.root).chain(self.controller_created.then_some(&self.controller))
        {
            if let Err(error) = std::fs::remove_dir_all(path) {
                if error.kind() != io::ErrorKind::NotFound {
                    self.state.quarantined.store(true, Ordering::Release);
                }
            }
        }
    }
}

struct BoundState {
    resources: Option<Resources>,
    runtime_claimed: bool,
    runtime_complete: bool,
    quiescent: bool,
}
pub(crate) struct BoundScope {
    layout: ScopeLayout,
    writable_roots: Vec<String>,
    immutable: BTreeMap<String, [u8; 32]>,
    execution: Arc<EmbeddedRuntime>,
    backend: Arc<IshExecBackend>,
    fence: Arc<ExecutionFence>,
    state: Mutex<BoundState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapturedFile {
    pub relative_path: String,
    pub bytes: Vec<u8>,
    pub sha256: [u8; 32],
}
#[derive(Serialize)]
pub(crate) struct ScopeSnapshot {
    pub files: Vec<CapturedFile>,
    pub directories: Vec<String>,
}

impl BoundScope {
    pub(crate) fn execution(&self) -> Arc<EmbeddedRuntime> {
        self.execution.clone()
    }
    pub(crate) fn layout(&self) -> &ScopeLayout {
        &self.layout
    }
    pub(crate) fn capture(&self) -> io::Result<ScopeSnapshot> {
        let state = self.state.lock().map_err(|_| invalid("scope poisoned"))?;
        if !state.quiescent {
            return Err(invalid("scope is not quiescent"));
        }
        let resources = state
            .resources
            .as_ref()
            .ok_or_else(|| invalid("scope disposed"))?;
        let view_path = resources.root.join("view");
        let view = ScopedFiles::open(&view_path, Access::ReadOnly)?;
        for (path, expected) in &self.immutable {
            let metadata = view.metadata(Path::new(path))?;
            if !metadata.is_file()
                || metadata.nlink() != 1
                || sha256(&view.read_file(Path::new(path), MAX_INPUT_BYTES)?) != *expected
            {
                return Err(invalid("immutable material changed"));
            }
        }
        let mut snapshot = ScopeSnapshot {
            files: vec![],
            directories: vec![],
        };
        let mut bytes = 0;
        for root in &self.writable_roots {
            capture_tree(&view_path, &view, root, 0, false, &mut bytes, &mut snapshot)?;
        }
        Ok(snapshot)
    }

    /// Release the instance lease only after genuine runtime+scope drain and
    /// caller-owned snapshot handoff. Shared authentication is never deleted.
    pub(crate) fn dispose(&self) -> io::Result<()> {
        let mut state = self.state.lock().map_err(|_| invalid("scope poisoned"))?;
        if state.resources.is_none() {
            return Ok(());
        }
        if !state.quiescent {
            return Err(invalid("scope is not quiescent"));
        }
        let resources = state.resources.as_ref().unwrap();
        for path in [&resources.root, &resources.controller] {
            if let Err(error) = std::fs::remove_dir_all(path) {
                if error.kind() != io::ErrorKind::NotFound {
                    resources.state.quarantined.store(true, Ordering::Release);
                    return Err(invalid("scope disposal incomplete"));
                }
            }
        }
        state.resources.take();
        Ok(())
    }
}

impl ProviderExecutionScope for BoundScope {
    fn claim_runtime(&self) -> io::Result<()> {
        let mut state = self.state.lock().map_err(|_| invalid("scope poisoned"))?;
        if state.runtime_claimed || state.resources.is_none() {
            return Err(invalid("scope runtime already claimed"));
        }
        state.runtime_claimed = true;
        Ok(())
    }
    fn execution(&self) -> Arc<EmbeddedRuntime> {
        self.execution.clone()
    }
    fn close_admission(&self) {
        self.fence.close();
    }
    fn runtime_closed(&self, complete: bool) {
        if let Ok(mut state) = self.state.lock() {
            state.runtime_complete = complete;
            if !complete {
                if let Some(resources) = &state.resources {
                    resources.state.quarantined.store(true, Ordering::Release);
                }
            }
        }
    }
    fn drain(&self) -> Pin<Box<dyn Future<Output = io::Result<String>> + Send + '_>> {
        Box::pin(async move {
            self.fence.close();
            let deadline = tokio::time::Instant::now() + DRAIN_TIMEOUT;
            loop {
                {
                    let mut state = self.state.lock().map_err(|_| invalid("scope poisoned"))?;
                    let resources = state
                        .resources
                        .as_ref()
                        .ok_or_else(|| invalid("scope disposed"))?;
                    if !state.runtime_complete
                        || resources.state.quarantined.load(Ordering::Acquire)
                    {
                        return Err(invalid("runtime or owned cleanup incomplete"));
                    }
                    if self.fence.drained() && self.backend.active_process_count() == 0 {
                        state.quiescent = true;
                        return Ok(self.layout.scope_id.clone());
                    }
                    if tokio::time::Instant::now() >= deadline {
                        resources.state.quarantined.store(true, Ordering::Release);
                        return Err(invalid("scope drain deadline exceeded"));
                    }
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
    }
}

impl Drop for BoundScope {
    fn drop(&mut self) {
        self.fence.close();
        let state = self
            .state
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(resources) = &state.resources {
            // Dropping a handle is never disposal or evidence authorizing reuse.
            resources.state.quarantined.store(true, Ordering::Release);
        }
    }
}

struct ScopePolicy {
    instance: Arc<IshInstance>,
    layout: ScopeLayout,
    fence: Arc<ExecutionFence>,
    gate: Arc<Semaphore>,
    quarantined: Arc<AtomicBool>,
}
impl ScopePolicy {
    fn grant(&self) -> std::result::Result<Arc<WorkspaceGrant>, PolicyError> {
        let read = self
            .layout
            .filesystem
            .iter()
            .filter(|(p, a)| a.as_str() == "read" && p.as_str() != "/proc")
            .map(|(path, _)| PathBuf::from(path))
            .collect::<Vec<_>>();
        let write = self
            .layout
            .filesystem
            .iter()
            .filter(|(p, a)| a.as_str() == "write" && p.as_str() != "/dev")
            .map(|(path, _)| PathBuf::from(path))
            .collect::<Vec<_>>();
        self.instance
            .prepare_workspace_grant(&read, &write, WorkspaceNetworkPolicy::DenyDirect)
            .map(Arc::new)
            .map_err(|_| PolicyError::Denied)
    }
}
struct Lease {
    grant: Option<Arc<WorkspaceGrant>>,
    _serial: OwnedSemaphorePermit,
    _execution: ExecutionPermit,
    quarantine: Arc<AtomicBool>,
    finished: bool,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if !self.finished {
            self.quarantine.store(true, Ordering::Release);
        }
    }
}
impl ExecutionLease for Lease {
    fn not_started(mut self: Box<Self>) {
        self.finished = true;
        self.grant.take();
    }
    fn complete(&mut self) -> std::result::Result<(), PolicyError> {
        self.finished = true;
        self.grant.take();
        Ok(())
    }
    fn quarantine(self: Box<Self>) {
        self.quarantine.store(true, Ordering::Release);
    }
}
impl ExecutionPolicy for ScopePolicy {
    fn prepare<'a>(
        &'a self,
        request: &'a ExecParams,
    ) -> Pin<
        Box<dyn Future<Output = std::result::Result<PreparedExecution, PolicyError>> + Send + 'a>,
    > {
        Box::pin(async move {
            let serial = self
                .gate
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| PolicyError::NotReady)?;
            let permit = self.fence.acquire().map_err(|_| PolicyError::NotReady)?;
            if self.quarantined.load(Ordering::Acquire) {
                return Err(PolicyError::NotReady);
            }
            let cwd = request.cwd.to_abs_path().map_err(|_| PolicyError::Denied)?;
            if ![&self.layout.workspace_root, &self.layout.scratch_root]
                .iter()
                .any(|root| cwd.starts_with(Path::new(root)))
            {
                return Err(PolicyError::Denied);
            }
            if let Some(context) = &request.sandbox {
                validate_permissions(context, &self.layout).map_err(|_| PolicyError::Denied)?;
            }
            let mut env = self.layout.shell_environment.clone();
            if let Some(policy) = &request.env_policy {
                let exclusions = [
                    "CODEX_PERMISSION_PROFILE",
                    "CODEX_VERSION",
                    codex_apply_patch::CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS_ENV_VAR,
                    "CODEX_PLUGIN_METRICS_OUTPUT",
                ];
                if policy.inherit != ShellEnvironmentPolicyInherit::None
                    || policy.ignore_default_excludes
                    || !policy.include_only.is_empty()
                    || policy
                        .exclude
                        .iter()
                        .any(|key| !exclusions.contains(&key.as_str()))
                {
                    return Err(PolicyError::UnsupportedContext("shell-environment-policy"));
                }
                for key in &policy.exclude {
                    env.remove(key);
                }
                env.extend(policy.r#set.clone());
            }
            env.extend(request.env.clone());
            let grant = self.grant()?;
            Ok(PreparedExecution {
                options: SpawnOpts {
                    argv: request.argv.clone(),
                    envp: Some(env.into_iter().collect()),
                    cwd: Some(cwd.to_path_buf()),
                    tty: false,
                    size: None,
                    pipe_stdin: request.pipe_stdin,
                    arg0: None,
                },
                grant: Some(grant.clone()),
                lease: Box::new(Lease {
                    grant: Some(grant),
                    _serial: serial,
                    _execution: permit,
                    quarantine: self.quarantined.clone(),
                    finished: false,
                }),
            })
        })
    }
}

fn validate_config(config: &Config, layout: &ScopeLayout) -> io::Result<()> {
    if config.cwd.as_path() != Path::new(&layout.workspace_root)
        || config.codex_home.as_path() != Path::new(&layout.controller_home)
        || config
            .permissions
            .active_permission_profile()
            .as_ref()
            .map(|p| p.id.as_str())
            != Some(layout.permission_profile_id.as_str())
    {
        return Err(invalid("resolved native scope identity mismatch"));
    }
    let env = &config.permissions.shell_environment_policy;
    if env.inherit != ShellEnvironmentPolicyInherit::None
        || env.ignore_default_excludes
        || !env.exclude.is_empty()
        || !env.include_only.is_empty()
        || env.r#set != layout.shell_environment
    {
        return Err(invalid("resolved shell environment differs from scope"));
    }
    let context = FileSystemSandboxContext::from_permission_profile(
        config.permissions.effective_permission_profile(),
        uri(&layout.workspace_root)?,
    );
    validate_permissions(&context, layout)
}

fn validate_permissions(
    context: &FileSystemSandboxContext,
    layout: &ScopeLayout,
) -> io::Result<()> {
    if !context.sandbox_override.is_no_override()
        || context.windows_sandbox_is_requested()
        || context.use_legacy_landlock
        || context
            .windows_sandbox_proxy_settings_mode
            .is_some_and(|mode| mode != WindowsSandboxProxySettingsMode::Reconcile)
        || context.permissions.network_sandbox_policy() != NetworkSandboxPolicy::Restricted
    {
        return Err(invalid("unsupported execution policy"));
    }
    let policy = context.permissions.file_system_sandbox_policy();
    if policy.glob_scan_max_depth.is_some() {
        return Err(invalid("unsupported glob policy"));
    }
    let mut actual = BTreeMap::new();
    for entry in &policy.entries {
        if entry.missing_path_behavior.is_some() {
            return Err(invalid("unsupported path policy"));
        }
        let path = match &entry.path {
            FileSystemPath::Path { path } => path
                .to_abs_path()
                .map_err(io::Error::other)?
                .to_string_lossy()
                .into_owned(),
            FileSystemPath::Special {
                value: FileSystemSpecialPath::Root,
            } => "/".into(),
            _ => return Err(invalid("unsupported special path")),
        };
        let access = match entry.access {
            FileSystemAccessMode::Deny => "deny",
            FileSystemAccessMode::Read => "read",
            FileSystemAccessMode::Write => "write",
        };
        if actual.insert(path, access.to_string()).is_some() {
            return Err(invalid("duplicate native root"));
        }
    }
    if actual != layout.filesystem {
        return Err(invalid("native grants differ from exact scope"));
    }
    Ok(())
}

fn layout(
    id: &str,
    profile: &str,
    writes: &[String],
    controller: &Path,
) -> io::Result<ScopeLayout> {
    let workspace_root = format!("/workspace/attempts/{id}/view");
    let scratch_root = format!("/workspace/attempts/{id}/scratch");
    let mut filesystem = BTreeMap::from([
        ("/".into(), "deny".into()),
        ("/dev".into(), "write".into()),
        ("/proc".into(), "read".into()),
    ]);
    for root in RUNTIME_READS {
        filesystem.insert((*root).into(), "read".into());
    }
    filesystem.insert(workspace_root.clone(), "read".into());
    filesystem.insert(scratch_root.clone(), "write".into());
    for root in writes {
        filesystem.insert(format!("{workspace_root}/{root}"), "write".into());
    }
    let shell_environment = [
        (
            "PATH",
            "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into(),
        ),
        ("HOME", format!("{scratch_root}/home")),
        ("TMPDIR", scratch_root.clone()),
        ("LANG", "C.UTF-8".into()),
        ("LC_ALL", "C.UTF-8".into()),
        ("SHELL", "/bin/bash".into()),
        ("BASH_ENV", "/dev/null".into()),
        ("ENV", "/dev/null".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    Ok(ScopeLayout {
        scope_id: id.into(),
        permission_profile_id: profile.into(),
        workspace_root,
        scratch_root,
        controller_home: controller
            .to_str()
            .ok_or_else(|| invalid("non-UTF8 controller root"))?
            .into(),
        filesystem,
        shell_environment,
    })
}

fn validate_spec(spec: &ScopeSpec) -> io::Result<()> {
    if spec.read_only_files.len()
        + spec.writable_files.len()
        + spec.writable_directories.len()
        + spec.writable_roots.len()
        > MAX_ENTRIES
    {
        return Err(invalid("scope entry budget exceeded"));
    }
    for (index, root) in spec.writable_roots.iter().enumerate() {
        relative(root)?;
        if spec.writable_roots[..index]
            .iter()
            .any(|other| within(root, other) || within(other, root))
        {
            return Err(invalid("overlapping write roots"));
        }
    }
    let mut files = BTreeSet::new();
    let mut bytes = 0usize;
    for (file, writable) in spec
        .read_only_files
        .iter()
        .map(|f| (f, false))
        .chain(spec.writable_files.iter().map(|f| (f, true)))
    {
        relative(&file.relative_path)?;
        let under_write = spec
            .writable_roots
            .iter()
            .any(|root| file.relative_path.starts_with(&format!("{root}/")));
        if writable != under_write
            || spec.writable_roots.contains(&file.relative_path)
            || !files.insert(file.relative_path.clone())
            || sha256(&file.bytes) != file.sha256
        {
            return Err(invalid("invalid scoped file"));
        }
        bytes = bytes
            .checked_add(file.bytes.len())
            .filter(|n| *n <= MAX_INPUT_BYTES)
            .ok_or_else(|| invalid("scope byte budget exceeded"))?;
    }
    for path in &files {
        if files
            .iter()
            .any(|other| other != path && other.starts_with(&format!("{path}/")))
            || spec
                .writable_directories
                .iter()
                .chain(&spec.writable_roots)
                .any(|dir| within(dir, path))
        {
            return Err(invalid("file/directory alias"));
        }
    }
    for path in &spec.writable_directories {
        relative(path)?;
        if !spec.writable_roots.iter().any(|root| within(path, root)) {
            return Err(invalid("directory outside write roots"));
        }
    }
    Ok(())
}

fn capture_tree(
    root: &Path,
    view: &ScopedFiles,
    path: &str,
    depth: usize,
    include_entry: bool,
    bytes: &mut usize,
    snapshot: &mut ScopeSnapshot,
) -> io::Result<()> {
    relative(path)?;
    if depth > 32 || (include_entry && snapshot.files.len() + snapshot.directories.len() >= MAX_CAPTURE_ENTRIES) {
        return Err(invalid("snapshot entry budget exceeded"));
    }
    let metadata = view.metadata(Path::new(path))?;
    if metadata.is_dir() {
        // The writable root is a capability anchor, never a candidate entry.
        if include_entry { snapshot.directories.push(path.into()); }
        let remaining =
            MAX_CAPTURE_ENTRIES.saturating_sub(snapshot.files.len() + snapshot.directories.len());
        let mut names = std::fs::read_dir(root.join(path))?
            .take(remaining + 1)
            .map(|e| e.map(|e| e.file_name()))
            .collect::<io::Result<Vec<_>>>()?;
        if names.len() > remaining {
            return Err(invalid("snapshot entry budget exceeded"));
        }
        names.sort();
        for name in names {
            capture_tree(
                root,
                view,
                &format!(
                    "{path}/{}",
                    name.to_str().ok_or_else(|| invalid("non-UTF8 name"))?
                ),
                depth + 1,
                true,
                bytes,
                snapshot,
            )?;
        }
    } else if metadata.is_file() && metadata.nlink() == 1 {
        if !include_entry || snapshot.files.len() >= MAX_CAPTURE_FILES { return Err(invalid("snapshot file budget exceeded")); }
        let data = view.read_file(Path::new(path), MAX_CAPTURE_BYTES)?;
        *bytes = bytes
            .checked_add(data.len())
            .filter(|n| *n <= MAX_CAPTURE_BYTES)
            .ok_or_else(|| invalid("snapshot byte budget exceeded"))?;
        snapshot.files.push(CapturedFile {
            relative_path: path.into(),
            sha256: sha256(&data),
            bytes: data,
        });
    } else {
        return Err(invalid("unsupported snapshot entry"));
    }
    Ok(())
}
fn within(path: &str, root: &str) -> bool {
    path == root || path.starts_with(&format!("{root}/"))
}
fn relative(path: &str) -> io::Result<()> {
    if path.is_empty()
        || path.len() > 1024
        || path.contains('\\')
        || path.bytes().any(|b| b < 32 || b == 127)
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid("invalid relative path"));
    }
    Ok(())
}
fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
fn uri(path: &str) -> io::Result<PathUri> {
    PathUri::parse(&format!("file://{path}")).map_err(io::Error::other)
}
fn invalid(message: &'static str) -> io::Error {
    io::Error::other(message)
}
