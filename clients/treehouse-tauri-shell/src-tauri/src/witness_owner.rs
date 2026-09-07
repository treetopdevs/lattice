//! Native-owned document state for later plugin wiring; no public IPC surface.
//!
//! Both nonces are allocated before an owner exists. Entropy failure or poisoned
//! state never falls back to a usable owner. Only the real first navigation ->
//! Started -> Finished sequence may establish a session. URL-only Tauri events
//! cannot distinguish overlapping documents: ambiguity and later navigation
//! permanently refuse witness operations without blocking preview navigation.
//! Android initial hook ordering remains a physical-device validation gate.

use crate::witness_bridge::Bytes32;
use crate::witness_document::WitnessDocumentSession;
use crate::witness_session::{SessionSnapshot, SESSION_REFUSED};
use std::sync::Mutex;
use tauri::{webview::PageLoadEvent, Runtime, Url, Webview};

type Document = WitnessDocumentSession<Box<dyn FnMut() -> Bytes32 + Send>>;

pub(crate) struct WitnessOwner {
    state: Mutex<Result<Document, &'static str>>,
}

impl WitnessOwner {
    pub(crate) fn new() -> Self {
        Self::from_entropy(crate::witness_entropy::nonce32)
    }

    fn from_entropy(mut nonce: impl FnMut() -> Result<Bytes32, &'static str>) -> Self {
        let state = (|| {
            let launch = nonce()?;
            let first_navigation = nonce()?;
            let source: Box<dyn FnMut() -> Bytes32 + Send> = Box::new(move || first_navigation);
            Ok(WitnessDocumentSession::new(launch, source))
        })();
        Self {
            state: Mutex::new(state),
        }
    }

    /// Tauri navigation hook result. Witness refusal must never block preview.
    pub(crate) fn navigation_requested<R: Runtime>(&self, webview: &Webview<R>, url: &Url) -> bool {
        if let Ok(mut state) = self.state.lock() {
            if let Ok(document) = state.as_mut() {
                let _ = document.navigation_requested(webview, url);
            }
        }
        true
    }

    pub(crate) fn page_load<R: Runtime>(
        &self,
        webview: &Webview<R>,
        event: PageLoadEvent,
        url: &Url,
    ) -> Result<(), &'static str> {
        let mut state = self.state.lock().map_err(|_| SESSION_REFUSED)?;
        state
            .as_mut()
            .map_err(|reason| *reason)?
            .page_load(webview, event, url)
    }

    pub(crate) fn snapshot<R: Runtime>(
        &self,
        webview: &Webview<R>,
    ) -> Result<SessionSnapshot, &'static str> {
        let state = self.state.lock().map_err(|_| SESSION_REFUSED)?;
        state.as_ref().map_err(|reason| *reason)?.snapshot(webview)
    }

    pub(crate) fn current<R: Runtime>(
        &self,
        webview: &Webview<R>,
        snapshot: &SessionSnapshot,
    ) -> bool {
        self.snapshot(webview).is_ok_and(|fresh| fresh == *snapshot)
    }

    pub(crate) fn lifecycle_cancelled(&self) {
        if let Ok(mut state) = self.state.lock() {
            if let Ok(document) = state.as_mut() {
                document.lifecycle_cancelled();
            }
        }
    }

    pub(crate) fn owner_destroyed(&self) {
        if let Ok(mut state) = self.state.lock() {
            if let Ok(document) = state.as_mut() {
                document.owner_destroyed();
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod test_adapter {
    use super::*;
    pub(crate) fn from_entropy(
        source: impl FnMut() -> Result<Bytes32, &'static str>,
    ) -> WitnessOwner {
        WitnessOwner::from_entropy(source)
    }
    pub(crate) fn poison(owner: &WitnessOwner) {
        let _guard = owner.state.lock().unwrap();
        panic!("deliberate native owner mutex poison");
    }
}
