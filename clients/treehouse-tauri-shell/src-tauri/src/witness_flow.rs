//! Native-owned witness command sequencing; no command or event is registered here.

#[cfg(target_os = "android")]
use crate::witness_mobile::NativeWitnessPlugin;
use crate::{
    witness_bridge::{
        Bytes32, CancelRequest, GenerateRequest, IdentityRequest, PrepareRequest, PrivateRequest,
        ProofRequest, SignPreparedRequest, TerminalStatus,
    },
    witness_drain::{NativeCancellation, NativeDrain},
    witness_mobile::{MobilePending, MobileResponse},
    witness_operation::{OperationToken, WitnessOperationRegistry},
    witness_owner::WitnessOwner,
    witness_public::{
        GeneratePublicRequest, PreparePublicRequest, ProofPublicRequest, PublicRequest,
    },
    witness_result,
    witness_reviewed::{self, ReviewedBindingContext, SealedReviewedBinding},
    witness_session::SessionSnapshot,
    witness_snapshot::{Phase, SnapshotResponse},
};
use sha2::{Digest, Sha256};
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::{async_runtime::channel, Runtime, Webview};

pub(crate) const FLOW_REFUSED: &str = "witness_refused";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PendingPhase {
    Review,
    Presence,
}

type Current = Arc<dyn Fn() -> bool + Send + Sync>;
type Dispatch = Arc<dyn Fn(PrivateRequest, Current) -> MobilePending + Send + Sync>;
type PhaseNotice = Arc<dyn Fn(Bytes32, PendingPhase) + Send + Sync>;

pub(crate) struct WitnessFlow {
    owner: Arc<WitnessOwner>,
    operations: Arc<WitnessOperationRegistry>,
    dispatch: Dispatch,
    active: Arc<Mutex<Option<Active>>>,
}

struct Active {
    id: Bytes32,
    pending: Option<NativeCancellation>,
    drains: Vec<NativeDrain>,
    cancel_sent: bool,
}

pub(crate) struct FlowPending {
    receiver: tauri::async_runtime::Receiver<Result<Vec<u8>, &'static str>>,
    cancel: Option<Box<dyn FnOnce() + Send>>,
}

struct CompletionGuard<'a> {
    flow: &'a WitnessFlow,
    token: &'a OperationToken,
}

impl Drop for CompletionGuard<'_> {
    fn drop(&mut self) {
        self.flow.finish(self.token);
    }
}

impl WitnessFlow {
    #[cfg(target_os = "android")]
    pub(crate) fn new<R: Runtime>(
        owner: Arc<WitnessOwner>,
        operations: Arc<WitnessOperationRegistry>,
        plugin: Arc<NativeWitnessPlugin<R>>,
    ) -> Arc<Self> {
        Self::with_dispatch(owner, operations, move |request, current| {
            plugin.dispatch(request, move || current())
        })
    }

    fn with_dispatch(
        owner: Arc<WitnessOwner>,
        operations: Arc<WitnessOperationRegistry>,
        dispatch: impl Fn(PrivateRequest, Current) -> MobilePending + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            owner,
            operations,
            dispatch: Arc::new(dispatch),
            active: Arc::new(Mutex::new(None)),
        })
    }

    pub(crate) fn execute<R: Runtime>(
        self: &Arc<Self>,
        webview: Webview<R>,
        request: PublicRequest,
        notice: PhaseNotice,
    ) -> Result<FlowPending, &'static str> {
        let session = self.owner.snapshot(&webview)?;
        if let PublicRequest::Cancel(cancel) = request {
            return self.cancel_request(webview, cancel.attempt_id, session);
        }
        let token = self.operations.begin(&session)?;
        let id = token.id();
        let Ok(mut active) = self.active.lock() else {
            self.operations.complete(&token);
            return Err(FLOW_REFUSED);
        };
        *active = Some(Active {
            id,
            pending: None,
            drains: Vec::new(),
            cancel_sent: false,
        });
        drop(active);

        let (sender, receiver) = channel(1);
        let flow = self.clone();
        let task_webview = webview.clone();
        let task_session = session.clone();
        tauri::async_runtime::spawn(async move {
            let completion = CompletionGuard {
                flow: &flow,
                token: &token,
            };
            let result = flow
                .run(task_webview, request, notice, &token, &task_session)
                .await;
            drop(completion);
            let _ = sender.send(result).await;
        });

        let cancel_flow = self.clone();
        let cancel_webview = webview;
        Ok(FlowPending {
            receiver,
            cancel: Some(Box::new(move || {
                cancel_flow.cancel_started(cancel_webview, id, session)
            })),
        })
    }

    async fn run<R: Runtime>(
        &self,
        webview: Webview<R>,
        request: PublicRequest,
        notice: PhaseNotice,
        token: &OperationToken,
        session: &SessionSnapshot,
    ) -> Result<Vec<u8>, &'static str> {
        match request {
            PublicRequest::Identity => match self.identity(&webview, token, session).await? {
                Some(snapshot) => witness_result::encode_identity(&snapshot),
                None => witness_result::encode_missing(),
            },
            PublicRequest::Prepare(request) => {
                self.prepare(&webview, token, session, request).await
            }
            PublicRequest::Generate(request) => {
                self.generate(&webview, token, session, request).await
            }
            PublicRequest::Proof(request) => {
                self.proof(&webview, token, session, request, notice).await
            }
            PublicRequest::Cancel(_) => unreachable!("cancel is handled before operation begin"),
        }
    }

    async fn identity<R: Runtime>(
        &self,
        webview: &Webview<R>,
        token: &OperationToken,
        session: &SessionSnapshot,
    ) -> Result<Option<SnapshotResponse>, &'static str> {
        let request = PrivateRequest::Identity(IdentityRequest {
            protocol: (),
            operation_id: token.id(),
            session_digest: session.digest(),
        });
        match self.call(webview, token, session, request).await? {
            MobileResponse::Snapshot(snapshot) => Ok(Some(snapshot)),
            MobileResponse::Terminal(terminal) if terminal.status == TerminalStatus::Missing => {
                Ok(None)
            }
            _ => Err(FLOW_REFUSED),
        }
    }

    async fn prepare<R: Runtime>(
        &self,
        webview: &Webview<R>,
        token: &OperationToken,
        session: &SessionSnapshot,
        public: PreparePublicRequest,
    ) -> Result<Vec<u8>, &'static str> {
        let attempt = match self.identity(webview, token, session).await? {
            Some(snapshot) => snapshot.identity().creation_attempt_id(),
            None => crate::witness_entropy::nonce32()?,
        };
        let request = PrivateRequest::Prepare(PrepareRequest {
            protocol: (),
            operation_id: token.id(),
            session_digest: session.digest(),
            replica: public.replica,
            enrollment_id: public.enrollment_id,
            recipient: public.recipient,
            creation_attempt_id: attempt,
        });
        match self.call(webview, token, session, request).await? {
            MobileResponse::Snapshot(snapshot) => witness_result::encode_prepare(&snapshot),
            _ => Err(FLOW_REFUSED),
        }
    }

    async fn generate<R: Runtime>(
        &self,
        webview: &Webview<R>,
        token: &OperationToken,
        session: &SessionSnapshot,
        public: GeneratePublicRequest,
    ) -> Result<Vec<u8>, &'static str> {
        let snapshot = self
            .identity(webview, token, session)
            .await?
            .ok_or(FLOW_REFUSED)?;
        if snapshot.identity().creation_attempt_id() != public.creation_attempt_id {
            return Err(FLOW_REFUSED);
        }
        let request = PrivateRequest::Generate(GenerateRequest {
            protocol: (),
            operation_id: token.id(),
            session_digest: session.digest(),
            expected_revision: snapshot.identity().revision(),
            creation_attempt_id: public.creation_attempt_id,
            generation_challenge: public.generation_challenge,
        });
        match self.call(webview, token, session, request).await? {
            MobileResponse::Snapshot(snapshot) => witness_result::encode_generate(&snapshot),
            _ => Err(FLOW_REFUSED),
        }
    }

    async fn proof<R: Runtime>(
        &self,
        webview: &Webview<R>,
        token: &OperationToken,
        session: &SessionSnapshot,
        public: ProofPublicRequest,
        notice: PhaseNotice,
    ) -> Result<Vec<u8>, &'static str> {
        let snapshot = self
            .identity(webview, token, session)
            .await?
            .ok_or(FLOW_REFUSED)?;
        if !matches!(snapshot.identity().phase(), Phase::GeneratedUnvalidated) {
            return Err(FLOW_REFUSED);
        }
        let metadata = snapshot.identity().metadata().ok_or(FLOW_REFUSED)?;
        let challenge = snapshot
            .identity()
            .generation_challenge()
            .ok_or(FLOW_REFUSED)?;
        let native_nonce = crate::witness_entropy::nonce32()?;
        emit_notice(&notice, token.id(), PendingPhase::Review)?;
        self.ensure_current(webview, token, session)?;
        let context = ReviewedBindingContext::from_native_review(
            token.id(),
            session.digest(),
            public.replica.clone(),
            public.enrollment_id,
            public.recipient,
            public.fresh_validator_nonce,
            snapshot.identity().creation_attempt_id(),
            metadata.public_key(),
            Bytes32(Sha256::digest(challenge.0).into()),
            native_nonce,
        )?;
        let request = PrivateRequest::Proof(ProofRequest {
            protocol: (),
            operation_id: token.id(),
            session_digest: session.digest(),
            expected_revision: snapshot.identity().revision(),
            replica: public.replica,
            enrollment_id: public.enrollment_id,
            recipient: public.recipient,
            fresh_validator_nonce: public.fresh_validator_nonce,
            native_nonce,
        });
        let started = Instant::now();
        let prepared_bytes = match self.call(webview, token, session, request).await? {
            MobileResponse::Reviewed(bytes) => bytes,
            _ => return Err(FLOW_REFUSED),
        };
        let sealed = witness_reviewed::accept_prepared(context, &prepared_bytes, 0)?;
        let result = self
            .sign(webview, token, session, &snapshot, &sealed, started, notice)
            .await;
        if result.is_err() {
            let _ = witness_reviewed::cancel(&sealed, token.id(), session.digest());
            if let Some(target) = self.operations.cancel(token.id(), session) {
                if let Ok(cancel) = self.start_cancel(webview.clone(), &target) {
                    let _ = Self::finish_cancel(cancel).await;
                }
            }
        }
        result
    }

    async fn sign<R: Runtime>(
        &self,
        webview: &Webview<R>,
        token: &OperationToken,
        session: &SessionSnapshot,
        snapshot: &SnapshotResponse,
        sealed: &SealedReviewedBinding,
        started: Instant,
        notice: PhaseNotice,
    ) -> Result<Vec<u8>, &'static str> {
        emit_notice(&notice, token.id(), PendingPhase::Presence)?;
        self.ensure_current(webview, token, session)?;
        let request = PrivateRequest::SignPrepared(SignPreparedRequest {
            protocol: (),
            operation_id: token.id(),
            session_digest: session.digest(),
            handle: sealed.handle(),
        });
        let signed = match self.call(webview, token, session, request).await? {
            MobileResponse::Reviewed(bytes) => bytes,
            _ => return Err(FLOW_REFUSED),
        };
        self.ensure_current(webview, token, session)?;
        let now = u64::try_from(started.elapsed().as_millis()).map_err(|_| FLOW_REFUSED)?;
        let verified =
            witness_reviewed::accept_signed(sealed, &signed, token.id(), session.digest(), now)?;
        witness_result::encode_proof(&verified, snapshot)
    }

    async fn call<R: Runtime>(
        &self,
        webview: &Webview<R>,
        token: &OperationToken,
        session: &SessionSnapshot,
        request: PrivateRequest,
    ) -> Result<MobileResponse, &'static str> {
        self.ensure_current(webview, token, session)?;
        let owner = self.owner.clone();
        let view = webview.clone();
        let session_for_check = session.clone();
        let current: Current = Arc::new(move || owner.current(&view, &session_for_check));
        let pending = (self.dispatch)(request, current);
        let drain = pending.drain();
        if self
            .set_pending(token.id(), pending.cancellation(), drain.clone())
            .is_err()
        {
            pending.cancellation().cancel();
            let _ = pending.receive().await;
            let _ = drain.wait().await;
            return Err(FLOW_REFUSED);
        }
        let result = pending.receive().await.map_err(|_| FLOW_REFUSED);
        self.clear_pending(token.id());
        self.ensure_current(webview, token, session)?;
        result
    }

    fn ensure_current<R: Runtime>(
        &self,
        webview: &Webview<R>,
        token: &OperationToken,
        session: &SessionSnapshot,
    ) -> Result<(), &'static str> {
        if self.owner.current(webview, session) && self.operations.current(token, session) {
            Ok(())
        } else {
            Err(FLOW_REFUSED)
        }
    }

    fn set_pending(
        &self,
        id: Bytes32,
        cancellation: NativeCancellation,
        drain: NativeDrain,
    ) -> Result<(), &'static str> {
        let mut active = self.active.lock().map_err(|_| FLOW_REFUSED)?;
        let state = active
            .as_mut()
            .filter(|state| state.id == id)
            .ok_or(FLOW_REFUSED)?;
        if state.cancel_sent {
            cancellation.cancel();
        }
        state.pending = Some(cancellation);
        state.drains.push(drain);
        Ok(())
    }
    fn clear_pending(&self, id: Bytes32) {
        if let Ok(mut active) = self.active.lock() {
            if let Some(state) = active.as_mut().filter(|state| state.id == id) {
                state.pending = None;
            }
        }
    }
    fn finish(&self, token: &OperationToken) {
        let drains = self.active.lock().ok().and_then(|mut active| {
            if active.as_ref().is_some_and(|state| state.id == token.id()) {
                active.take().map(|state| state.drains)
            } else {
                None
            }
        });
        let Some(drains) = drains else { return };
        let operations = self.operations.clone();
        let token = token.clone();
        tauri::async_runtime::spawn(async move {
            let mut complete = true;
            for drain in drains {
                complete &= drain.wait().await;
            }
            if complete {
                operations.complete(&token);
            }
        });
    }

    fn cancel_started<R: Runtime>(
        self: Arc<Self>,
        webview: Webview<R>,
        id: Bytes32,
        session: SessionSnapshot,
    ) {
        let target = self.operations.cancel(id, &session);
        let cancel = target.and_then(|target| self.start_cancel(webview, &target).ok());
        let pending = self.active.lock().ok().and_then(|mut active| {
            let state = active
                .as_mut()
                .filter(|state| state.id == id && !state.cancel_sent)?;
            state.cancel_sent = true;
            state.pending.clone()
        });
        if let Some(pending) = pending {
            pending.cancel();
        }
        if let Some(cancel) = cancel {
            tauri::async_runtime::spawn(async move {
                let _ = Self::finish_cancel(cancel).await;
            });
        }
    }

    fn cancel_request<R: Runtime>(
        self: &Arc<Self>,
        webview: Webview<R>,
        id: Bytes32,
        session: SessionSnapshot,
    ) -> Result<FlowPending, &'static str> {
        let target = self.operations.cancel(id, &session).ok_or(FLOW_REFUSED)?;
        let cancel = self.start_cancel(webview, &target)?;
        let pending = self.active.lock().ok().and_then(|mut active| {
            let state = active.as_mut().filter(|state| state.id == id)?;
            state.cancel_sent = true;
            state.pending.clone()
        });
        if let Some(pending) = pending {
            pending.cancel();
        }
        let (sender, receiver) = channel(1);
        tauri::async_runtime::spawn(async move {
            let result = Self::finish_cancel(cancel).await;
            let _ = sender.send(result).await;
        });
        Ok(FlowPending {
            receiver,
            cancel: None,
        })
    }

    pub(crate) fn lifecycle_invalidated<R: Runtime>(self: &Arc<Self>, webview: Webview<R>) {
        let Some(target) = self.operations.lifecycle_invalidated() else {
            return;
        };
        let cancel = self.start_cancel(webview, &target).ok();
        let pending = self.active.lock().ok().and_then(|mut active| {
            let state = active.as_mut().filter(|state| state.id == target.id())?;
            state.cancel_sent = true;
            state.pending.clone()
        });
        if let Some(pending) = pending {
            pending.cancel();
        }
        if let Some(cancel) = cancel {
            tauri::async_runtime::spawn(async move {
                let _ = Self::finish_cancel(cancel).await;
            });
        }
    }

    fn start_cancel<R: Runtime>(
        &self,
        webview: Webview<R>,
        target: &crate::witness_operation::CancellationTarget,
    ) -> Result<MobilePending, &'static str> {
        let cancel_id = crate::witness_entropy::nonce32()?;
        let session = target.session_digest();
        let request = PrivateRequest::Cancel(CancelRequest {
            protocol: (),
            operation_id: cancel_id,
            session_digest: session,
            target_operation_id: target.id(),
        });
        let owner = self.owner.clone();
        let view = webview.clone();
        let current: Current =
            Arc::new(move || owner.snapshot(&view).is_ok_and(|s| s.digest() == session));
        let pending = (self.dispatch)(request, current);
        let drain = pending.drain();
        let mut active = self.active.lock().map_err(|_| FLOW_REFUSED)?;
        let state = active
            .as_mut()
            .filter(|state| state.id == target.id())
            .ok_or(FLOW_REFUSED)?;
        state.drains.push(drain);
        Ok(pending)
    }

    async fn finish_cancel(pending: MobilePending) -> Result<Vec<u8>, &'static str> {
        match pending.receive().await.map_err(|_| FLOW_REFUSED)? {
            MobileResponse::Terminal(terminal) if terminal.status == TerminalStatus::Cancelled => {
                witness_result::encode_cancelled()
            }
            _ => Err(FLOW_REFUSED),
        }
    }
}

fn emit_notice(notice: &PhaseNotice, id: Bytes32, phase: PendingPhase) -> Result<(), &'static str> {
    catch_unwind(AssertUnwindSafe(|| notice(id, phase))).map_err(|_| FLOW_REFUSED)
}

impl FlowPending {
    pub(crate) async fn receive(mut self) -> Result<Vec<u8>, &'static str> {
        let result = self.receiver.recv().await.ok_or(FLOW_REFUSED)?;
        self.cancel = None;
        result
    }
}

impl Drop for FlowPending {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel();
        }
    }
}

#[cfg(test)]
pub(crate) mod test_adapter {
    use super::*;
    pub(crate) fn flow(
        owner: Arc<WitnessOwner>,
        operations: Arc<WitnessOperationRegistry>,
        dispatch: impl Fn(PrivateRequest, Current) -> MobilePending + Send + Sync + 'static,
    ) -> Arc<WitnessFlow> {
        WitnessFlow::with_dispatch(owner, operations, dispatch)
    }
}
