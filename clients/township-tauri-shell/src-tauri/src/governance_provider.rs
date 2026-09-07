//! Provider-owned legacy clerk custody. Public callers receive no private material.
use crate::governance_witness::{
    canonical_governance_witness_payload, CanonicalGovernanceWitnessPayload,
};
use crate::{
    GovernanceWitnessCreateError, GovernanceWitnessPresenceError, GovernanceWitnessProviderKind,
    GovernanceWitnessSignature,
};
use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD};
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use rand_core::OsRng;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const GOVERNANCE_DUPLICATE_RECONCILIATION_TIMEOUT: Duration = Duration::from_millis(500);
const GOVERNANCE_DUPLICATE_RECONCILIATION_INTERVAL: Duration = Duration::from_millis(10);
const GOVERNANCE_PUBLIC_SIDECAR_MISSING: &str =
    "governance witness identity is incomplete: public sidecar is missing";
const LEGACY_CLERK_REASON: &str = "Sign Township clerk recovery witness";

/// A syntactically validated legacy clerk request, not a native authorization verdict.
/// Its bytes can only originate from the unchanged closed claim parser.
///
/// ```compile_fail,E0616
/// use township_tauri_shell::LegacyClerkSigningRequest;
/// fn mutate(request: &mut LegacyClerkSigningRequest) {
///     request.payload.bytes.clear();
/// }
/// ```
/// ```compile_fail,E0451
/// use township_tauri_shell::{LegacyClerkSigningRequest, governance_witness::CanonicalGovernanceWitnessPayload};
/// let _ = LegacyClerkSigningRequest {
///     payload: CanonicalGovernanceWitnessPayload { bytes: vec![0], sha256: [0; 32] },
/// };
/// ```
pub struct LegacyClerkSigningRequest {
    payload: CanonicalGovernanceWitnessPayload,
}
impl LegacyClerkSigningRequest {
    pub fn from_claim(claim: &serde_json::Value) -> Result<Self, String> {
        Ok(Self {
            payload: canonical_governance_witness_payload(claim)?,
        })
    }
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.payload.bytes
    }
    pub fn payload_digest(&self) -> &[u8; 32] {
        &self.payload.sha256
    }
}

/// Trusted native provider injection. It is not a webview-selectable provider.
/// Public keys, validated requests and signatures are the entire public boundary.
///
/// ```
/// use township_tauri_shell::GovernanceWitnessProvider;
/// fn public_identity(provider: &dyn GovernanceWitnessProvider) -> Result<Option<[u8; 32]>, String> {
///     provider.load_public_identity()
/// }
/// ```
/// A governance caller must not be able to create or obtain private key material.
/// This exact example compiled before removal of the old public seed trait.
/// ```compile_fail,E0432
/// use township_tauri_shell::GovernanceWitnessKeyStore;
///
/// fn private_material_crosses_the_caller_boundary(store: &dyn GovernanceWitnessKeyStore) {
///     let _ = store.create_seed([7; 32]);
///     let _ = store.load_seed();
/// }
/// ```
/// The retained legacy backend is also inaccessible to external callers.
/// ```compile_fail,E0603
/// use township_tauri_shell::governance_provider::LegacySeedBackend;
/// ```
pub trait GovernanceWitnessProvider: Send + Sync {
    fn provider_kind(&self) -> GovernanceWitnessProviderKind;
    fn load_public_identity(&self) -> Result<Option<[u8; 32]>, String>;
    fn ensure_identity(&self) -> Result<[u8; 32], String>;
    fn sign_legacy_clerk(
        &self,
        request: &LegacyClerkSigningRequest,
    ) -> Result<GovernanceWitnessSignature, String>;
}

// Legacy macOS-only custody mechanics. Android must not implement this backend.
pub(crate) trait LegacySeedBackend: Send + Sync {
    fn provider_kind(&self) -> GovernanceWitnessProviderKind;
    fn load_seed_public_key(&self) -> Result<Option<[u8; 32]>, String>;
    fn authorize_and_load_seed(
        &self,
        reason: &str,
    ) -> Result<Option<[u8; 32]>, GovernanceWitnessPresenceError>;
    fn load_public_key(&self) -> Result<Option<[u8; 32]>, String>;
    fn create_seed(&self, seed: [u8; 32]) -> Result<(), GovernanceWitnessCreateError>;
    fn create_public_key(&self, public_key: [u8; 32]) -> Result<(), GovernanceWitnessCreateError>;
    fn delete_seed(&self) -> Result<(), String>;
}

pub(crate) struct LegacySeedGovernanceProvider<B> {
    backend: B,
    creation: Mutex<()>,
    signing: Mutex<()>,
}
impl<B: LegacySeedBackend> LegacySeedGovernanceProvider<B> {
    pub(crate) fn new(backend: B) -> Self {
        Self {
            backend,
            creation: Mutex::new(()),
            signing: Mutex::new(()),
        }
    }
}
impl<B: LegacySeedBackend> GovernanceWitnessProvider for LegacySeedGovernanceProvider<B> {
    fn provider_kind(&self) -> GovernanceWitnessProviderKind {
        self.backend.provider_kind()
    }
    fn load_public_identity(&self) -> Result<Option<[u8; 32]>, String> {
        existing_governance_public_key(&self.backend)
    }
    fn ensure_identity(&self) -> Result<[u8; 32], String> {
        let _creation = self
            .creation
            .lock()
            .map_err(|_| "governance witness creation lock poisoned".to_string())?;
        if let Some(public_key) = existing_governance_public_key(&self.backend)? {
            return Ok(public_key);
        }
        let signing_key = SigningKey::generate(&mut OsRng);
        let public_key = signing_key.verifying_key().to_bytes();
        match self.backend.create_seed(signing_key.to_bytes()) {
            Ok(()) => {}
            Err(GovernanceWitnessCreateError::Duplicate) => {
                return reconcile_duplicate_governance_identity(&self.backend);
            }
            Err(error) => return Err(governance_create_error(error)),
        }
        if let Err(error) = self.backend.create_public_key(public_key) {
            let create_error = governance_create_error(error);
            self.backend.delete_seed().map_err(|rollback_error| {
                format!("governance witness public metadata creation failed: {create_error}; seed rollback failed: {rollback_error}")
            })?;
            return Err(format!(
                "governance witness public metadata creation failed: {create_error}"
            ));
        }
        Ok(public_key)
    }
    fn sign_legacy_clerk(
        &self,
        request: &LegacyClerkSigningRequest,
    ) -> Result<GovernanceWitnessSignature, String> {
        let _signing = self
            .signing
            .lock()
            .map_err(|_| "governance witness signing lock poisoned".to_string())?;
        let seed = self
            .backend
            .authorize_and_load_seed(LEGACY_CLERK_REASON)
            .map_err(governance_presence_error)?
            .ok_or_else(|| "governance witness protected seed is missing".to_string())?;
        let signing_key = SigningKey::from_bytes(&seed);
        let public_key = signing_key.verifying_key().to_bytes();
        let stored_public_key = match governance_public_identity(&self.backend)? {
            GovernancePublicIdentity::Complete(public_key) => public_key,
            GovernancePublicIdentity::Missing => return Err(
                "governance witness identity is incomplete: public identity metadata is missing"
                    .to_string(),
            ),
        };
        if stored_public_key != public_key {
            return Err("governance witness identity is corrupt: public key mismatch".to_string());
        }
        Ok(GovernanceWitnessSignature {
            witness: BASE64.encode(public_key),
            signature: BASE64.encode(signing_key.sign(request.canonical_bytes()).to_bytes()),
            payload_digest: URL_SAFE_NO_PAD.encode(request.payload_digest()),
        })
    }
}

fn governance_presence_error(error: GovernanceWitnessPresenceError) -> String {
    match error {
        GovernanceWitnessPresenceError::Cancelled => {
            "governance witness authentication cancelled".to_string()
        }
        GovernanceWitnessPresenceError::Unavailable => {
            "governance witness authentication unavailable".to_string()
        }
        GovernanceWitnessPresenceError::Failed(_) => {
            "governance witness authentication failed".to_string()
        }
    }
}

fn existing_governance_public_key(
    store: &dyn LegacySeedBackend,
) -> Result<Option<[u8; 32]>, String> {
    match governance_public_identity(store)? {
        GovernancePublicIdentity::Complete(public_key) => Ok(Some(public_key)),
        GovernancePublicIdentity::Missing => Ok(None),
    }
}

fn reconcile_duplicate_governance_identity(
    store: &dyn LegacySeedBackend,
) -> Result<[u8; 32], String> {
    let deadline = Instant::now() + GOVERNANCE_DUPLICATE_RECONCILIATION_TIMEOUT;
    loop {
        match existing_governance_public_key(store) {
            Ok(Some(public_key)) => return Ok(public_key),
            Ok(None) => {
                return Err(
                    "governance witness concurrent identity creation disappeared before completion"
                        .to_string(),
                );
            }
            Err(error) if error == GOVERNANCE_PUBLIC_SIDECAR_MISSING => {
                if Instant::now() >= deadline {
                    return Err(
                        "governance witness concurrent identity creation timed out before public sidecar"
                            .to_string(),
                    );
                }
                std::thread::sleep(GOVERNANCE_DUPLICATE_RECONCILIATION_INTERVAL);
            }
            Err(error) => return Err(error),
        }
    }
}

enum GovernancePublicIdentity {
    Missing,
    Complete([u8; 32]),
}

fn governance_public_identity(
    store: &dyn LegacySeedBackend,
) -> Result<GovernancePublicIdentity, String> {
    match (store.load_seed_public_key()?, store.load_public_key()?) {
        (Some(seed_public_key), Some(public_key)) if seed_public_key == public_key => {
            Ok(GovernancePublicIdentity::Complete(public_key))
        }
        (Some(_), Some(_)) => {
            Err("governance witness identity is corrupt: public key mismatch".to_string())
        }
        (Some(_), None) => Err(GOVERNANCE_PUBLIC_SIDECAR_MISSING.to_string()),
        (None, Some(_)) => Err(
            "governance witness identity is incomplete: protected-seed identity metadata is missing"
                .to_string(),
        ),
        (None, None) => Ok(GovernancePublicIdentity::Missing),
    }
}

fn governance_create_error(error: GovernanceWitnessCreateError) -> String {
    match error {
        GovernanceWitnessCreateError::Duplicate => {
            "governance witness identity already exists".to_string()
        }
        GovernanceWitnessCreateError::Backend(error) => error,
    }
}
