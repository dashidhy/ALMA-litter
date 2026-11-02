//! Native credential refresh for local, Codex-owned server requests.
//!
//! Credentials remain in the native store. No token is logged or retained by
//! this registry, and remote runtimes never invoke the native provider.
use std::future::Future;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use codex_app_server_protocol::{
    ChatgptAuthTokensRefreshParams, ChatgptAuthTokensRefreshResponse, JSONRPCErrorError,
};
use tokio::time::{Instant, timeout_at};

// Upstream external_auth.rs has a 10-second deadline. Reserve time to deliver
// the response, including when callback execution starts late in the event loop.
const CALLBACK_BUDGET: Duration = Duration::from_secs(7);
const RESPONSE_BUDGET: Duration = Duration::from_secs(9);
const NATIVE_BUDGET_MS: u32 = 6_000;

#[derive(Clone, uniffi::Record)]
pub struct ChatgptAuthRefreshRequest {
    pub previous_account_id: Option<String>,
    pub timeout_ms: u32,
}

#[derive(Clone, uniffi::Record)]
pub struct ChatgptAuthRefreshTokens {
    pub access_token: String,
    pub account_id: String,
    pub plan_type: Option<String>,
}

impl std::fmt::Debug for ChatgptAuthRefreshTokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ChatgptAuthRefreshTokens(<redacted>)")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum ChatgptAuthRefreshError {
    #[error("native ChatGPT credential refresh is unavailable")]
    Unavailable,
    #[error("ChatGPT credential refresh timed out")]
    TimedOut,
    #[error("ChatGPT account or stored credentials changed during refresh")]
    AccountChanged,
    #[error("ChatGPT credential refresh failed")]
    RefreshFailed,
    #[error("local ChatGPT credentials cannot be supplied to this server")]
    UnsupportedServer,
}

impl From<uniffi::UnexpectedUniFFICallbackError> for ChatgptAuthRefreshError {
    fn from(_: uniffi::UnexpectedUniFFICallbackError) -> Self {
        // Foreign error descriptions may contain credentials. Never forward them.
        Self::RefreshFailed
    }
}

#[uniffi::export(callback_interface)]
#[async_trait::async_trait]
pub trait ChatgptAuthRefreshProvider: Send + Sync {
    async fn refresh(
        &self,
        request: ChatgptAuthRefreshRequest,
    ) -> Result<ChatgptAuthRefreshTokens, ChatgptAuthRefreshError>;
}

#[derive(Default)]
pub(crate) struct AuthRefreshDispatcher {
    provider: RwLock<Option<Arc<dyn ChatgptAuthRefreshProvider>>>,
}

pub(crate) fn dispatcher() -> &'static AuthRefreshDispatcher {
    static INSTANCE: OnceLock<AuthRefreshDispatcher> = OnceLock::new();
    INSTANCE.get_or_init(AuthRefreshDispatcher::default)
}

impl AuthRefreshDispatcher {
    pub(crate) fn set_provider(&self, provider: Option<Arc<dyn ChatgptAuthRefreshProvider>>) {
        *self
            .provider
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = provider;
    }

    async fn refresh(
        &self,
        local_codex_server: bool,
        params: ChatgptAuthTokensRefreshParams,
        deadline: Instant,
    ) -> Result<ChatgptAuthTokensRefreshResponse, ChatgptAuthRefreshError> {
        if !local_codex_server {
            return Err(ChatgptAuthRefreshError::UnsupportedServer);
        }
        if Instant::now() >= deadline {
            return Err(ChatgptAuthRefreshError::TimedOut);
        }
        let provider = self
            .provider
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .ok_or(ChatgptAuthRefreshError::Unavailable)?;
        let expected = params.previous_account_id.filter(|id| !id.is_empty());
        let tokens = timeout_at(
            deadline,
            provider.refresh(ChatgptAuthRefreshRequest {
                previous_account_id: expected.clone(),
                timeout_ms: NATIVE_BUDGET_MS.min(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .as_millis() as u32,
                ),
            }),
        )
        .await
        .map_err(|_| ChatgptAuthRefreshError::TimedOut)??;
        let still_registered = self
            .provider
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &provider));
        if !still_registered {
            return Err(ChatgptAuthRefreshError::Unavailable);
        }
        if tokens.access_token.trim().is_empty() || tokens.account_id.trim().is_empty() {
            return Err(ChatgptAuthRefreshError::RefreshFailed);
        }
        if expected.as_ref().is_some_and(|id| id != &tokens.account_id) {
            return Err(ChatgptAuthRefreshError::AccountChanged);
        }
        Ok(ChatgptAuthTokensRefreshResponse {
            access_token: tokens.access_token,
            chatgpt_account_id: tokens.account_id,
            chatgpt_plan_type: tokens.plan_type,
        })
    }

    /// Exactly one response attempt. A callback failure becomes an explicit RPC
    /// error; a disconnected/stalled response transport is itself bounded.
    pub(crate) async fn dispatch<R, F>(
        &self,
        local_codex_server: bool,
        params: ChatgptAuthTokensRefreshParams,
        received_at: Instant,
        reply: R,
    ) -> Result<(), AuthRefreshDeliveryError>
    where
        R: FnOnce(Result<ChatgptAuthTokensRefreshResponse, JSONRPCErrorError>) -> F,
        F: Future<Output = Result<(), ()>>,
    {
        let response = self
            .refresh(local_codex_server, params, received_at + CALLBACK_BUDGET)
            .await
            .map_err(rpc_error);
        timeout_at(received_at + RESPONSE_BUDGET, reply(response))
            .await
            .map_err(|_| AuthRefreshDeliveryError::TimedOut)?
            .map_err(|_| AuthRefreshDeliveryError::Disconnected)
    }
}

pub(crate) fn rpc_error(error: ChatgptAuthRefreshError) -> JSONRPCErrorError {
    JSONRPCErrorError {
        code: -32000,
        message: error.to_string(),
        data: None,
    }
}

#[derive(Debug)]
pub(crate) enum AuthRefreshDeliveryError {
    TimedOut,
    Disconnected,
}
