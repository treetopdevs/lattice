use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::de::DeserializeOwned;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tauri::Manager;
use township_tauri_shell::{
    configure_township_builder, GovernanceWitnessProvider, GovernanceWitnessProviderKind,
    GovernanceWitnessSignature, LegacyClerkSigningRequest, TownshipNativeState,
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

// This external opaque mock proves dispatch and result shapes only. Production
// storage/authentication behavior is tested through its private OS backend seam.
struct OpaqueProvider {
    key: Option<SigningKey>,
    sign_calls: AtomicUsize,
    sign_results: AtomicUsize,
    creation_calls: AtomicUsize,
}
impl OpaqueProvider {
    fn new(can_sign: bool) -> Self {
        Self {
            key: can_sign.then(|| SigningKey::from_bytes(&[7; 32])),
            sign_calls: AtomicUsize::new(0),
            sign_results: AtomicUsize::new(0),
            creation_calls: AtomicUsize::new(0),
        }
    }
    fn public(&self) -> [u8; 32] {
        self.key
            .as_ref()
            .map(|k| k.verifying_key().to_bytes())
            .unwrap_or([9; 32])
    }
}
impl GovernanceWitnessProvider for OpaqueProvider {
    fn provider_kind(&self) -> GovernanceWitnessProviderKind {
        if self.key.is_some() {
            GovernanceWitnessProviderKind::Injected
        } else {
            GovernanceWitnessProviderKind::Unavailable
        }
    }
    fn load_public_identity(&self) -> Result<Option<[u8; 32]>, String> {
        Ok(Some(self.public()))
    }
    fn ensure_identity(&self) -> Result<[u8; 32], String> {
        self.creation_calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.public())
    }
    fn sign_legacy_clerk(
        &self,
        request: &LegacyClerkSigningRequest,
    ) -> Result<GovernanceWitnessSignature, String> {
        self.sign_calls.fetch_add(1, Ordering::SeqCst);
        let key = self
            .key
            .as_ref()
            .ok_or_else(|| "governance witness presence is unavailable".to_string())?;
        let result = GovernanceWitnessSignature {
            witness: base64::engine::general_purpose::STANDARD.encode(self.public()),
            signature: base64::engine::general_purpose::STANDARD
                .encode(key.sign(request.canonical_bytes()).to_bytes()),
            payload_digest: base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(request.payload_digest()),
        };
        self.sign_results.fetch_add(1, Ordering::SeqCst);
        Ok(result)
    }
}
#[test]
fn governance_signing_fails_closed_when_presence_provider_is_not_bound() {
    let provider = Arc::new(OpaqueProvider::new(false));
    let state = TownshipNativeState::with_governance_witness_provider(provider.clone());
    assert_eq!(
        state.sign_governance_witness(&claim()).unwrap_err(),
        "governance witness presence is unavailable"
    );
    // Reclassified wiring assertions: no signature or identity-creation call.
    assert_eq!(provider.sign_results.load(Ordering::SeqCst), 0);
    assert_eq!(provider.creation_calls.load(Ordering::SeqCst), 0);
    assert!(state.kv_snapshot().unwrap().is_empty());
    assert_eq!(provider.sign_calls.load(Ordering::SeqCst), 1);
    assert!(!state.governance_witness_custody_is_bound());
}
#[test]
fn opaque_provider_serves_public_identity_and_exact_closed_signing_through_ipc() {
    let provider = Arc::new(OpaqueProvider::new(true));
    let key = provider.public();
    let state = TownshipNativeState::with_governance_witness_provider(provider.clone());
    let app = configure_township_builder(tauri::test::mock_builder(), state)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let public: String = ipc_response(
        &webview,
        "lattice_governance_witness_public_key",
        serde_json::json!({}),
    )
    .unwrap();
    let ensured: String = ipc_response(
        &webview,
        "lattice_ensure_governance_witness_key",
        serde_json::json!({}),
    )
    .unwrap();
    assert_eq!(
        public,
        base64::engine::general_purpose::STANDARD.encode(key)
    );
    assert_eq!(ensured, public);
    let result: GovernanceWitnessSignature = ipc_response(
        &webview,
        "lattice_sign_governance_witness",
        serde_json::json!({"claim":claim()}),
    )
    .unwrap();
    assert_eq!(result.witness, public);
    assert_eq!(
        result.payload_digest,
        "U0tPuFimGHNMZxjUriEzv1Y3h7QE9syyRCkoxy8wP1E"
    );
    let payload =
        township_tauri_shell::governance_witness::canonical_governance_witness_payload(&claim())
            .unwrap();
    let sig = base64::engine::general_purpose::STANDARD
        .decode(result.signature)
        .unwrap();
    VerifyingKey::from_bytes(&key)
        .unwrap()
        .verify(&payload.bytes, &Signature::from_slice(&sig).unwrap())
        .unwrap();
    assert_eq!(provider.sign_calls.load(Ordering::SeqCst), 1);
    assert_eq!(provider.creation_calls.load(Ordering::SeqCst), 1);
}
#[test]
fn malformed_claim_cannot_dispatch_to_the_opaque_provider() {
    let provider = Arc::new(OpaqueProvider::new(true));
    let state = TownshipNativeState::with_governance_witness_provider(provider.clone());
    for field in ["bytes", "keyId", "prompt", "service", "account"] {
        let mut submitted = claim();
        submitted[field] = serde_json::json!("caller-selected");
        assert!(state
            .sign_governance_witness(&submitted)
            .unwrap_err()
            .contains("malformed governance witness claim"));
    }
    let mut other_role = claim();
    other_role["role"] = serde_json::json!("admin");
    assert_eq!(
        state.sign_governance_witness(&other_role).unwrap_err(),
        "unsupported governance witness role"
    );
    assert_eq!(provider.sign_calls.load(Ordering::SeqCst), 0);
    assert_eq!(provider.creation_calls.load(Ordering::SeqCst), 0);
    assert!(state.kv_snapshot().unwrap().is_empty());
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
