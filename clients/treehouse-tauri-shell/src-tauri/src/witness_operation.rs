//! Native ownership for the single in-flight witness operation.

use crate::witness_bridge::Bytes32;
use crate::witness_session::SessionSnapshot;
use std::sync::{Arc, Mutex};

pub(crate) const OPERATION_REFUSED: &str = "invalid_witness_operation";

pub(crate) struct WitnessOperationRegistry {
    state: Mutex<State>,
    entropy: Mutex<Box<dyn FnMut() -> Result<Bytes32, &'static str> + Send>>,
}

#[derive(Default)]
struct State {
    active: Option<Active>,
}

struct Active {
    marker: Arc<()>,
    id: Bytes32,
    session: SessionSnapshot,
    cancelled: bool,
}

pub(crate) struct OperationToken {
    marker: Arc<()>,
    id: Bytes32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CancellationTarget {
    id: Bytes32,
    session_digest: Bytes32,
}

impl WitnessOperationRegistry {
    pub(crate) fn new() -> Self {
        Self::from_entropy(crate::witness_entropy::nonce32)
    }

    fn from_entropy(
        entropy: impl FnMut() -> Result<Bytes32, &'static str> + Send + 'static,
    ) -> Self {
        Self {
            state: Mutex::new(State::default()),
            entropy: Mutex::new(Box::new(entropy)),
        }
    }

    pub(crate) fn begin(&self, session: &SessionSnapshot) -> Result<OperationToken, &'static str> {
        let mut state = self.state.lock().map_err(|_| OPERATION_REFUSED)?;
        if state.active.is_some() {
            return Err(OPERATION_REFUSED);
        }
        let id = (self.entropy.lock().map_err(|_| OPERATION_REFUSED)?)()?;
        let marker = Arc::new(());
        state.active = Some(Active {
            marker: marker.clone(),
            id,
            session: session.clone(),
            cancelled: false,
        });
        Ok(OperationToken { marker, id })
    }

    pub(crate) fn cancel(
        &self,
        id: Bytes32,
        session: &SessionSnapshot,
    ) -> Option<CancellationTarget> {
        let mut state = self.state.lock().ok()?;
        let active = state.active.as_mut()?;
        if active.id != id || active.session != *session || active.cancelled {
            return None;
        }
        active.cancelled = true;
        Some(active.target())
    }

    pub(crate) fn lifecycle_invalidated(&self) -> Option<CancellationTarget> {
        let mut state = self.state.lock().ok()?;
        let active = state.active.as_mut()?;
        if active.cancelled {
            return None;
        }
        active.cancelled = true;
        Some(active.target())
    }

    pub(crate) fn current(&self, token: &OperationToken, session: &SessionSnapshot) -> bool {
        self.state.lock().is_ok_and(|state| {
            state.active.as_ref().is_some_and(|active| {
                Arc::ptr_eq(&active.marker, &token.marker)
                    && active.id == token.id
                    && active.session == *session
                    && !active.cancelled
            })
        })
    }

    pub(crate) fn complete(&self, token: &OperationToken) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state
            .active
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(&active.marker, &token.marker))
        {
            state.active = None;
            true
        } else {
            false
        }
    }
}

impl Active {
    fn target(&self) -> CancellationTarget {
        CancellationTarget {
            id: self.id,
            session_digest: self.session.digest(),
        }
    }
}

impl OperationToken {
    pub(crate) fn id(&self) -> Bytes32 {
        self.id
    }
}

impl CancellationTarget {
    pub(crate) fn id(&self) -> Bytes32 {
        self.id
    }

    pub(crate) fn session_digest(&self) -> Bytes32 {
        self.session_digest
    }
}

#[cfg(test)]
pub(crate) mod test_adapter {
    use super::*;

    pub(crate) fn registry(
        entropy: impl FnMut() -> Result<Bytes32, &'static str> + Send + 'static,
    ) -> WitnessOperationRegistry {
        WitnessOperationRegistry::from_entropy(entropy)
    }
}
