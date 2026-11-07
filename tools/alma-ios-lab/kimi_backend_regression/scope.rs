//! Explicit scope boundary double. No files, mounts, iSH or credentials.
use codex_exec_server::{ExecProcess, ExecProcessEvent};
use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
pub(crate) struct ScopeLayout {
    pub workspace_root: String,
    pub scratch_root: String,
    pub shell_environment: HashMap<String, String>,
}
pub(crate) struct GuestScope {
    pub process: Arc<dyn ExecProcess>,
    pub finishes: Mutex<Vec<bool>>,
    pub spawn_fails: AtomicBool,
    pub spawned: AtomicBool,
    layout: ScopeLayout,
}
impl GuestScope {
    pub fn new(process: Arc<dyn ExecProcess>) -> Arc<Self> {
        Arc::new(Self {
            process,
            finishes: Mutex::new(vec![]),
            spawn_fails: AtomicBool::new(false),
            spawned: AtomicBool::new(false),
            layout: ScopeLayout {
                workspace_root: "/workspace/attempts/test/view".into(),
                scratch_root: "/workspace/attempts/test/scratch".into(),
                shell_environment: HashMap::from([(
                    "PATH".into(),
                    "/usr/local/bin:/usr/bin:/bin".into(),
                )]),
            },
        })
    }
    pub fn layout(&self) -> &ScopeLayout {
        &self.layout
    }
    pub async fn spawn(
        &self,
        argv: Vec<String>,
        env: HashMap<String, String>,
    ) -> io::Result<Arc<dyn ExecProcess>> {
        assert_eq!(
            argv,
            ["/usr/bin/node", "/workspace/.runtime/kimi/guest.mjs"]
        );
        assert_eq!(env["PATH"], self.layout.shell_environment["PATH"]);
        assert_eq!(
            env.get("LD_LIBRARY_PATH"),
            self.layout.shell_environment.get("LD_LIBRARY_PATH")
        );
        assert_eq!(
            env["KIMI_CODE_HOME"],
            format!("{}/home", self.layout.scratch_root)
        );
        assert!(!env.values().any(|value| value.contains("fixture-real-key")));
        self.spawned.store(true, Ordering::SeqCst);
        if self.spawn_fails.load(Ordering::SeqCst) {
            return Err(io::Error::other("private spawn failure"));
        }
        Ok(self.process.clone())
    }
    pub async fn finish(&self, complete: bool) -> io::Result<()> {
        if complete && self.spawned.load(Ordering::SeqCst) {
            let closed = match self.process.read(None, None, None).await {
                Ok(status) => status.closed,
                Err(error) => {
                    // A consuming protocol reader has acknowledged its output.
                    // Observe retained lifecycle closure without rewinding it.
                    assert!(error.to_string().contains("invalid acknowledged output cursor"));
                    let mut events = self.process.subscribe_events();
                    tokio::time::timeout(std::time::Duration::from_secs(1), async {
                        loop {
                            match events.recv().await {
                                Ok(ExecProcessEvent::Closed { .. }) => return true,
                                Ok(_) => {},
                                Err(_) => return false,
                            }
                        }
                    }).await.unwrap()
                }
            };
            assert!(
                closed,
                "scope finish must follow confirmed process closure"
            );
        }
        self.finishes.lock().unwrap().push(complete);
        if complete {
            Ok(())
        } else {
            Err(io::Error::other("private scope failure"))
        }
    }
}
