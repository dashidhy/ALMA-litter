//! Opt-in device qualification of the official in-process Code Mode runtime.
//!
//! This provider adds no JavaScript file/network access. Nested tools still use
//! Core's delegate and the registered scoped executor/file system. Those policy
//! boundaries are not an exploit-resistant native memory boundary: the pinned
//! iOS V8 archive lacks the desktop memory sandbox. Do not enable in shipping
//! builds until that difference and process resource limits are accepted.

use std::sync::Arc;

use codex_code_mode_protocol::{
    CodeModeSession, CodeModeSessionCellExecutionLimits, CodeModeSessionProvider,
    CodeModeSessionProviderFuture,
};
use codex_code_mode_runtime::{InProcessCodeModeSession, V8JitMode, initialize_v8};

pub struct IosCodeModeProbeProvider;

impl IosCodeModeProbeProvider {
    pub fn initialize() -> Result<Arc<dyn CodeModeSessionProvider>, String> {
        // Must run before any session/engine can use the upstream lazy default
        // (which enables JIT). The upstream once-only initializer rejects a
        // conflicting prior selection rather than silently changing modes.
        initialize_v8(V8JitMode::Disabled)?;
        Ok(Arc::new(Self))
    }
}

impl CodeModeSessionProvider for IosCodeModeProbeProvider {
    fn create_session(&self) -> CodeModeSessionProviderFuture<'_> {
        self.create_session_with_limits(CodeModeSessionCellExecutionLimits::default())
    }

    fn create_session_with_limits(
        &self,
        limits: CodeModeSessionCellExecutionLimits,
    ) -> CodeModeSessionProviderFuture<'_> {
        Box::pin(async move {
            // Official InProcessCodeModeSession currently clears this option.
            // Refuse a claimed heap guarantee we cannot actually enforce.
            if limits.max_heap_size_bytes.is_some() {
                return Err("iOS Code Mode probe does not enforce a per-cell heap limit".into());
            }
            let session: Arc<dyn CodeModeSession> =
                Arc::new(InProcessCodeModeSession::with_limits(limits));
            Ok(session)
        })
    }
}
