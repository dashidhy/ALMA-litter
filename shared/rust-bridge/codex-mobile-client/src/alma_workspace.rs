//! Initial fixed qualification workspace. Host-created inputs and candidate
//! outputs are separate. This is not the TAH revision publisher/scheduler.
use crate::ish_exec_backend::{ExecutionLease, ExecutionPolicy, PolicyError, PreparedExecution};
use codex_config::TomlValue;
use codex_core::config::Config;
use codex_exec_server::{ExecParams, FileSystemSandboxContext};
use codex_protocol::config_types::{ShellEnvironmentPolicyInherit, WindowsSandboxProxySettingsMode};
use codex_protocol::permissions::{FileSystemAccessMode, FileSystemPath, FileSystemSpecialPath, NetworkSandboxPolicy};
use ish_embed_host::{IshInstance, SpawnOpts, WorkspaceGrant, WorkspaceNetworkPolicy};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
static ATTEMPT_EXECUTION: std::sync::OnceLock<(Arc<crate::ish_exec_backend::IshExecBackend>,Arc<WorkspacePolicy>)> = std::sync::OnceLock::new();

pub(crate) fn attempt_health() -> Option<(usize,bool)> {
    ATTEMPT_EXECUTION.get().map(|(backend,policy)|(
        backend.active_process_count()+usize::from(!policy.fence.drained()),policy.quarantined.load(Ordering::Acquire)))
}
pub(crate) fn close_attempt_admission() {if let Some((_,policy))=ATTEMPT_EXECUTION.get(){policy.fence.close();}}

pub const CWD: &str = "/workspace/output";
pub const INPUT: &str = "/workspace/input";
pub const SCRATCH: &str = "/workspace/tmp";
// The kernel separately exposes only safe device nodes and selected own-process
// proc metadata. Those reserved roots must not be submitted as directory grants.
const READ_ROOTS: &[&str] = &["/bin", "/sbin", "/usr", "/lib", "/etc", INPUT];
const WRITE_ROOTS: &[&str] = &[CWD, SCRATCH];

#[derive(Clone)]
pub(crate) struct WorkspaceScope {
    pub cwd: String,
    pub scratch: String,
    pub read: Vec<String>,
    pub write: Vec<String>,
    pub allowed_cwds: Vec<String>,
}
impl WorkspaceScope {
    fn legacy() -> Self {
        Self {cwd:CWD.into(),scratch:SCRATCH.into(),
            read:READ_ROOTS.iter().map(|p|(*p).into()).collect(),
            write:WRITE_ROOTS.iter().map(|p|(*p).into()).collect(),
            allowed_cwds:vec![INPUT.into(),CWD.into(),SCRATCH.into()]}
    }
    fn attempt(a: &crate::tah_attempt::PreparedAttempt) -> Self {
        let mut read:Vec<String>=["/bin","/sbin","/usr","/lib","/etc"].into_iter().map(str::to_owned).collect();
        read.push(a.info.guest_cwd.clone());
        let mut write:Vec<String>=a.writable_roots.iter().map(|p|format!("{}/{p}",a.info.guest_cwd)).collect();
        write.push(a.guest_scratch.clone());
        Self {cwd:a.info.guest_cwd.clone(),scratch:a.guest_scratch.clone(),read,write,
            allowed_cwds:vec![a.info.guest_cwd.clone(),a.guest_scratch.clone()]}
    }
    fn env(&self) -> HashMap<String,String> {
        let mut env=guest_env();env.insert("HOME".into(),format!("{}/home",self.scratch));
        env.insert("TMPDIR".into(),self.scratch.clone());env
    }
    fn access(&self) -> BTreeMap<String, FileSystemAccessMode> {
        std::iter::once(("/".into(),FileSystemAccessMode::Deny))
            .chain(self.read.iter().map(|p|(p.clone(),FileSystemAccessMode::Read)))
            .chain(self.write.iter().map(|p|(p.clone(),FileSystemAccessMode::Write)))
            .chain([("/dev".into(),FileSystemAccessMode::Write),("/proc".into(),FileSystemAccessMode::Read)]).collect()
    }
}

pub fn bootstrap(rootfs_data: &Path, application_support: &Path)
    -> Result<Arc<IshInstance>, crate::ish_types::IshBootstrapError> {
    use crate::ish_types::IshBootstrapError;
    use crate::scoped_files::{Access, ScopedFiles};
    use codex_exec_server::{EnvironmentInfo, EnvironmentCapabilities, ShellInfo};
    use codex_utils_path_uri::PathUri;
    use std::io::Write;
    let root=application_support.join("alma-local-workspace");
    for name in ["input","output","tmp/home"] { std::fs::create_dir_all(root.join(name))?; }
    // Only a disposable synthetic fixture is provisioned here. Real TAH inputs
    // and revision publication are handled by the future trusted task owner.
    match std::fs::OpenOptions::new().create_new(true).write(true).open(root.join("input/source.txt")) {
        Ok(mut file)=>file.write_all(b"ALMA synthetic execution fixture.\nThis file is read-only to the agent.\n")?,
        Err(error) if error.kind()==std::io::ErrorKind::AlreadyExists=>{},
        Err(error)=>return Err(error.into()),
    }
    let instance=Arc::new(IshInstance::boot_workspace_policy_with_workspace(rootfs_data,Some(Path::new(CWD)),&root)?);
    let policy=Arc::new(WorkspacePolicy::new(instance.clone()).map_err(|_|IshBootstrapError::Ish("workspace policy not ready".into()))?);
    let backend=Arc::new(crate::ish_exec_backend::IshExecBackend::new(instance.clone(),policy,std::time::Duration::from_secs(15))
        .map_err(|_|IshBootstrapError::Ish("workspace executor not ready".into()))?);
    let uri=|path:&str|PathUri::parse(&format!("file://{path}")).map_err(std::io::Error::other);
    let filesystem=Arc::new(crate::scoped_executor_fs::ScopedExecutorFileSystem::new(vec![
        (uri(INPUT)?,ScopedFiles::open(&root.join("input"),Access::ReadOnly).map_err(std::io::Error::other)?),
        (uri(CWD)?,ScopedFiles::open(&root.join("output"),Access::ReadWrite).map_err(std::io::Error::other)?),
        (uri(SCRATCH)?,ScopedFiles::open(&root.join("tmp"),Access::ReadWrite).map_err(std::io::Error::other)?),
    ],16*1024*1024)?);
    let info=EnvironmentInfo {
        shell:ShellInfo {name:"bash".into(),path:"/bin/bash".into()},
        executor_version:"0.167.0".into(),provider_id:None,cwd:Some(uri(CWD)?),
        user_home_dir:Some(uri("/workspace/tmp/home")?),platform_os:Some("linux".into()),
        prepend_path_dirs:vec![],temporary_directories:Some(vec![uri(SCRATCH)?]),temp_dir:Some(uri(SCRATCH)?),
        capabilities:EnvironmentCapabilities::default(),
    };
    // This qualification workload is explicitly authorized to exercise official
    // Codex Web. Guest sockets remain denied by the independent kernel grant.
    crate::embedded_runtime::register(backend,filesystem,info,true,config_overrides(),Arc::new(validate_config))?;
    Ok(instance)
}

pub fn guest_env() -> HashMap<String, String> {
    [
        ("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"),
        ("HOME", "/workspace/tmp/home"), ("TMPDIR", SCRATCH),
        ("LANG", "C.UTF-8"), ("LC_ALL", "C.UTF-8"),
        ("SHELL", "/bin/bash"), ("BASH_ENV", "/dev/null"), ("ENV", "/dev/null"),
    ].into_iter().map(|(k,v)| (k.into(),v.into())).collect()
}

/// One immutable role view for a disposable TAH qualification process. The
/// original Mac controller remains responsible for acceptance/publication.
pub(crate) fn bootstrap_attempt(rootfs_data: &Path, application_support: &Path, documents: &Path)
    -> Result<Arc<IshInstance>, crate::ish_types::IshBootstrapError> {
    use crate::ish_types::IshBootstrapError;
    use crate::scoped_files::{Access, ScopedFiles};
    use codex_exec_server::{EnvironmentInfo, EnvironmentCapabilities, ShellInfo};
    use codex_utils_path_uri::PathUri;
    let root=application_support.join("alma-local-workspace");
    let attempt=crate::tah_attempt::prepare(documents,&root)?;
    let scope=Arc::new(WorkspaceScope::attempt(&attempt));
    let uri=|path:&str|PathUri::parse(&format!("file://{path}")).map_err(std::io::Error::other);
    let mut roots=vec![
        (uri(&scope.cwd)?,ScopedFiles::open(&attempt.view,Access::ReadOnly)?),
        (uri(&scope.scratch)?,ScopedFiles::open(&attempt.scratch,Access::ReadWrite)?),
    ];
    for writable in &attempt.writable_roots {
        roots.push((uri(&format!("{}/{writable}",scope.cwd))?,
            ScopedFiles::open(&attempt.view.join(writable),Access::ReadWrite)?));
    }
    let fence=Arc::new(crate::execution_fence::ExecutionFence::default());
    let filesystem=Arc::new(crate::scoped_executor_fs::ScopedExecutorFileSystem::with_readonly_ancestors(roots,16*1024*1024)?.with_fence(fence.clone()));
    let instance=Arc::new(IshInstance::boot_workspace_policy_with_workspace(rootfs_data,Some(Path::new(&scope.cwd)),&root)?);
    // Qualify the actual linked kernel before any account/model task. A source
    // patch alone is not proof that the shipped kernel supports this topology.
    let preflight=instance.prepare_workspace_grant(
        &scope.read.iter().map(PathBuf::from).collect::<Vec<_>>(),
        &scope.write.iter().map(PathBuf::from).collect::<Vec<_>>(),WorkspaceNetworkPolicy::DenyDirect)?;
    drop(preflight);
    let policy=Arc::new(WorkspacePolicy::with_scope(instance.clone(),scope.clone(),fence)
        .map_err(|_|IshBootstrapError::Ish("role workspace policy unavailable".into()))?);
    let backend=Arc::new(crate::ish_exec_backend::IshExecBackend::new(instance.clone(),policy.clone(),std::time::Duration::from_secs(15))
        .map_err(|_|IshBootstrapError::Ish("role executor unavailable".into()))?);
    let info=EnvironmentInfo {
        shell:ShellInfo{name:"bash".into(),path:"/bin/bash".into()},executor_version:"0.167.0".into(),provider_id:None,
        cwd:Some(uri(&scope.cwd)?),user_home_dir:Some(uri(&format!("{}/home",scope.scratch))?),platform_os:Some("linux".into()),
        prepend_path_dirs:vec![],temporary_directories:Some(vec![uri(&scope.scratch)?]),temp_dir:Some(uri(&scope.scratch)?),
        capabilities:EnvironmentCapabilities::default(),
    };
    let overrides=scope_config(&scope);
    crate::embedded_runtime::register(backend.clone(),filesystem,info,false,overrides,
        Arc::new(move |config|validate_scope_config(config,&scope)))?;
    ATTEMPT_EXECUTION.set((backend,policy)).map_err(|_|IshBootstrapError::Ish("attempt execution already registered".into()))?;
    crate::tah_attempt::install(attempt)?;
    Ok(instance)
}

fn access_map() -> BTreeMap<String, FileSystemAccessMode> {
    WorkspaceScope::legacy().access()
}

pub fn config_overrides() -> Vec<(String, TomlValue)> {
    scope_config(&WorkspaceScope::legacy())
}
fn scope_config(scope: &WorkspaceScope) -> Vec<(String, TomlValue)> {
    let filesystem: BTreeMap<_,_> = scope.access().into_iter().map(|(path, access)| {
        let label = match access { FileSystemAccessMode::Read=>"read", FileSystemAccessMode::Write=>"write", FileSystemAccessMode::Deny=>"deny" };
        (path, label)
    }).collect();
    let values = [
        ("default_permissions", serde_json::json!("alma-qualification")),
        ("permissions", serde_json::json!({"alma-qualification":{"filesystem":filesystem,"network":{"enabled":false}}})),
        ("approval_policy", serde_json::json!("never")),
        ("shell_environment_policy", serde_json::json!({
            "inherit":"none", "ignore_default_excludes":false, "set":scope.env()
        })),
    ];
    values.into_iter().map(|(key,value)| (key.into(), serde_json::from_value(value).expect("static TOML values"))).collect()
}

fn validate_permissions(context: &FileSystemSandboxContext) -> Result<(), PolicyError> {
    validate_scope_permissions(context,&WorkspaceScope::legacy())
}
fn validate_scope_permissions(context: &FileSystemSandboxContext, scope: &WorkspaceScope) -> Result<(), PolicyError> {
    if !context.sandbox_override.is_no_override() {
        return Err(PolicyError::UnsupportedContext("sandbox-override"));
    }
    if context.windows_sandbox_is_requested() || context.use_legacy_landlock {
        return Err(PolicyError::UnsupportedContext("foreign-sandbox"));
    }
    // Core's exec_server_params_for_request adds Some(Reconcile) on every
    // platform. This is inert without a Windows sandbox; it does not request a
    // proxy or weaken the independently enforced DenyDirect network grant.
    if context.windows_sandbox_proxy_settings_mode.is_some_and(|mode| {
        mode != WindowsSandboxProxySettingsMode::Reconcile
    }) {
        return Err(PolicyError::UnsupportedContext("windows-proxy-mode"));
    }
    let policy = context.permissions.file_system_sandbox_policy();
    if context.permissions.network_sandbox_policy() != NetworkSandboxPolicy::Restricted {
        return Err(PolicyError::UnsupportedContext("network-profile-mismatch"));
    }
    if policy.glob_scan_max_depth.is_some() { return Err(PolicyError::UnsupportedContext("glob-depth")); }
    let mut entries = BTreeMap::new();
    for entry in &policy.entries {
        if entry.missing_path_behavior.is_some() { return Err(PolicyError::UnsupportedContext("missing-path-behavior")); }
        let path = match &entry.path {
            FileSystemPath::Path { path } => path.to_abs_path().map_err(|_|PolicyError::Denied)?.to_string_lossy().into_owned(),
            FileSystemPath::Special { value: FileSystemSpecialPath::Root } => "/".into(),
            _ => return Err(PolicyError::Unsupported),
        };
        if entries.insert(path,entry.access).is_some() { return Err(PolicyError::Denied); }
    }
    // The initial fixed workspace accepts exactly its frozen policy. A narrower
    // policy must not accidentally inherit a broader grant, and an unfamiliar
    // policy is never silently translated to unrestricted guest execution.
    if entries != scope.access() { return Err(PolicyError::UnsupportedContext("filesystem-profile-mismatch")); }
    Ok(())
}

pub fn validate_config(config: &Config) -> std::io::Result<()> {
    validate_scope_config(config,&WorkspaceScope::legacy())
}
fn validate_scope_config(config: &Config,scope: &WorkspaceScope) -> std::io::Result<()> {
    // Upstream's default ignore_default_excludes is true. Validate the actual
    // resolved policy before accepting the environment, not only at first exec.
    let env = &config.permissions.shell_environment_policy;
    if env.inherit != ShellEnvironmentPolicyInherit::None || env.ignore_default_excludes
        || !env.exclude.is_empty() || !env.include_only.is_empty() || env.r#set != scope.env() {
        return Err(std::io::Error::other("ALMA shell environment differs from the trusted explicit profile"));
    }
    let context = FileSystemSandboxContext::from_permission_profile(
        config.permissions.effective_permission_profile(),
        codex_utils_path_uri::PathUri::parse(&format!("file://{}",scope.cwd)).map_err(std::io::Error::other)?,
    );
    validate_scope_permissions(&context,scope).map_err(|_|std::io::Error::other("ALMA workspace permissions differ from the host grant"))
}

pub struct WorkspacePolicy {
    instance: Arc<IshInstance>,
    gate: Arc<Semaphore>,
    quarantined: Arc<AtomicBool>,
    scope: Arc<WorkspaceScope>,
    fence: Arc<crate::execution_fence::ExecutionFence>,
}
impl WorkspacePolicy {
    pub fn new(instance: Arc<IshInstance>) -> Result<Self, PolicyError> {
        Self::with_scope(instance,Arc::new(WorkspaceScope::legacy()),Arc::new(crate::execution_fence::ExecutionFence::default()))
    }
    fn with_scope(instance: Arc<IshInstance>,scope: Arc<WorkspaceScope>,fence:Arc<crate::execution_fence::ExecutionFence>) -> Result<Self, PolicyError> {
        if !instance.workspace_policy_enabled() { return Err(PolicyError::NotReady); }
        Ok(Self {instance,gate:Arc::new(Semaphore::new(1)),quarantined:Arc::new(AtomicBool::new(false)),scope,fence})
    }
}

struct Lease {
    grant: Option<Arc<WorkspaceGrant>>,
    _permit: OwnedSemaphorePermit,
    quarantined: Arc<AtomicBool>,
    finished: bool,
    _fence_permit: crate::execution_fence::ExecutionPermit,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if !self.finished { self.quarantined.store(true,Ordering::Release); }
    }
}
impl ExecutionLease for Lease {
    fn not_started(mut self:Box<Self>) { self.finished=true; self.grant.take(); }
    fn complete(&mut self)->Result<(),PolicyError> { self.finished=true; self.grant.take(); Ok(()) }
    fn quarantine(self:Box<Self>) { self.quarantined.store(true,Ordering::Release); }
}

impl ExecutionPolicy for WorkspacePolicy {
    fn prepare<'a>(&'a self, request:&'a ExecParams)
        -> std::pin::Pin<Box<dyn std::future::Future<Output=Result<PreparedExecution,PolicyError>>+Send+'a>> {
        Box::pin(async move {
            let permit=self.gate.clone().acquire_owned().await.map_err(|_|PolicyError::NotReady)?;
            let fence_permit=self.fence.acquire().map_err(|_|PolicyError::NotReady)?;
            if self.quarantined.load(Ordering::Acquire) { return Err(PolicyError::NotReady); }
            let cwd=request.cwd.to_abs_path().map_err(|_|PolicyError::Denied)?;
            if !self.scope.allowed_cwds.iter().any(|root|cwd.starts_with(Path::new(root))) { return Err(PolicyError::Denied); }
            if let Some(context)=&request.sandbox { validate_scope_permissions(context,&self.scope)?; }
            let mut env=self.scope.env();
            if let Some(policy)=&request.env_policy {
                // Core appends these exclusions even when the configured
                // inheritance is None. They remove stale runtime metadata,
                // then Core supplies any fresh values in request.env.
                let runtime_exclusions = [
                    "CODEX_PERMISSION_PROFILE", "CODEX_VERSION",
                    codex_apply_patch::CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS_ENV_VAR,
                    "CODEX_PLUGIN_METRICS_OUTPUT",
                ];
                if policy.inherit!=ShellEnvironmentPolicyInherit::None
                    || policy.exclude.iter().any(|key| !runtime_exclusions.contains(&key.as_str()))
                    || !policy.include_only.is_empty() || policy.ignore_default_excludes {
                    return Err(PolicyError::UnsupportedContext("shell-environment-policy"));
                }
                for key in &policy.exclude { env.remove(key); }
                env.extend(policy.r#set.clone());
            }
            env.extend(request.env.clone());
            let grant=Arc::new(self.instance.prepare_workspace_grant(
                &self.scope.read.iter().map(PathBuf::from).collect::<Vec<_>>(),
                &self.scope.write.iter().map(PathBuf::from).collect::<Vec<_>>(),
                WorkspaceNetworkPolicy::DenyDirect,
            ).map_err(|_|PolicyError::UnsupportedContext("workspace-grant-rejected"))?);
            Ok(PreparedExecution {
                options:SpawnOpts {argv:request.argv.clone(),envp:Some(env.into_iter().collect()),
                    cwd:Some(cwd.to_path_buf()),tty:false,size:None,pipe_stdin:request.pipe_stdin,arg0:None},
                grant:Some(grant.clone()),
                lease:Box::new(Lease {grant:Some(grant),_permit:permit,quarantined:self.quarantined.clone(),finished:false,_fence_permit:fence_permit}),
            })
        })
    }
}
