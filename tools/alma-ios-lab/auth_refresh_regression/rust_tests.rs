use crate::auth_refresh::*;
use crate::{ChatgptAuthTokensRefreshParams, ChatgptAuthTokensRefreshReason};
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
use tokio::time::{Duration, Instant};

struct Provider { calls: AtomicUsize, mode: u8 }
#[async_trait::async_trait]
impl ChatgptAuthRefreshProvider for Provider {
    async fn refresh(&self, request: ChatgptAuthRefreshRequest) -> Result<ChatgptAuthRefreshTokens, ChatgptAuthRefreshError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(request.timeout_ms <= 6_000);
        assert!(request.previous_account_id.as_deref() == Some("dummy-account"));
        match self.mode {
            1 => return Err(ChatgptAuthRefreshError::RefreshFailed),
            2 => std::future::pending::<()>().await,
            _ => (),
        }
        Ok(ChatgptAuthRefreshTokens {
            access_token: if self.mode == 4 { "" } else { "DUMMY_ACCESS_SECRET" }.into(),
            account_id: if self.mode == 3 { "wrong-account" } else { "dummy-account" }.into(),
            plan_type: Some("plus".into()),
        })
    }
}
fn params() -> ChatgptAuthTokensRefreshParams {
    ChatgptAuthTokensRefreshParams { reason: ChatgptAuthTokensRefreshReason::Unauthorized, previous_account_id: Some("dummy-account".into()) }
}

#[tokio::test(start_paused = true)]
async fn successful_refresh_delivers_typed_wire_response_once() {
    let dispatcher = AuthRefreshDispatcher::default();
    let provider = Arc::new(Provider { calls: AtomicUsize::new(0), mode: 0 });
    dispatcher.set_provider(Some(provider.clone()));
    let replies = AtomicUsize::new(0);
    dispatcher.dispatch(true, params(), Instant::now(), |response| async {
        replies.fetch_add(1, Ordering::SeqCst);
        let wire = serde_json::to_value(response.unwrap()).unwrap();
        assert!(wire["accessToken"] == "DUMMY_ACCESS_SECRET");
        assert!(wire["chatgptAccountId"] == "dummy-account");
        assert!(wire["chatgptPlanType"] == "plus");
        Ok(())
    }).await.unwrap();
    assert!(provider.calls.load(Ordering::SeqCst) == 1);
    assert!(replies.load(Ordering::SeqCst) == 1);
}

#[tokio::test(start_paused = true)]
async fn remote_request_is_rejected_without_touching_local_provider() {
    let dispatcher = AuthRefreshDispatcher::default();
    let provider = Arc::new(Provider { calls: AtomicUsize::new(0), mode: 0 });
    dispatcher.set_provider(Some(provider.clone()));
    dispatcher.dispatch(false, params(), Instant::now(), |response| async {
        let error = response.unwrap_err();
        assert!(error.code == -32000 && error.message.contains("cannot be supplied"));
        Ok(())
    }).await.unwrap();
    assert!(provider.calls.load(Ordering::SeqCst) == 0);
}

#[tokio::test(start_paused = true)]
async fn absent_provider_and_provider_failures_are_explicit_and_redacted() {
    for mode in [None, Some(1), Some(3), Some(4)] {
        let dispatcher = AuthRefreshDispatcher::default();
        if let Some(mode) = mode { dispatcher.set_provider(Some(Arc::new(Provider { calls: AtomicUsize::new(0), mode }))); }
        let replies = AtomicUsize::new(0);
        dispatcher.dispatch(true, params(), Instant::now(), |response| async {
            replies.fetch_add(1, Ordering::SeqCst);
            let error = response.unwrap_err();
            assert!(error.code == -32000 && error.data.is_none());
            assert!(!error.message.contains("DUMMY") && !error.message.contains("dummy-account"));
            Ok(())
        }).await.unwrap();
        assert!(replies.load(Ordering::SeqCst) == 1);
    }
    assert!(format!("{:?}", ChatgptAuthRefreshTokens { access_token: "DUMMY".into(), account_id: "private".into(), plan_type: None }) == "ChatgptAuthRefreshTokens(<redacted>)");
}

#[tokio::test(start_paused = true)]
async fn stuck_native_callback_replies_before_core_ten_second_deadline() {
    let dispatcher = AuthRefreshDispatcher::default();
    dispatcher.set_provider(Some(Arc::new(Provider { calls: AtomicUsize::new(0), mode: 2 })));
    let start = Instant::now();
    dispatcher.dispatch(true, params(), start, |response| async {
        assert!(response.unwrap_err().message.contains("timed out"));
        assert!(Instant::now().duration_since(start) < Duration::from_secs(10));
        Ok(())
    }).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn delayed_dispatch_does_not_start_an_expired_native_refresh() {
    let dispatcher = AuthRefreshDispatcher::default();
    let provider = Arc::new(Provider { calls: AtomicUsize::new(0), mode: 0 });
    dispatcher.set_provider(Some(provider.clone()));
    let received = Instant::now();
    tokio::time::advance(Duration::from_secs(8)).await;
    dispatcher.dispatch(true, params(), received, |response| async {
        assert!(response.unwrap_err().message.contains("timed out")); Ok(())
    }).await.unwrap();
    assert!(provider.calls.load(Ordering::SeqCst) == 0);
}

#[tokio::test(start_paused = true)]
async fn response_transport_cannot_hang_the_dispatcher() {
    let dispatcher = AuthRefreshDispatcher::default();
    let start = Instant::now();
    let outcome = dispatcher.dispatch(true, params(), start, |_| async {
        std::future::pending::<Result<(), ()>>().await
    }).await;
    assert!(matches!(outcome, Err(AuthRefreshDeliveryError::TimedOut)));
    assert!(Instant::now().duration_since(start) == Duration::from_secs(9));
    assert!(matches!(dispatcher.dispatch(true, params(), Instant::now(), |_| async { Err(()) }).await, Err(AuthRefreshDeliveryError::Disconnected)));
}

#[tokio::test(start_paused = true)]
async fn removing_provider_invalidates_its_inflight_result() {
    struct Delayed { started: AtomicUsize }
    #[async_trait::async_trait]
    impl ChatgptAuthRefreshProvider for Delayed {
        async fn refresh(&self, _: ChatgptAuthRefreshRequest) -> Result<ChatgptAuthRefreshTokens, ChatgptAuthRefreshError> {
            self.started.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(10)).await;
            Ok(ChatgptAuthRefreshTokens { access_token: "DUMMY_SECRET".into(), account_id: "dummy-account".into(), plan_type: None })
        }
    }
    let dispatcher = AuthRefreshDispatcher::default();
    let provider = Arc::new(Delayed { started: AtomicUsize::new(0) });
    dispatcher.set_provider(Some(provider.clone()));
    let dispatch = dispatcher.dispatch(true, params(), Instant::now(), |response| async {
        assert!(response.unwrap_err().message.contains("unavailable")); Ok(())
    });
    let remove = async {
        while provider.started.load(Ordering::SeqCst) == 0 { tokio::task::yield_now().await; }
        dispatcher.set_provider(None);
    };
    let (outcome, ()) = tokio::join!(dispatch, remove);
    outcome.unwrap();
}
