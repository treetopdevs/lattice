//! Conservative URL-only Tauri page-load adapter.
//!
//! Tauri exposes no document identifier with `Finished`. One fresh native owner
//! may therefore establish only its first observed `Started`/matching `Finished`
//! pair. Any ambiguity permanently closes this adapter; replacement requires a
//! newly constructed native owner and launch-owned nonce source.

use crate::witness_bridge::Bytes32;
use crate::witness_session::{SessionSnapshot, WitnessSession, SESSION_REFUSED};
use tauri::{webview::PageLoadEvent, Runtime, Url, Webview};

pub(crate) struct WitnessDocumentSession<N> {
    session: WitnessSession,
    phase: Phase,
    navigation_nonce: N,
}

enum Phase {
    AwaitingFirstStart,
    AwaitingFirstFinish {
        ticket: crate::witness_session::NativeLoadTicket,
        document: Url,
    },
    Established,
    Refused,
}

impl<N: FnMut() -> Bytes32> WitnessDocumentSession<N> {
    pub(crate) fn new(launch_nonce: Bytes32, navigation_nonce: N) -> Self {
        Self {
            session: WitnessSession::new(launch_nonce),
            phase: Phase::AwaitingFirstStart,
            navigation_nonce,
        }
    }

    pub(crate) fn page_load<R: Runtime>(
        &mut self,
        webview: &Webview<R>,
        event: PageLoadEvent,
        event_url: &Url,
    ) -> Result<(), &'static str> {
        let phase = std::mem::replace(&mut self.phase, Phase::Refused);
        match (phase, event) {
            (Phase::AwaitingFirstStart, PageLoadEvent::Started) => {
                if webview.url().map_err(|_| SESSION_REFUSED)? != *event_url {
                    return Err(SESSION_REFUSED);
                }
                match self.session.page_load_started(webview, event_url) {
                    Ok(ticket) => {
                        self.phase = Phase::AwaitingFirstFinish {
                            ticket,
                            document: event_url.clone(),
                        };
                        Ok(())
                    }
                    Err(_) => Err(SESSION_REFUSED),
                }
            }
            (Phase::AwaitingFirstFinish { ticket, document }, PageLoadEvent::Finished)
                if &document == event_url =>
            {
                let nonce = (self.navigation_nonce)();
                match self
                    .session
                    .page_load_finished(webview, ticket, event_url, nonce)
                {
                    Ok(()) => {
                        self.phase = Phase::Established;
                        Ok(())
                    }
                    Err(_) => Err(SESSION_REFUSED),
                }
            }
            (Phase::AwaitingFirstFinish { .. }, PageLoadEvent::Started) => {
                self.session.navigation_started();
                Err(SESSION_REFUSED)
            }
            (Phase::Established, PageLoadEvent::Started) => {
                self.session.navigation_started();
                Err(SESSION_REFUSED)
            }
            _ => Err(SESSION_REFUSED),
        }
    }

    pub(crate) fn snapshot<R: Runtime>(
        &self,
        webview: &Webview<R>,
    ) -> Result<SessionSnapshot, &'static str> {
        if !matches!(self.phase, Phase::Established) {
            return Err(SESSION_REFUSED);
        }
        self.session.snapshot(webview)
    }

    pub(crate) fn lifecycle_cancelled(&mut self) {
        self.session.lifecycle_cancelled();
        self.phase = Phase::Refused;
    }

    pub(crate) fn owner_destroyed(&mut self) {
        self.session.owner_destroyed();
        self.phase = Phase::Refused;
    }
}
