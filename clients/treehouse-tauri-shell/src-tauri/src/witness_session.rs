//! Native caller ownership and document-session gate; no IPC registration or RNG.
//!
//! Native hooks must invalidate on navigation, load start, lifecycle cancellation,
//! and destruction. Tauri supplies no document identifier in PageLoadPayload:
//! a URL alone cannot correlate a Finished event to a Started event. Tickets must
//! remain native-owned. Overlapping starts latch this guard closed; replacement
//! requires a fresh trusted owner lifecycle, never a caller request or timer.

use crate::witness_bridge::{session_digest, Bytes32};
use std::sync::Arc;
use tauri::{Runtime, Url, Webview};

pub const SESSION_REFUSED: &str = "invalid_witness_session";

// Native owner identity remains distinct even if a Webview is recreated within
// the same launch. Arc allocation identity is process-local, never serialized.
#[derive(Clone, Debug)]
struct OwnerToken(Arc<()>);
impl PartialEq for OwnerToken {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl Eq for OwnerToken {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionSnapshot {
    owner: OwnerToken,
    generation: u64,
    digest: Bytes32,
    document: Url,
}

impl SessionSnapshot {
    pub fn digest(&self) -> Bytes32 {
        self.digest
    }
}

/// Not Clone or Deserialize: only a validated native load start creates a ticket.
#[derive(Debug)]
pub struct NativeLoadTicket {
    owner: OwnerToken,
    generation: u64,
    document: Url,
}

pub struct WitnessSession {
    owner: OwnerToken,
    launch_nonce: Bytes32,
    generation: u64,
    pending: Option<u64>,
    active: Option<SessionSnapshot>,
    ambiguous: bool,
    destroyed: bool,
}

struct NativeFacts {
    window: String,
    webview: String,
    document: Url,
}

impl NativeFacts {
    fn query<R: Runtime>(webview: &Webview<R>) -> Result<Self, &'static str> {
        Ok(Self {
            window: webview.window().label().to_owned(),
            webview: webview.label().to_owned(),
            document: webview.url().map_err(|_| SESSION_REFUSED)?,
        })
    }
    fn owner(&self) -> bool {
        self.window == "main" && self.webview == "main"
    }
    fn local(&self) -> bool {
        self.owner() && local_document(&self.document)
    }
}

fn local_document(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("tauri.localhost")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
}

impl WitnessSession {
    /// Native random launch nonce only. Construction never establishes usability.
    pub fn new(launch_nonce: Bytes32) -> Self {
        Self {
            owner: OwnerToken(Arc::new(())),
            launch_nonce,
            generation: 0,
            pending: None,
            active: None,
            ambiguous: false,
            destroyed: false,
        }
    }

    fn advance(&mut self) {
        self.active = None;
        self.pending = None;
        match self.generation.checked_add(1) {
            Some(next) => self.generation = next,
            None => self.destroyed = true,
        }
    }

    pub fn navigation_started(&mut self) {
        self.ambiguous |= self.pending.is_some();
        self.advance();
    }

    pub fn lifecycle_cancelled(&mut self) {
        self.ambiguous |= self.pending.is_some();
        self.advance();
    }

    pub fn owner_destroyed(&mut self) {
        self.advance();
        self.destroyed = true;
    }

    pub fn page_load_started<R: Runtime>(
        &mut self,
        webview: &Webview<R>,
        event_url: &Url,
    ) -> Result<NativeLoadTicket, &'static str> {
        let facts = NativeFacts::query(webview);
        self.start(facts, event_url)
    }

    fn start(
        &mut self,
        facts: Result<NativeFacts, &'static str>,
        event_url: &Url,
    ) -> Result<NativeLoadTicket, &'static str> {
        self.ambiguous |= self.pending.is_some();
        self.advance();
        let facts = facts?;
        if self.destroyed || self.ambiguous || !facts.owner() || !local_document(event_url) {
            return Err(SESSION_REFUSED);
        }
        self.pending = Some(self.generation);
        Ok(NativeLoadTicket {
            owner: self.owner.clone(),
            generation: self.generation,
            document: event_url.clone(),
        })
    }

    /// Completion is native-correlated, not "use latest ticket for this URL".
    /// Root must supply an independently fresh native navigation nonce, never IPC bytes.
    pub fn page_load_finished<R: Runtime>(
        &mut self,
        webview: &Webview<R>,
        ticket: NativeLoadTicket,
        event_url: &Url,
        navigation_nonce: Bytes32,
    ) -> Result<(), &'static str> {
        self.finish(
            NativeFacts::query(webview),
            ticket,
            event_url,
            navigation_nonce,
        )
    }

    fn finish(
        &mut self,
        facts: Result<NativeFacts, &'static str>,
        ticket: NativeLoadTicket,
        event_url: &Url,
        navigation_nonce: Bytes32,
    ) -> Result<(), &'static str> {
        if self.destroyed
            || self.ambiguous
            || self.owner != ticket.owner
            || self.pending != Some(ticket.generation)
            || self.generation != ticket.generation
        {
            return Err(SESSION_REFUSED);
        }
        self.pending = None;
        let facts = facts?;
        if !facts.local() || facts.document != ticket.document || event_url != &ticket.document {
            return Err(SESSION_REFUSED);
        }
        self.active = Some(SessionSnapshot {
            owner: self.owner.clone(),
            generation: self.generation,
            digest: session_digest(self.launch_nonce, navigation_nonce),
            document: ticket.document,
        });
        Ok(())
    }

    pub fn snapshot<R: Runtime>(
        &self,
        webview: &Webview<R>,
    ) -> Result<SessionSnapshot, &'static str> {
        self.capture(NativeFacts::query(webview)?)
    }

    fn capture(&self, facts: NativeFacts) -> Result<SessionSnapshot, &'static str> {
        let active = self.active.as_ref().ok_or(SESSION_REFUSED)?;
        if self.destroyed
            || self.ambiguous
            || self.pending.is_some()
            || !facts.local()
            || facts.document != active.document
        {
            return Err(SESSION_REFUSED);
        }
        Ok(active.clone())
    }

    pub fn validate<R: Runtime>(
        &self,
        webview: &Webview<R>,
        snapshot: &SessionSnapshot,
    ) -> Result<(), &'static str> {
        if &self.snapshot(webview)? == snapshot {
            Ok(())
        } else {
            Err(SESSION_REFUSED)
        }
    }
}

/// Deterministic native-fact adapter is absent from production builds.
#[cfg(test)]
pub mod test_adapter {
    use super::*;
    pub struct Facts(pub &'static str, pub &'static str, pub &'static str);
    impl Facts {
        fn facts(&self) -> NativeFacts {
            NativeFacts {
                window: self.0.into(),
                webview: self.1.into(),
                document: self.2.parse().unwrap(),
            }
        }
    }
    pub fn start(
        session: &mut WitnessSession,
        facts: &Facts,
        url: &str,
    ) -> Result<NativeLoadTicket, &'static str> {
        session.start(Ok(facts.facts()), &url.parse().unwrap())
    }
    pub fn finish(
        session: &mut WitnessSession,
        facts: &Facts,
        ticket: NativeLoadTicket,
        url: &str,
        nonce: Bytes32,
    ) -> Result<(), &'static str> {
        session.finish(Ok(facts.facts()), ticket, &url.parse().unwrap(), nonce)
    }
    pub fn capture(
        session: &WitnessSession,
        facts: &Facts,
    ) -> Result<SessionSnapshot, &'static str> {
        session.capture(facts.facts())
    }
}
