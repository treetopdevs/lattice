use base64::Engine as _;
use ed25519_dalek::{Signature, SigningKey, Verifier, VerifyingKey};
use serde::de::DeserializeOwned;
use std::sync::{Arc, Barrier, Mutex};
use tauri::Manager;
use township_tauri_shell::{
    configure_township_builder, GovernanceWitnessCreateError, GovernanceWitnessKeyStore,
    GovernanceWitnessPresence, GovernanceWitnessPresenceError, TownshipNativeState,
};

const CUSTODY_UNAVAILABLE: &str = "governance witness custody is unavailable";
const GOVERNANCE_ALIAS: &str = "governance-witness-v1";
const CARRIER_CUSTODY_REFUSAL: &str =
    "governance witness key is unavailable through carrier custody";

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
fn governance_commands_are_separate_and_fail_closed_without_a_provider() {
    let state = TownshipNativeState::default();
    assert_eq!(
        state.ensure_carrier_key(GOVERNANCE_ALIAS).unwrap_err(),
        CARRIER_CUSTODY_REFUSAL
    );
    assert_eq!(
        state
            .insert_seeded_dev_key(GOVERNANCE_ALIAS, "must-not-load")
            .unwrap_err(),
        CARRIER_CUSTODY_REFUSAL
    );
    assert_eq!(
        state.public_key(GOVERNANCE_ALIAS).unwrap_err(),
        CARRIER_CUSTODY_REFUSAL
    );
    assert_eq!(
        state.sign_carrier(GOVERNANCE_ALIAS, "").unwrap_err(),
        CARRIER_CUSTODY_REFUSAL
    );
    let app = configure_township_builder(tauri::test::mock_builder(), state)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let ensure: Result<String, serde_json::Value> = ipc_response(
        &webview,
        "lattice_ensure_governance_witness_key",
        serde_json::json!({}),
    );
    assert_eq!(ensure.unwrap_err(), serde_json::json!(CUSTODY_UNAVAILABLE));

    let public_key: Result<String, serde_json::Value> = ipc_response(
        &webview,
        "lattice_governance_witness_public_key",
        serde_json::json!({}),
    );
    assert_eq!(
        public_key.unwrap_err(),
        serde_json::json!(CUSTODY_UNAVAILABLE)
    );

    let sign: Result<serde_json::Value, serde_json::Value> = ipc_response(
        &webview,
        "lattice_sign_governance_witness",
        serde_json::json!({ "claim": claim() }),
    );
    assert_eq!(sign.unwrap_err(), serde_json::json!(CUSTODY_UNAVAILABLE));
    assert!(app
        .state::<TownshipNativeState>()
        .kv_snapshot()
        .unwrap()
        .is_empty());
}

#[test]
fn governance_ensure_creates_one_paired_identity_and_reuses_it_after_restart() {
    let store = MemoryGovernanceWitnessStore::default();
    let first = TownshipNativeState::with_governance_witness_key_store(store.clone());

    let public_key = first.ensure_governance_witness_key().unwrap();
    let public_key_bytes = base64::engine::general_purpose::STANDARD
        .decode(&public_key)
        .unwrap();
    assert_eq!(public_key_bytes.len(), 32);
    assert_eq!(first.ensure_governance_witness_key().unwrap(), public_key);
    assert_eq!(first.governance_witness_public_key().unwrap(), public_key);
    assert_eq!(store.write_counts(), (1, 1));
    assert_eq!(store.secret_read_count(), 0);

    let restarted = TownshipNativeState::with_governance_witness_key_store(store.clone());
    assert_eq!(
        restarted.ensure_governance_witness_key().unwrap(),
        public_key
    );
    assert_eq!(store.write_counts(), (1, 1));
    assert_eq!(store.secret_read_count(), 0);
}

#[test]
fn governance_public_key_read_is_presence_free_and_never_creates_custody() {
    let store = MemoryGovernanceWitnessStore::default();
    let state = TownshipNativeState::with_governance_witness_key_store(store.clone());

    assert_eq!(
        state.governance_witness_public_key().unwrap_err(),
        "governance witness identity is missing"
    );
    assert_eq!(store.write_counts(), (0, 0));
    assert_eq!(store.secret_read_count(), 0);
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
        let state = TownshipNativeState::with_governance_witness_key_store(store.clone());
        assert_eq!(
            state.ensure_governance_witness_key().unwrap_err(),
            expected_error
        );
        assert_eq!(store.write_counts(), (0, 0));
        assert_eq!(store.secret_read_count(), 0);
    }
}

#[test]
fn governance_first_creation_is_rollback_safe() {
    let seed_failure =
        MemoryGovernanceWitnessStore::with_failures(Some("seed write failed"), None, None);
    let seed_failure_state =
        TownshipNativeState::with_governance_witness_key_store(seed_failure.clone());
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
    let sidecar_failure_state =
        TownshipNativeState::with_governance_witness_key_store(sidecar_failure.clone());
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
    let rollback_failure_state =
        TownshipNativeState::with_governance_witness_key_store(rollback_failure.clone());
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
    let store = MemoryGovernanceWitnessStore::with_create_delay(50);
    let state = Arc::new(TownshipNativeState::with_governance_witness_key_store(
        store.clone(),
    ));
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
    assert_eq!(store.secret_read_count(), 0);
}

#[test]
fn duplicate_seed_creation_reconciles_to_the_cross_state_winner() {
    let store = MemoryGovernanceWitnessStore::with_create_delays(50, 50, 0);
    let first_state = TownshipNativeState::with_governance_witness_key_store(store.clone());
    let second_state = TownshipNativeState::with_governance_witness_key_store(store.clone());
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
    assert_eq!(store.secret_read_count(), 0);
}

#[test]
fn duplicate_seed_creation_waits_for_the_cross_state_winner_sidecar() {
    let store = MemoryGovernanceWitnessStore::with_create_delays(25, 0, 75);
    let first_state = TownshipNativeState::with_governance_witness_key_store(store.clone());
    let second_state = TownshipNativeState::with_governance_witness_key_store(store.clone());
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
    assert_eq!(store.secret_read_count(), 0);
}

#[test]
fn governance_signing_requires_fresh_presence_and_seed_access_each_time() {
    let seed = [7u8; 32];
    let public_key = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
    let store = MemoryGovernanceWitnessStore::with_items(Some(seed), Some(public_key));
    let presence = RecordingPresence::allow();
    let state =
        TownshipNativeState::with_governance_witness_custody(store.clone(), presence.clone());

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
    assert_eq!(store.secret_read_count(), 2);
    assert_eq!(store.write_counts(), (0, 0));
    assert_eq!(
        presence.reasons(),
        vec![
            "Sign clerk recovery witness for replica:matter:succession-witnessed-recovery#root:lc9GuxZMwEl99X0zNhDLAa6jR9n8pBX-2zFS3ghRwWo".to_string(),
            "Sign clerk recovery witness for replica:matter:succession-witnessed-recovery#root:lc9GuxZMwEl99X0zNhDLAa6jR9n8pBX-2zFS3ghRwWo".to_string(),
        ]
    );
    assert!(state.kv_snapshot().unwrap().is_empty());
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
        let state =
            TownshipNativeState::with_governance_witness_custody(store.clone(), presence.clone());

        assert_eq!(
            state.sign_governance_witness(&claim()).unwrap_err(),
            expected_error
        );
        assert_eq!(presence.reasons().len(), 1);
        assert_eq!(store.secret_read_count(), 0);
        assert_eq!(store.write_counts(), (0, 0));
        assert!(state.kv_snapshot().unwrap().is_empty());
    }

    let store = MemoryGovernanceWitnessStore::with_items(Some(seed), Some(public_key));
    let presence = RecordingPresence::allow();
    let state =
        TownshipNativeState::with_governance_witness_custody(store.clone(), presence.clone());
    let mut malformed = claim();
    malformed["bytes"] = serde_json::json!("caller-selected");
    assert!(state
        .sign_governance_witness(&malformed)
        .unwrap_err()
        .contains("malformed governance witness claim"));
    assert!(presence.reasons().is_empty());
    assert_eq!(store.secret_read_count(), 0);
    assert_eq!(store.write_counts(), (0, 0));
    assert!(state.kv_snapshot().unwrap().is_empty());
}

#[test]
fn governance_signing_fails_closed_when_presence_provider_is_not_bound() {
    let seed = [7u8; 32];
    let public_key = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
    let store = MemoryGovernanceWitnessStore::with_items(Some(seed), Some(public_key));
    let state = TownshipNativeState::with_governance_witness_key_store(store.clone());

    assert_eq!(
        state.sign_governance_witness(&claim()).unwrap_err(),
        "governance witness presence is unavailable"
    );
    assert_eq!(store.secret_read_count(), 0);
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
        let state =
            TownshipNativeState::with_governance_witness_custody(store.clone(), presence.clone());

        assert_eq!(
            state.sign_governance_witness(&claim()).unwrap_err(),
            "governance witness identity is corrupt: public key mismatch"
        );
        assert_eq!(presence.reasons().len(), 1);
        assert_eq!(store.secret_read_count(), 1);
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
        let state = TownshipNativeState::with_governance_witness_custody(
            store.clone(),
            presence.clone(),
        );

        assert_eq!(
            state.sign_governance_witness(&claim()).unwrap_err(),
            expected_error
        );
        assert_eq!(presence.reasons().len(), 1);
        assert_eq!(store.secret_read_count(), 1);
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
    outcome: PresenceOutcome,
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
            outcome,
        }
    }

    fn reasons(&self) -> Vec<String> {
        self.reasons.lock().unwrap().clone()
    }
}

impl GovernanceWitnessPresence for RecordingPresence {
    fn authorize(&self, reason: &str) -> Result<(), GovernanceWitnessPresenceError> {
        self.reasons.lock().unwrap().push(reason.to_string());
        match self.outcome {
            PresenceOutcome::Allow => Ok(()),
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

#[derive(Default)]
struct MemoryGovernanceWitnessState {
    seed: Option<[u8; 32]>,
    seed_public_key: Option<[u8; 32]>,
    public_key: Option<[u8; 32]>,
    seed_writes: usize,
    public_key_writes: usize,
    seed_reads: usize,
    seed_create_error: Option<&'static str>,
    public_key_create_error: Option<&'static str>,
    delete_error: Option<&'static str>,
    delete_count: usize,
    create_delay_ms: u64,
    duplicate_delay_ms: u64,
    public_key_create_delay_ms: u64,
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

    fn with_create_delay(create_delay_ms: u64) -> Self {
        Self::with_create_delays(create_delay_ms, 0, 0)
    }

    fn with_create_delays(
        create_delay_ms: u64,
        duplicate_delay_ms: u64,
        public_key_create_delay_ms: u64,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(MemoryGovernanceWitnessState {
                create_delay_ms,
                duplicate_delay_ms,
                public_key_create_delay_ms,
                ..MemoryGovernanceWitnessState::default()
            })),
        }
    }

    fn write_counts(&self) -> (usize, usize) {
        let state = self.inner.lock().unwrap();
        (state.seed_writes, state.public_key_writes)
    }

    fn secret_read_count(&self) -> usize {
        self.inner.lock().unwrap().seed_reads
    }

    fn items(&self) -> (Option<[u8; 32]>, Option<[u8; 32]>) {
        let state = self.inner.lock().unwrap();
        (state.seed, state.public_key)
    }

    fn delete_count(&self) -> usize {
        self.inner.lock().unwrap().delete_count
    }
}

impl GovernanceWitnessKeyStore for MemoryGovernanceWitnessStore {
    fn load_seed_public_key(&self) -> Result<Option<[u8; 32]>, String> {
        Ok(self.inner.lock().unwrap().seed_public_key)
    }

    fn load_seed(&self) -> Result<Option<[u8; 32]>, GovernanceWitnessPresenceError> {
        let mut state = self.inner.lock().unwrap();
        state.seed_reads += 1;
        Ok(state.seed)
    }

    fn load_public_key(&self) -> Result<Option<[u8; 32]>, String> {
        Ok(self.inner.lock().unwrap().public_key)
    }

    fn create_seed(&self, seed: [u8; 32]) -> Result<(), GovernanceWitnessCreateError> {
        let state = self.inner.lock().unwrap();
        if let Some(error) = state.seed_create_error {
            return Err(GovernanceWitnessCreateError::Backend(error.to_string()));
        }
        if state.seed.is_some() {
            return Err(GovernanceWitnessCreateError::Duplicate);
        }
        let create_delay_ms = state.create_delay_ms;
        drop(state);
        if create_delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(create_delay_ms));
        }
        let mut state = self.inner.lock().unwrap();
        if state.seed.is_some() {
            let duplicate_delay_ms = state.duplicate_delay_ms;
            drop(state);
            if duplicate_delay_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(duplicate_delay_ms));
            }
            return Err(GovernanceWitnessCreateError::Duplicate);
        }
        state.seed = Some(seed);
        state.seed_public_key = Some(SigningKey::from_bytes(&seed).verifying_key().to_bytes());
        state.seed_writes += 1;
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
        let public_key_create_delay_ms = state.public_key_create_delay_ms;
        drop(state);
        if public_key_create_delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(public_key_create_delay_ms));
        }
        let mut state = self.inner.lock().unwrap();
        if state.public_key.is_some() {
            return Err(GovernanceWitnessCreateError::Duplicate);
        }
        state.public_key = Some(public_key);
        state.public_key_writes += 1;
        Ok(())
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

fn ipc_response<T>(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> Result<T, serde_json::Value>
where
    T: DeserializeOwned,
{
    tauri::test::get_ipc_response(
        webview,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: body.into(),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize().unwrap())
}
