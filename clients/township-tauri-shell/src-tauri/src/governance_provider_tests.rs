use crate as township_tauri_shell;
use crate::governance_provider::{LegacySeedBackend, LegacySeedGovernanceProvider};
use crate::{
    GovernanceWitnessCreateError, GovernanceWitnessPresenceError, GovernanceWitnessProviderKind,
    TownshipNativeState,
};
use base64::Engine as _;
use ed25519_dalek::{Signature, SigningKey, Verifier, VerifyingKey};
use std::sync::{Arc, Barrier, Mutex};

fn claim() -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "replica": "replica:matter:succession-witnessed-recovery#root:lc9GuxZMwEl99X0zNhDLAa6jR9n8pBX-2zFS3ghRwWo",
        "role": "clerk",
        "holder": "mCaZpMJ0SU2lf3v2ljw0D05Px4pmoY1jUIIVv19hmZ4=",
        "holderEpoch": "SJMi-K8IUPUvtk3zYRUVMeska-KcUvNT_8oPWTlKDAI",
        "successor": "DBY121cVb1O+BdK+NucwFZyZtUTdrPpxhnZ2Wg41jjY=",
        "policyId": "APOtJzZqq0XmqxkCRK2sl4L--O-nrZ5QhxUOHpZhJ30"
    })
}

#[test]
fn governance_ensure_creates_one_paired_identity_and_reuses_it_after_restart() {
    let store = MemoryGovernanceWitnessStore::default();
    let first = state_with_store(store.clone());

    let public_key = first.ensure_governance_witness_key().unwrap();
    let public_key_bytes = base64::engine::general_purpose::STANDARD
        .decode(&public_key)
        .unwrap();
    assert_eq!(public_key_bytes.len(), 32);
    assert_eq!(first.ensure_governance_witness_key().unwrap(), public_key);
    assert_eq!(first.governance_witness_public_key().unwrap(), public_key);
    assert_eq!(store.write_counts(), (1, 1));
    assert_eq!(store.released_seed_count(), 0);

    let restarted = state_with_store(store.clone());
    assert_eq!(
        restarted.ensure_governance_witness_key().unwrap(),
        public_key
    );
    assert_eq!(store.write_counts(), (1, 1));
    assert_eq!(store.released_seed_count(), 0);
}

#[test]
fn governance_public_key_read_is_presence_free_and_never_creates_custody() {
    let store = MemoryGovernanceWitnessStore::default();
    let state = state_with_store(store.clone());

    assert_eq!(
        state.governance_witness_public_key().unwrap_err(),
        "governance witness identity is missing"
    );
    assert_eq!(store.write_counts(), (0, 0));
    assert_eq!(store.released_seed_count(), 0);
}

#[test]
fn governance_ensure_rejects_incomplete_or_mismatched_identity_pairs() {
    let seed = [7u8; 32];
    let public_key = SigningKey::from_bytes(&seed).verifying_key().to_bytes();

    for (store, expected_error) in [
        (
            MemoryGovernanceWitnessStore::with_items(Some(seed), None),
            "governance witness identity is incomplete: public sidecar is missing",
        ),
        (
            MemoryGovernanceWitnessStore::with_items(None, Some(public_key)),
            "governance witness identity is incomplete: protected-seed identity metadata is missing",
        ),
        (
            MemoryGovernanceWitnessStore::with_items(Some(seed), Some([9u8; 32])),
            "governance witness identity is corrupt: public key mismatch",
        ),
    ] {
        let state = state_with_store(store.clone());
        assert_eq!(
            state.ensure_governance_witness_key().unwrap_err(),
            expected_error
        );
        assert_eq!(store.write_counts(), (0, 0));
        assert_eq!(store.released_seed_count(), 0);
    }
}

#[test]
fn governance_first_creation_is_rollback_safe() {
    let seed_failure =
        MemoryGovernanceWitnessStore::with_failures(Some("seed write failed"), None, None);
    let seed_failure_state = state_with_store(seed_failure.clone());
    assert_eq!(
        seed_failure_state
            .ensure_governance_witness_key()
            .unwrap_err(),
        "seed write failed"
    );
    assert_eq!(seed_failure.items(), (None, None));
    assert_eq!(seed_failure.delete_count(), 0);

    let sidecar_failure = MemoryGovernanceWitnessStore::with_failures(
        None,
        Some("public metadata write failed"),
        None,
    );
    let sidecar_failure_state = state_with_store(sidecar_failure.clone());
    assert_eq!(
        sidecar_failure_state
            .ensure_governance_witness_key()
            .unwrap_err(),
        "governance witness public metadata creation failed: public metadata write failed"
    );
    assert_eq!(sidecar_failure.items(), (None, None));
    assert_eq!(sidecar_failure.delete_count(), 1);

    let rollback_failure = MemoryGovernanceWitnessStore::with_failures(
        None,
        Some("public metadata write failed"),
        Some("seed rollback failed"),
    );
    let rollback_failure_state = state_with_store(rollback_failure.clone());
    assert_eq!(
        rollback_failure_state
            .ensure_governance_witness_key()
            .unwrap_err(),
        "governance witness public metadata creation failed: public metadata write failed; seed rollback failed: seed rollback failed"
    );
    assert!(rollback_failure.items().0.is_some());
    assert_eq!(rollback_failure.items().1, None);
    assert_eq!(rollback_failure.delete_count(), 1);
    assert_eq!(
        rollback_failure_state
            .ensure_governance_witness_key()
            .unwrap_err(),
        "governance witness identity is incomplete: public sidecar is missing"
    );
}

#[test]
fn concurrent_governance_ensure_calls_share_one_creation() {
    let store = MemoryGovernanceWitnessStore::default();
    let state = Arc::new(state_with_store(store.clone()));
    let start = Arc::new(Barrier::new(3));

    let handles: Vec<_> = (0..2)
        .map(|_| {
            let state = Arc::clone(&state);
            let start = Arc::clone(&start);
            std::thread::spawn(move || {
                start.wait();
                state.ensure_governance_witness_key()
            })
        })
        .collect();
    start.wait();

    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert!(results.iter().all(Result::is_ok), "{results:?}");
    assert_eq!(results[0], results[1]);
    assert_eq!(store.write_counts(), (1, 1));
    assert_eq!(store.delete_count(), 0);
    assert_eq!(store.released_seed_count(), 0);
}

#[test]
fn duplicate_seed_creation_reconciles_to_the_cross_state_winner() {
    let store = MemoryGovernanceWitnessStore::with_creation_race(false);
    let first_state = state_with_store(store.clone());
    let second_state = state_with_store(store.clone());
    let start = Arc::new(Barrier::new(3));

    let handles: Vec<_> = [first_state, second_state]
        .into_iter()
        .map(|state| {
            let start = Arc::clone(&start);
            std::thread::spawn(move || {
                start.wait();
                state.ensure_governance_witness_key()
            })
        })
        .collect();
    start.wait();

    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert!(results.iter().all(Result::is_ok), "{results:?}");
    assert_eq!(results[0], results[1]);
    assert_eq!(store.write_counts(), (1, 1));
    assert_eq!(store.delete_count(), 0);
    assert_eq!(store.released_seed_count(), 0);
}

#[test]
fn duplicate_seed_creation_waits_for_the_cross_state_winner_sidecar() {
    let store = MemoryGovernanceWitnessStore::with_creation_race(true);
    let first_state = state_with_store(store.clone());
    let second_state = state_with_store(store.clone());
    let start = Arc::new(Barrier::new(3));

    let handles: Vec<_> = [first_state, second_state]
        .into_iter()
        .map(|state| {
            let start = Arc::clone(&start);
            std::thread::spawn(move || {
                start.wait();
                state.ensure_governance_witness_key()
            })
        })
        .collect();
    start.wait();

    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert!(results.iter().all(Result::is_ok), "{results:?}");
    assert_eq!(results[0], results[1]);
    assert_eq!(store.write_counts(), (1, 1));
    assert_eq!(store.delete_count(), 0);
    assert_eq!(store.released_seed_count(), 0);
    assert!(store.inner.lock().unwrap().incomplete_reads >= 1);
}

#[test]
fn governance_signing_requires_fresh_presence_and_seed_access_each_time() {
    let seed = [7u8; 32];
    let public_key = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
    let store = MemoryGovernanceWitnessStore::with_items(Some(seed), Some(public_key));
    let presence = RecordingPresence::allow();
    let state = state_with_custody(store.clone(), presence.clone());

    let first = state.sign_governance_witness(&claim()).unwrap();
    let second = state.sign_governance_witness(&claim()).unwrap();

    assert_eq!(
        first.witness,
        base64::engine::general_purpose::STANDARD.encode(public_key)
    );
    assert_eq!(
        first.payload_digest,
        "U0tPuFimGHNMZxjUriEzv1Y3h7QE9syyRCkoxy8wP1E"
    );
    assert_eq!(second.witness, first.witness);
    assert_eq!(second.signature, first.signature);
    verify_governance_signature(&first, public_key);
    assert_eq!(store.released_seed_count(), 2);
    assert_eq!(store.write_counts(), (0, 0));
    assert_eq!(
        presence.reasons(),
        vec![
            "Sign Township clerk recovery witness".to_string(),
            "Sign Township clerk recovery witness".to_string(),
        ]
    );
    assert!(state.kv_snapshot().unwrap().is_empty());
}

#[test]
fn governance_presence_reason_cannot_be_shaped_by_submitted_replica() {
    for replica in [
        "replica:".to_string() + &"x".repeat(16_384),
        "replica:ordinary\nApprove another action".to_string(),
        "replica:ordinary\rReplace prompt".to_string(),
        "replica:ordinary\0Hidden suffix".to_string(),
        "replica:\u{03bb}".to_string(),
        "replica:\u{202e}spoof\u{202c}".to_string(),
    ] {
        let seed = [7u8; 32];
        let public_key = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        let store = MemoryGovernanceWitnessStore::with_items(Some(seed), Some(public_key));
        let presence = RecordingPresence::with_outcome(PresenceOutcome::Cancelled);
        let state = state_with_custody(store.clone(), presence.clone());
        let mut submitted = claim();
        submitted["replica"] = serde_json::json!(replica);

        assert_eq!(
            state.sign_governance_witness(&submitted).unwrap_err(),
            "governance witness authentication cancelled"
        );
        assert_eq!(
            presence.reasons(),
            vec!["Sign Township clerk recovery witness".to_string()]
        );
        assert_eq!(store.released_seed_count(), 0);
        assert_eq!(store.write_counts(), (0, 0));
        assert!(state.kv_snapshot().unwrap().is_empty());
    }
}

#[test]
fn governance_signing_refuses_cancel_unavailable_and_malformed_without_writes() {
    let seed = [7u8; 32];
    let public_key = SigningKey::from_bytes(&seed).verifying_key().to_bytes();

    for (outcome, expected_error) in [
        (
            PresenceOutcome::Cancelled,
            "governance witness authentication cancelled",
        ),
        (
            PresenceOutcome::Unavailable,
            "governance witness authentication unavailable",
        ),
        (
            PresenceOutcome::Failed,
            "governance witness authentication failed",
        ),
    ] {
        let store = MemoryGovernanceWitnessStore::with_items(Some(seed), Some(public_key));
        let presence = RecordingPresence::with_outcome(outcome);
        let state = state_with_custody(store.clone(), presence.clone());

        assert_eq!(
            state.sign_governance_witness(&claim()).unwrap_err(),
            expected_error
        );
        assert_eq!(presence.reasons().len(), 1);
        assert_eq!(store.released_seed_count(), 0);
        assert_eq!(store.write_counts(), (0, 0));
        assert!(state.kv_snapshot().unwrap().is_empty());
    }

    let store = MemoryGovernanceWitnessStore::with_items(Some(seed), Some(public_key));
    let presence = RecordingPresence::allow();
    let state = state_with_custody(store.clone(), presence.clone());
    let mut malformed = claim();
    malformed["bytes"] = serde_json::json!("caller-selected");
    assert!(state
        .sign_governance_witness(&malformed)
        .unwrap_err()
        .contains("malformed governance witness claim"));
    assert!(presence.reasons().is_empty());
    assert_eq!(store.released_seed_count(), 0);
    assert_eq!(store.write_counts(), (0, 0));
    assert!(state.kv_snapshot().unwrap().is_empty());
}

#[test]
fn governance_signing_rejects_seed_identity_or_sidecar_mismatch() {
    let seed = [7u8; 32];
    let public_key = SigningKey::from_bytes(&seed).verifying_key().to_bytes();

    for store in [
        MemoryGovernanceWitnessStore::with_identity_items(
            Some(seed),
            Some(public_key),
            Some([9u8; 32]),
        ),
        MemoryGovernanceWitnessStore::with_identity_items(
            Some(seed),
            Some([9u8; 32]),
            Some(public_key),
        ),
        MemoryGovernanceWitnessStore::with_identity_items(
            Some(seed),
            Some([9u8; 32]),
            Some([9u8; 32]),
        ),
    ] {
        let presence = RecordingPresence::allow();
        let state = state_with_custody(store.clone(), presence.clone());

        assert_eq!(
            state.sign_governance_witness(&claim()).unwrap_err(),
            "governance witness identity is corrupt: public key mismatch"
        );
        assert_eq!(presence.reasons().len(), 1);
        assert_eq!(store.released_seed_count(), 1);
        assert_eq!(store.write_counts(), (0, 0));
        assert!(state.kv_snapshot().unwrap().is_empty());
    }
}

#[test]
fn governance_signing_names_missing_public_identity_facets_after_seed_access() {
    let seed = [7u8; 32];
    let public_key = SigningKey::from_bytes(&seed).verifying_key().to_bytes();

    for (store, expected_error) in [
        (
            MemoryGovernanceWitnessStore::with_identity_items(
                Some(seed),
                Some(public_key),
                None,
            ),
            "governance witness identity is incomplete: public sidecar is missing",
        ),
        (
            MemoryGovernanceWitnessStore::with_identity_items(
                Some(seed),
                None,
                Some(public_key),
            ),
            "governance witness identity is incomplete: protected-seed identity metadata is missing",
        ),
        (
            MemoryGovernanceWitnessStore::with_identity_items(Some(seed), None, None),
            "governance witness identity is incomplete: public identity metadata is missing",
        ),
    ] {
        let presence = RecordingPresence::allow();
        let state = state_with_custody(
            store.clone(),
            presence.clone(),
        );

        assert_eq!(
            state.sign_governance_witness(&claim()).unwrap_err(),
            expected_error
        );
        assert_eq!(presence.reasons().len(), 1);
        assert_eq!(store.released_seed_count(), 1);
        assert_eq!(store.write_counts(), (0, 0));
        assert!(state.kv_snapshot().unwrap().is_empty());
    }
}

fn verify_governance_signature(
    result: &township_tauri_shell::GovernanceWitnessSignature,
    public_key: [u8; 32],
) {
    let payload =
        township_tauri_shell::governance_witness::canonical_governance_witness_payload(&claim())
            .unwrap();
    let signature: [u8; 64] = base64::engine::general_purpose::STANDARD
        .decode(&result.signature)
        .unwrap()
        .try_into()
        .unwrap();
    VerifyingKey::from_bytes(&public_key)
        .unwrap()
        .verify(&payload.bytes, &Signature::from_bytes(&signature))
        .unwrap();
}

#[derive(Clone)]
struct RecordingPresence {
    reasons: Arc<Mutex<Vec<String>>>,
    outcome: Arc<Mutex<PresenceOutcome>>,
    on_allow: Option<Arc<dyn Fn() + Send + Sync>>,
}

#[derive(Clone, Copy)]
enum PresenceOutcome {
    Allow,
    Cancelled,
    Unavailable,
    Failed,
}

impl RecordingPresence {
    fn allow() -> Self {
        Self::with_outcome(PresenceOutcome::Allow)
    }

    fn with_outcome(outcome: PresenceOutcome) -> Self {
        Self {
            reasons: Arc::new(Mutex::new(Vec::new())),
            outcome: Arc::new(Mutex::new(outcome)),
            on_allow: None,
        }
    }

    fn reasons(&self) -> Vec<String> {
        self.reasons.lock().unwrap().clone()
    }
}

impl RecordingPresence {
    fn authorize(&self, reason: &str) -> Result<(), GovernanceWitnessPresenceError> {
        self.reasons.lock().unwrap().push(reason.to_string());
        match *self.outcome.lock().unwrap() {
            PresenceOutcome::Allow => {
                if let Some(action) = &self.on_allow {
                    action();
                }
                Ok(())
            }
            PresenceOutcome::Cancelled => Err(GovernanceWitnessPresenceError::Cancelled),
            PresenceOutcome::Unavailable => Err(GovernanceWitnessPresenceError::Unavailable),
            PresenceOutcome::Failed => Err(GovernanceWitnessPresenceError::Failed(
                "platform detail must not escape".to_string(),
            )),
        }
    }
}

#[derive(Clone, Default)]
struct MemoryGovernanceWitnessStore {
    inner: Arc<Mutex<MemoryGovernanceWitnessState>>,
}

#[derive(Clone, Copy)]
enum CreationFault {
    SeedResponseLost,
    CrashBeforeSidecar,
    CrashAfterSidecar,
    SidecarResponseLost,
    DuplicateIncomplete,
    DuplicateDisappeared,
}

#[derive(Default)]
struct MemoryGovernanceWitnessState {
    seed: Option<[u8; 32]>,
    seed_public_key: Option<[u8; 32]>,
    public_key: Option<[u8; 32]>,
    seed_writes: usize,
    public_key_writes: usize,
    seed_releases: usize,
    seed_create_error: Option<&'static str>,
    public_key_create_error: Option<&'static str>,
    delete_error: Option<&'static str>,
    delete_count: usize,
    creation_barrier: Option<Arc<Barrier>>,
    sidecar_observation: Option<Arc<Barrier>>,
    incomplete_reads: usize,
    fault: Option<CreationFault>,
}

impl MemoryGovernanceWitnessStore {
    fn with_items(seed: Option<[u8; 32]>, public_key: Option<[u8; 32]>) -> Self {
        let seed_public_key =
            seed.map(|seed| SigningKey::from_bytes(&seed).verifying_key().to_bytes());
        Self::with_identity_items(seed, seed_public_key, public_key)
    }

    fn with_identity_items(
        seed: Option<[u8; 32]>,
        seed_public_key: Option<[u8; 32]>,
        public_key: Option<[u8; 32]>,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(MemoryGovernanceWitnessState {
                seed,
                seed_public_key,
                public_key,
                ..MemoryGovernanceWitnessState::default()
            })),
        }
    }

    fn with_failures(
        seed_create_error: Option<&'static str>,
        public_key_create_error: Option<&'static str>,
        delete_error: Option<&'static str>,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(MemoryGovernanceWitnessState {
                seed_create_error,
                public_key_create_error,
                delete_error,
                ..MemoryGovernanceWitnessState::default()
            })),
        }
    }

    fn with_creation_race(wait_for_observation: bool) -> Self {
        Self {
            inner: Arc::new(Mutex::new(MemoryGovernanceWitnessState {
                creation_barrier: Some(Arc::new(Barrier::new(2))),
                sidecar_observation: wait_for_observation.then(|| Arc::new(Barrier::new(2))),
                ..MemoryGovernanceWitnessState::default()
            })),
        }
    }

    fn write_counts(&self) -> (usize, usize) {
        let state = self.inner.lock().unwrap();
        (state.seed_writes, state.public_key_writes)
    }

    fn released_seed_count(&self) -> usize {
        self.inner.lock().unwrap().seed_releases
    }

    fn items(&self) -> (Option<[u8; 32]>, Option<[u8; 32]>) {
        let state = self.inner.lock().unwrap();
        (state.seed, state.public_key)
    }

    fn delete_count(&self) -> usize {
        self.inner.lock().unwrap().delete_count
    }
}

impl MemoryGovernanceWitnessStore {
    fn load_seed_public_key(&self) -> Result<Option<[u8; 32]>, String> {
        Ok(self.inner.lock().unwrap().seed_public_key)
    }

    fn load_seed(&self) -> Result<Option<[u8; 32]>, GovernanceWitnessPresenceError> {
        let mut state = self.inner.lock().unwrap();
        if state.seed.is_some() {
            state.seed_releases += 1;
        }
        Ok(state.seed)
    }

    fn load_public_key(&self) -> Result<Option<[u8; 32]>, String> {
        let mut state = self.inner.lock().unwrap();
        let value = state.public_key;
        let observation = if state.seed.is_some() && value.is_none() {
            state.incomplete_reads += 1;
            if state.incomplete_reads == 1 {
                state.sidecar_observation.clone()
            } else {
                None
            }
        } else {
            None
        };
        drop(state);
        if let Some(observation) = observation {
            observation.wait();
        }
        Ok(value)
    }

    fn create_seed(&self, seed: [u8; 32]) -> Result<(), GovernanceWitnessCreateError> {
        let state = self.inner.lock().unwrap();
        if let Some(error) = state.seed_create_error {
            return Err(GovernanceWitnessCreateError::Backend(error.to_string()));
        }
        if state.seed.is_some() {
            return Err(GovernanceWitnessCreateError::Duplicate);
        }
        let barrier = state.creation_barrier.clone();
        drop(state);
        if let Some(barrier) = barrier {
            barrier.wait();
        }
        let mut state = self.inner.lock().unwrap();
        if state.seed.is_some() {
            return Err(GovernanceWitnessCreateError::Duplicate);
        }
        if matches!(state.fault, Some(CreationFault::DuplicateDisappeared)) {
            return Err(GovernanceWitnessCreateError::Duplicate);
        }
        if matches!(state.fault, Some(CreationFault::DuplicateIncomplete)) {
            let winner = [9; 32];
            state.seed = Some(winner);
            state.seed_public_key =
                Some(SigningKey::from_bytes(&winner).verifying_key().to_bytes());
            state.seed_writes += 1;
            return Err(GovernanceWitnessCreateError::Duplicate);
        }
        state.seed = Some(seed);
        state.seed_public_key = Some(SigningKey::from_bytes(&seed).verifying_key().to_bytes());
        state.seed_writes += 1;
        if matches!(state.fault, Some(CreationFault::SeedResponseLost)) {
            return Err(GovernanceWitnessCreateError::Backend(
                "seed response lost".to_string(),
            ));
        }
        Ok(())
    }

    fn create_public_key(&self, public_key: [u8; 32]) -> Result<(), GovernanceWitnessCreateError> {
        let state = self.inner.lock().unwrap();
        if let Some(error) = state.public_key_create_error {
            return Err(GovernanceWitnessCreateError::Backend(error.to_string()));
        }
        if state.public_key.is_some() {
            return Err(GovernanceWitnessCreateError::Duplicate);
        }
        let fault = state.fault;
        let observation = state.sidecar_observation.clone();
        drop(state);
        if matches!(fault, Some(CreationFault::CrashBeforeSidecar)) {
            panic!("simulated process loss before sidecar write");
        }
        if let Some(observation) = observation {
            observation.wait();
        }
        let mut state = self.inner.lock().unwrap();
        if state.public_key.is_some() {
            return Err(GovernanceWitnessCreateError::Duplicate);
        }
        state.public_key = Some(public_key);
        state.public_key_writes += 1;
        drop(state);
        match fault {
            Some(CreationFault::CrashAfterSidecar) => {
                panic!("simulated process loss after sidecar write")
            }
            Some(CreationFault::SidecarResponseLost) => Err(GovernanceWitnessCreateError::Backend(
                "sidecar response lost".to_string(),
            )),
            _ => Ok(()),
        }
    }

    fn delete_seed(&self) -> Result<(), String> {
        let mut state = self.inner.lock().unwrap();
        state.delete_count += 1;
        if let Some(error) = state.delete_error {
            return Err(error.to_string());
        }
        state.seed = None;
        state.seed_public_key = None;
        Ok(())
    }
}

struct TestBackend {
    store: MemoryGovernanceWitnessStore,
    presence: RecordingPresence,
}
impl LegacySeedBackend for TestBackend {
    fn provider_kind(&self) -> GovernanceWitnessProviderKind {
        GovernanceWitnessProviderKind::Injected
    }
    fn load_seed_public_key(&self) -> Result<Option<[u8; 32]>, String> {
        self.store.load_seed_public_key()
    }
    fn load_public_key(&self) -> Result<Option<[u8; 32]>, String> {
        self.store.load_public_key()
    }
    fn authorize_and_load_seed(
        &self,
        reason: &str,
    ) -> Result<Option<[u8; 32]>, GovernanceWitnessPresenceError> {
        self.presence.authorize(reason)?;
        self.store.load_seed()
    }
    fn create_seed(&self, seed: [u8; 32]) -> Result<(), GovernanceWitnessCreateError> {
        self.store.create_seed(seed)
    }
    fn create_public_key(&self, key: [u8; 32]) -> Result<(), GovernanceWitnessCreateError> {
        self.store.create_public_key(key)
    }
    fn delete_seed(&self) -> Result<(), String> {
        self.store.delete_seed()
    }
}
fn state_with_store(store: MemoryGovernanceWitnessStore) -> TownshipNativeState {
    state_with_custody(store, RecordingPresence::allow())
}
fn state_with_custody(
    store: MemoryGovernanceWitnessStore,
    presence: RecordingPresence,
) -> TownshipNativeState {
    TownshipNativeState::with_governance_witness_provider(Arc::new(
        LegacySeedGovernanceProvider::new(TestBackend { store, presence }),
    ))
}

fn store_with_fault(fault: CreationFault) -> MemoryGovernanceWitnessStore {
    let store = MemoryGovernanceWitnessStore::default();
    store.inner.lock().unwrap().fault = Some(fault);
    store
}

#[test]
fn ambiguous_seed_creation_never_claims_cleanup_ownership_or_recreates() {
    let store = store_with_fault(CreationFault::SeedResponseLost);
    assert_eq!(
        state_with_store(store.clone())
            .ensure_governance_witness_key()
            .unwrap_err(),
        "seed response lost"
    );
    let retained = store.items().0.unwrap();
    assert_eq!(store.write_counts(), (1, 0));
    assert_eq!(store.delete_count(), 0);
    assert_eq!(
        state_with_store(store.clone())
            .ensure_governance_witness_key()
            .unwrap_err(),
        "governance witness identity is incomplete: public sidecar is missing"
    );
    assert_eq!(store.items(), (Some(retained), None));
    assert_eq!(store.released_seed_count(), 0);
}

#[test]
fn restart_at_each_creation_write_preserves_the_retained_identity_state() {
    for fault in [
        CreationFault::CrashBeforeSidecar,
        CreationFault::CrashAfterSidecar,
    ] {
        let store = store_with_fault(fault);
        let state = state_with_store(store.clone());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || state.ensure_governance_witness_key()
        ))
        .is_err());
        let retained = store.items().0.unwrap();
        let restarted = state_with_store(store.clone());
        match fault {
            CreationFault::CrashBeforeSidecar => {
                assert_eq!(
                    restarted.ensure_governance_witness_key().unwrap_err(),
                    "governance witness identity is incomplete: public sidecar is missing"
                );
                assert_eq!(store.write_counts(), (1, 0));
            }
            CreationFault::CrashAfterSidecar => {
                let expected = base64::engine::general_purpose::STANDARD
                    .encode(SigningKey::from_bytes(&retained).verifying_key().to_bytes());
                assert_eq!(restarted.ensure_governance_witness_key().unwrap(), expected);
                assert_eq!(restarted.governance_witness_public_key().unwrap(), expected);
                assert_eq!(store.write_counts(), (1, 1));
            }
            _ => unreachable!(),
        }
        assert_eq!(store.items().0, Some(retained));
        assert_eq!(store.delete_count(), 0);
        assert_eq!(store.released_seed_count(), 0);
    }
}

#[test]
fn ambiguous_sidecar_failure_preserves_the_explicit_legacy_incomplete_outcome() {
    let store = store_with_fault(CreationFault::SidecarResponseLost);
    assert_eq!(
        state_with_store(store.clone())
            .ensure_governance_witness_key()
            .unwrap_err(),
        "governance witness public metadata creation failed: sidecar response lost"
    );
    let sidecar = store.items().1.unwrap();
    assert_eq!(store.items().0, None);
    assert_eq!(store.delete_count(), 1);
    assert_eq!(
        state_with_store(store.clone())
            .ensure_governance_witness_key()
            .unwrap_err(),
        "governance witness identity is incomplete: protected-seed identity metadata is missing"
    );
    assert_eq!(store.items(), (None, Some(sidecar)));
    assert_eq!(store.write_counts(), (1, 1));
}

#[test]
fn duplicate_timeout_or_disappearance_never_deletes_the_other_attempt() {
    for (fault, expected) in [
        (
            CreationFault::DuplicateIncomplete,
            "governance witness concurrent identity creation timed out before public sidecar",
        ),
        (
            CreationFault::DuplicateDisappeared,
            "governance witness concurrent identity creation disappeared before completion",
        ),
    ] {
        let store = store_with_fault(fault);
        assert_eq!(
            state_with_store(store.clone())
                .ensure_governance_witness_key()
                .unwrap_err(),
            expected
        );
        assert_eq!(store.delete_count(), 0);
        assert_eq!(store.released_seed_count(), 0);
        assert_eq!(store.write_counts().1, 0);
    }
}

#[test]
fn cancelled_attempt_retries_with_fresh_authentication_and_same_key() {
    let seed = [7; 32];
    let public = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
    let store = MemoryGovernanceWitnessStore::with_items(Some(seed), Some(public));
    let presence = RecordingPresence::with_outcome(PresenceOutcome::Cancelled);
    let state = state_with_custody(store.clone(), presence.clone());
    assert_eq!(
        state.sign_governance_witness(&claim()).unwrap_err(),
        "governance witness authentication cancelled"
    );
    assert_eq!(store.released_seed_count(), 0);
    *presence.outcome.lock().unwrap() = PresenceOutcome::Allow;
    let result = state.sign_governance_witness(&claim()).unwrap();
    verify_governance_signature(&result, public);
    assert_eq!(
        presence.reasons(),
        vec!["Sign Township clerk recovery witness"; 2]
    );
    assert_eq!(store.released_seed_count(), 1);
    assert_eq!(store.write_counts(), (0, 0));
    assert!(state.kv_snapshot().unwrap().is_empty());
}

#[test]
fn missing_protected_key_and_identity_change_during_authentication_release_no_signature() {
    let seed = [7; 32];
    let public = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
    let missing =
        MemoryGovernanceWitnessStore::with_identity_items(None, Some(public), Some(public));
    assert_eq!(
        state_with_custody(missing.clone(), RecordingPresence::allow())
            .sign_governance_witness(&claim())
            .unwrap_err(),
        "governance witness protected seed is missing"
    );
    assert_eq!(missing.released_seed_count(), 0);
    let store = MemoryGovernanceWitnessStore::with_items(Some(seed), Some(public));
    let changed = store.clone();
    let mut presence = RecordingPresence::allow();
    presence.on_allow = Some(Arc::new(move || {
        changed.inner.lock().unwrap().public_key = Some([9; 32]);
    }));
    let state = state_with_custody(store.clone(), presence.clone());
    assert_eq!(
        state.sign_governance_witness(&claim()).unwrap_err(),
        "governance witness identity is corrupt: public key mismatch"
    );
    assert_eq!(presence.reasons().len(), 1);
    assert_eq!(store.released_seed_count(), 1);
    assert_eq!(store.write_counts(), (0, 0));
    assert!(state.kv_snapshot().unwrap().is_empty());
}

#[test]
fn shared_provider_concurrent_claims_keep_their_own_bytes_and_fresh_protected_access() {
    let seed = [7; 32];
    let public = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
    let store = MemoryGovernanceWitnessStore::with_items(Some(seed), Some(public));
    let presence = RecordingPresence::allow();
    let provider = Arc::new(LegacySeedGovernanceProvider::new(TestBackend {
        store: store.clone(),
        presence: presence.clone(),
    }));
    let start = Arc::new(Barrier::new(9));
    let calls: Vec<_> = (0..8)
        .map(|i| {
            let state = TownshipNativeState::with_governance_witness_provider(provider.clone());
            let start = start.clone();
            std::thread::spawn(move || {
                let mut submitted = claim();
                submitted["replica"] = serde_json::json!(format!("replica:parallel:{i}"));
                start.wait();
                (
                    submitted.clone(),
                    state.sign_governance_witness(&submitted).unwrap(),
                )
            })
        })
        .collect();
    start.wait();
    for call in calls {
        let (submitted, result) = call.join().unwrap();
        let payload =
            crate::governance_witness::canonical_governance_witness_payload(&submitted).unwrap();
        let signature = base64::engine::general_purpose::STANDARD
            .decode(result.signature)
            .unwrap();
        VerifyingKey::from_bytes(&public)
            .unwrap()
            .verify(&payload.bytes, &Signature::from_slice(&signature).unwrap())
            .unwrap();
        assert_eq!(
            result.witness,
            base64::engine::general_purpose::STANDARD.encode(public)
        );
    }
    assert_eq!(
        presence.reasons(),
        vec!["Sign Township clerk recovery witness"; 8]
    );
    assert_eq!(store.released_seed_count(), 8);
    assert_eq!(store.write_counts(), (0, 0));
}
