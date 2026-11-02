//! One-way admission fence for an immutable attempt; never reopened/reused.
use std::io;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct State { closed: bool, active: usize }
#[derive(Default)]
pub struct ExecutionFence { state: Mutex<State> }
pub struct ExecutionPermit { fence: Arc<ExecutionFence> }
impl ExecutionFence {
    pub fn acquire(self: &Arc<Self>) -> io::Result<ExecutionPermit> {
        let mut state=self.state.lock().map_err(|_|io::Error::other("execution fence poisoned"))?;
        if state.closed { return Err(io::Error::new(io::ErrorKind::PermissionDenied,"attempt admission closed")); }
        state.active=state.active.checked_add(1).ok_or_else(||io::Error::other("execution count overflow"))?;
        Ok(ExecutionPermit {fence:self.clone()})
    }
    pub fn close(&self) {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).closed=true;
    }
    pub fn drained(&self) -> bool {
        self.state.lock().is_ok_and(|state|state.closed && state.active==0)
    }
}
impl Drop for ExecutionPermit {
    fn drop(&mut self) {
        let mut state=self.fence.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.active==0 {state.closed=true;} else {state.active-=1;}
    }
}
