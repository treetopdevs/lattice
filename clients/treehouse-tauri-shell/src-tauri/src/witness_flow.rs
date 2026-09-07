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
    sync::{Arc, Condvar, Mutex},
    time::Instant,
};
use tauri::{async_runtime::channel, webview::PageLoadEvent, Runtime, Url, Webview};

pub(crate) const FLOW_REFUSED: &str = "witness_refused";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PendingPhase {
    Review,
    Presence,
}

type Current = Arc<dyn Fn() -> bool + Send + Sync>;
type Dispatch = Arc<dyn Fn(PrivateRequest, Current) -> MobilePending + Send + Sync>;
type PhaseNotice = Arc<dyn Fn(Bytes32, PendingPhase) -> Result<(), &'static str> + Send + Sync>;

pub(crate) struct WitnessFlow {
    owner: Arc<WitnessOwner>,
    operations: Arc<WitnessOperationRegistry>,
    dispatch: Dispatch,
    active: Arc<Mutex<Option<Active>>>,
    completion_ready: Arc<Condvar>,
    cancel_nonce: Mutex<Box<dyn FnMut() -> Result<Bytes32, &'static str> + Send>>,
}

struct Active {
    id: Bytes32,
    token: OperationToken,
    pending: Option<NativeCancellation>,
    drains: Vec<NativeDrain>,
    cancel_sent: bool,
    cancel_starting: bool,
    run_finished: bool,
    cancel_current: Current,
}

pub(crate) struct FlowPending {
    receiver: tauri::async_runtime::Receiver<Result<Vec<u8>, &'static str>>,
    cancel: Option<Box<dyn FnOnce() + Send>>,
}

struct CompletionGuard {
    flow: Arc<WitnessFlow>,
    token: OperationToken,
    armed: bool,
}

impl CompletionGuard {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CompletionGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let flow = self.flow.clone();
        let token = self.token.clone();
        tauri::async_runtime::spawn(async move {
            let _ = flow.finish(token).await;
        });
    }
}

impl WitnessFlow {
    #[cfg(target_os = "android")]
    pub(crate) fn new<R: Runtime>(plugin: Arc<NativeWitnessPlugin<R>>) -> Arc<Self> {
        Self::with_dispatch(
            Arc::new(WitnessOwner::new()),
            Arc::new(WitnessOperationRegistry::new()),
            move |request, current| plugin.dispatch(request, move || current()),
        )
    }

    fn with_dispatch(
        owner: Arc<WitnessOwner>,
        operations: Arc<WitnessOperationRegistry>,
        dispatch: impl Fn(PrivateRequest, Current) -> MobilePending + Send + Sync + 'static,
    ) -> Arc<Self> {
        Self::with_cancel_entropy(owner, operations, dispatch, crate::witness_entropy::nonce32)
    }

    fn with_cancel_entropy(
        owner: Arc<WitnessOwner>,
        operations: Arc<WitnessOperationRegistry>,
        dispatch: impl Fn(PrivateRequest, Current) -> MobilePending + Send + Sync + 'static,
        nonce: impl FnMut() -> Result<Bytes32, &'static str> + Send + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            owner,
            operations,
            dispatch: Arc::new(dispatch),
            active: Arc::new(Mutex::new(None)),
            completion_ready: Arc::new(Condvar::new()),
            cancel_nonce: Mutex::new(Box::new(nonce)),
        })
    }

    pub(crate) fn navigation_requested<R: Runtime>(
        self: &Arc<Self>,
        webview: &Webview<R>,
        url: &Url,
    ) -> bool {
        let allow = self.owner.navigation_requested(webview, url);
        self.cancel_invalidated();
        allow
    }

    pub(crate) fn page_load<R: Runtime>(
        self: &Arc<Self>,
        webview: &Webview<R>,
        event: PageLoadEvent,
        url: &Url,
    ) -> Result<(), &'static str> {
        let result = self.owner.page_load(webview, event, url);
        if result.is_err() {
            self.cancel_invalidated();
        }
        result
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
        let cancel_owner = self.owner.clone();
        let cancel_view = webview.clone();
        let cancel_session = session.digest();
        let cancel_current: Current = Arc::new(move || {
            cancel_owner
                .snapshot(&cancel_view)
                .is_ok_and(|snapshot| snapshot.digest() == cancel_session)
        });
        let Ok(mut active) = self.active.lock() else {
            self.operations.complete(&token);
            return Err(FLOW_REFUSED);
        };
        *active = Some(Active {
            id,
            token: token.clone(),
            pending: None,
            drains: Vec::new(),
            cancel_sent: false,
            cancel_starting: false,
            run_finished: false,
            cancel_current,
        });
        drop(active);

        let (sender, receiver) = channel(1);
        let flow = self.clone();
        let task_webview = webview.clone();
        let task_session = session.clone();
        tauri::async_runtime::spawn(async move {
            let mut completion = CompletionGuard {
                flow: flow.clone(),
                token: token.clone(),
                armed: true,
            };
            let result = flow
                .run(task_webview, request, notice, &token, &task_session)
                .await;
            completion.disarm();
            let completed = flow.finish(token).await;
            let published = if completed { result } else { Err(FLOW_REFUSED) };
            let _ = sender.send(published).await;
        });

        let cancel_flow = self.clone();
        Ok(FlowPending {
            receiver,
            cancel: Some(Box::new(move || cancel_flow.cancel_started(id, session))),
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
        if emit_notice(&notice, token.id(), PendingPhase::Review).is_err() {
            self.cleanup_after_proof(webview, token, session, None)
                .await;
            return Err(FLOW_REFUSED);
        }
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
        let sealed = match self.call(webview, token, session, request).await {
            Ok(MobileResponse::Reviewed(bytes)) => {
                witness_reviewed::accept_prepared(context, &bytes, 0)
            }
            _ => Err(FLOW_REFUSED),
        };
        let sealed = match sealed {
            Ok(sealed) => sealed,
            Err(reason) => {
                self.cleanup_after_proof(webview, token, session, None)
                    .await;
                return Err(reason);
            }
        };
        // remainingMillis is measured by Kotlin at prepared receipt. Only time
        // after that receipt consumes the sealed Rust TTL.
        let started = Instant::now();
        let result = self
            .sign(webview, token, session, &snapshot, &sealed, started, notice)
            .await;
        if result.is_err() {
            self.cleanup_after_proof(webview, token, session, Some(&sealed))
                .await;
        }
        result
    }

    async fn cleanup_after_proof<R: Runtime>(
        &self,
        webview: &Webview<R>,
        token: &OperationToken,
        session: &SessionSnapshot,
        sealed: Option<&SealedReviewedBinding>,
    ) {
        if let Some(sealed) = sealed {
            let _ = witness_reviewed::cancel(sealed, token.id(), session.digest());
        }
        if let Some(target) = self.operations.cancel(token.id(), session) {
            if let Ok(cancel) = self.start_cancel(&target) {
                let _ = Self::finish_cancel(cancel).await;
            }
        }
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
    async fn finish(&self, token: OperationToken) -> bool {
        let active = self.active.clone();
        let ready = self.completion_ready.clone();
        let completion = tauri::async_runtime::spawn_blocking(move || {
            let Ok(mut active) = active.lock() else {
                return None;
            };
            let state = active.as_mut().filter(|state| state.id == token.id())?;
            state.run_finished = true;
            while active.as_ref().is_some_and(|state| state.cancel_starting) {
                let Ok(next) = ready.wait(active) else {
                    return None;
                };
                active = next;
            }
            Self::take_completion(&mut active)
        })
        .await
        .ok()
        .flatten();
        let Some((owned_token, drains)) = completion else {
            return false;
        };
        for drain in drains {
            if !drain.wait().await {
                return false;
            }
        }
        self.operations.complete(&owned_token)
    }

    fn cancel_started(self: Arc<Self>, id: Bytes32, session: SessionSnapshot) {
        let target = self.operations.cancel(id, &session);
        let reserved = target
            .as_ref()
            .and_then(|target| self.reserve_cancel(target).ok());
        let pending = self.active.lock().ok().and_then(|active| {
            active
                .as_ref()
                .filter(|state| state.id == id)?
                .pending
                .clone()
        });
        if let Some(pending) = pending {
            pending.cancel();
        }
        if let (Some(target), Some(current)) = (target, reserved) {
            let flow = self.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(cancel) = flow.dispatch_reserved_cancel_async(target, current).await {
                    let _ = Self::finish_cancel(cancel).await;
                }
            });
        }
    }

    fn cancel_request<R: Runtime>(
        self: &Arc<Self>,
        _webview: Webview<R>,
        id: Bytes32,
        session: SessionSnapshot,
    ) -> Result<FlowPending, &'static str> {
        let target = self.operations.cancel(id, &session).ok_or(FLOW_REFUSED)?;
        let current = self.reserve_cancel(&target)?;
        let pending = self.active.lock().ok().and_then(|active| {
            active
                .as_ref()
                .filter(|state| state.id == id)?
                .pending
                .clone()
        });
        if let Some(pending) = pending {
            pending.cancel();
        }
        let (sender, receiver) = channel(1);
        let flow = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = match flow.dispatch_reserved_cancel_async(target, current).await {
                Ok(cancel) => Self::finish_cancel(cancel).await,
                Err(reason) => Err(reason),
            };
            let _ = sender.send(result).await;
        });
        Ok(FlowPending {
            receiver,
            cancel: None,
        })
    }

    pub(crate) fn lifecycle_invalidated(self: &Arc<Self>) {
        self.owner.lifecycle_cancelled();
        self.cancel_invalidated();
    }

    pub(crate) fn owner_destroyed(self: &Arc<Self>) {
        self.owner.owner_destroyed();
        self.cancel_invalidated();
    }

    fn cancel_invalidated(self: &Arc<Self>) {
        let Some(target) = self.operations.lifecycle_invalidated() else {
            return;
        };
        let reserved = self.reserve_cancel(&target).ok();
        let pending = self.active.lock().ok().and_then(|active| {
            active
                .as_ref()
                .filter(|state| state.id == target.id())?
                .pending
                .clone()
        });
        if let Some(pending) = pending {
            pending.cancel();
        }
        if let Some(current) = reserved {
            let flow = self.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(cancel) = flow.dispatch_reserved_cancel_async(target, current).await {
                    let _ = Self::finish_cancel(cancel).await;
                }
            });
        }
    }

    fn reserve_cancel(
        &self,
        target: &crate::witness_operation::CancellationTarget,
    ) -> Result<Current, &'static str> {
        let mut active = self.active.lock().map_err(|_| FLOW_REFUSED)?;
        let state = active
            .as_mut()
            .filter(|state| state.id == target.id())
            .ok_or(FLOW_REFUSED)?;
        if state.cancel_sent || state.cancel_starting {
            return Err(FLOW_REFUSED);
        }
        state.cancel_sent = true;
        state.cancel_starting = true;
        Ok(state.cancel_current.clone())
    }

    fn start_cancel(
        &self,
        target: &crate::witness_operation::CancellationTarget,
    ) -> Result<MobilePending, &'static str> {
        let current = self.reserve_cancel(target)?;
        self.dispatch_reserved_cancel(target, current)
    }

    fn dispatch_reserved_cancel(
        &self,
        target: &crate::witness_operation::CancellationTarget,
        current: Current,
    ) -> Result<MobilePending, &'static str> {
        let nonce = catch_unwind(AssertUnwindSafe(|| {
            let mut source = self.cancel_nonce.lock().map_err(|_| FLOW_REFUSED)?;
            source.as_mut()()
        }));
        let cancel_id = match nonce {
            Ok(Ok(id)) => id,
            Ok(Err(reason)) => {
                self.rollback_unlaunched_cancel(target.id());
                return Err(reason);
            }
            Err(_) => {
                self.rollback_unlaunched_cancel(target.id());
                return Err(FLOW_REFUSED);
            }
        };
        let session = target.session_digest();
        let request = PrivateRequest::Cancel(CancelRequest {
            protocol: (),
            operation_id: cancel_id,
            session_digest: session,
            target_operation_id: target.id(),
        });
        let pending = match catch_unwind(AssertUnwindSafe(|| (self.dispatch)(request, current))) {
            Ok(pending) => pending,
            Err(_) => {
                self.record_failed_cancel(target.id());
                return Err(FLOW_REFUSED);
            }
        };
        let drain = pending.drain();
        let mut active = self.active.lock().map_err(|_| FLOW_REFUSED)?;
        let state = active
            .as_mut()
            .filter(|state| state.id == target.id())
            .ok_or(FLOW_REFUSED)?;
        state.drains.push(drain);
        state.cancel_starting = false;
        self.completion_ready.notify_all();
        Ok(pending)
    }

    async fn dispatch_reserved_cancel_async(
        self: Arc<Self>,
        target: crate::witness_operation::CancellationTarget,
        current: Current,
    ) -> Result<MobilePending, &'static str> {
        tauri::async_runtime::spawn_blocking(move || {
            self.dispatch_reserved_cancel(&target, current)
        })
        .await
        .map_err(|_| FLOW_REFUSED)?
    }

    fn rollback_unlaunched_cancel(&self, id: Bytes32) {
        if let Ok(mut active) = self.active.lock() {
            if let Some(state) = active.as_mut().filter(|state| state.id == id) {
                state.cancel_sent = false;
                state.cancel_starting = false;
                self.completion_ready.notify_all();
            }
        }
    }

    fn record_failed_cancel(&self, id: Bytes32) {
        if let Ok(mut active) = self.active.lock() {
            if let Some(state) = active.as_mut().filter(|state| state.id == id) {
                state.drains.push(NativeDrain::failed());
                state.cancel_starting = false;
                self.completion_ready.notify_all();
            }
        }
    }

    fn take_completion(active: &mut Option<Active>) -> Option<(OperationToken, Vec<NativeDrain>)> {
        let ready = active
            .as_ref()
            .is_some_and(|state| state.run_finished && !state.cancel_starting);
        if !ready {
            return None;
        }
        let state = active.take()?;
        Some((state.token, state.drains))
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
    catch_unwind(AssertUnwindSafe(|| notice(id, phase)))
        .map_err(|_| FLOW_REFUSED)?
        .map_err(|_| FLOW_REFUSED)
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

    pub(crate) fn flow_with_cancel_entropy(
        owner: Arc<WitnessOwner>,
        operations: Arc<WitnessOperationRegistry>,
        dispatch: impl Fn(PrivateRequest, Current) -> MobilePending + Send + Sync + 'static,
        nonce: impl FnMut() -> Result<Bytes32, &'static str> + Send + 'static,
    ) -> Arc<WitnessFlow> {
        WitnessFlow::with_cancel_entropy(owner, operations, dispatch, nonce)
    }
}
