use std::collections::{HashMap, HashSet};
#[cfg(target_os = "android")]
use std::ffi::CString;
use std::fs;
use std::io::{ErrorKind, Write};
use std::net::{IpAddr, SocketAddr, UdpSocket};
#[cfg(target_os = "android")]
use std::os::raw::{c_char, c_int};
#[cfg(any(
    all(test, unix),
    all(target_os = "ios", feature = "township-ios-key-reuse-native-probe")
))]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "android", target_os = "ios"))]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD};
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use tauri::Manager;

#[cfg(all(target_os = "ios", feature = "township-ios-key-reuse-native-probe"))]
use objc2_foundation::NSHomeDirectory;

pub mod governance_witness;
#[cfg(all(
    target_os = "macos",
    not(feature = "township-governance-test-presence")
))]
mod macos_governance;
#[cfg(feature = "township-governance-test-presence")]
mod test_governance;

#[cfg(all(
    feature = "township-governance-test-presence",
    not(feature = "township-dev-trace")
))]
compile_error!("township-governance-test-presence requires the township-dev-trace feature");

pub const TOWNSHIP_KEYRING_SERVICE: &str = "dev.treetop.lattice.township.carrier";
pub const TOWNSHIP_GOVERNANCE_KEYRING_SERVICE: &str =
    "dev.treetop.lattice.township.governance-witness";
#[cfg(feature = "township-governance-test-presence")]
pub const TOWNSHIP_GOVERNANCE_TEST_PRESENCE_TRACE: &str = "governance-test-presence:authorized";
pub const TOWNSHIP_GOVERNANCE_KEY_ALIAS: &str = "governance-witness-v1";
pub const TOWNSHIP_APP_IDENTIFIER: &str = "dev.treetop.lattice.township";
pub const TOWNSHIP_DEV_CARRIER_KEY_ID_ENV: &str = "TOWNSHIP_DEV_CARRIER_KEY_ID";
pub const TOWNSHIP_DEV_CARRIER_KEY_SEED_ENV: &str = "TOWNSHIP_DEV_CARRIER_KEY_SEED";
pub const TOWNSHIP_DEV_TRACE_FILE_ENV: &str = "TOWNSHIP_DEV_TRACE_FILE";
#[cfg(feature = "township-dev-trace")]
pub const TOWNSHIP_DEV_TRACE_FILE_DEFAULTS_KEY: &str = "TownshipDevTraceFile";
pub const TOWNSHIP_NATIVE_KV_FILE_ENV: &str = "TOWNSHIP_NATIVE_KV_FILE";
pub const TOWNSHIP_PROBE_LOG_TAG: &str = "LATTICE_PROBE";
#[cfg(any(
    test,
    all(target_os = "ios", feature = "township-ios-key-reuse-native-probe")
))]
const TOWNSHIP_IOS_KEY_REUSE_PROBE_EVENT_MAX_BYTES: usize = 4_096;
#[cfg(all(target_os = "ios", feature = "township-ios-key-reuse-native-probe"))]
const TOWNSHIP_IOS_PROBE_LAUNCH_NONCE_ENV: &str = "TOWNSHIP_IOS_PROBE_LAUNCH_NONCE";
#[cfg(any(
    test,
    all(target_os = "ios", feature = "township-ios-key-reuse-native-probe")
))]
const TOWNSHIP_IOS_KEY_REUSE_PROBE_ARTIFACT_PREFIX: &str = "township-ios-key-reuse-probe-";
pub const TOWNSHIP_PAIRING_DISCOVERY_PACKET_TYPE: &str = "township-pairing-discovery";
pub const TOWNSHIP_PAIRING_DISCOVERY_BIND_ADDR: &str = "0.0.0.0:45721";
pub const TOWNSHIP_PAIRING_DISCOVERY_BROADCAST_ADDR: &str = "255.255.255.255:45721";
pub const TOWNSHIP_PAIRING_DISCOVERY_DEFAULT_TIMEOUT_MS: u64 = 750;
pub const TOWNSHIP_PAIRING_DISCOVERY_MAX_TIMEOUT_MS: u64 = 5_000;
pub const TOWNSHIP_CARRIER_SIGNING_PAYLOAD_MAX_BYTES: usize = 64_000;
const GOVERNANCE_DUPLICATE_RECONCILIATION_TIMEOUT: Duration = Duration::from_millis(500);
const GOVERNANCE_DUPLICATE_RECONCILIATION_INTERVAL: Duration = Duration::from_millis(10);
const GOVERNANCE_PUBLIC_SIDECAR_MISSING: &str =
    "governance witness identity is incomplete: public sidecar is missing";
#[cfg(feature = "township-dev-trace")]
const TOWNSHIP_DEV_TRACE_EVENT_MAX_CHARS: usize = 4_096;
const TOWNSHIP_PAIRING_DISCOVERY_MAX_PACKET_BYTES: usize = 16 * 1024;
const TOWNSHIP_NATIVE_PROBE_SIGNING_PAYLOAD: &[u8] = b"township-native-probe";
const TOWNSHIP_CARRIER_SIGNING_PREFIXES: [&[u8]; 4] = [
    b"\x89\x52carrier-session-v2",
    b"\x87\x4dlattice-op-v2",
    b"\x88\x55lattice-delegation-v2",
    b"\x89\x55lattice-delegation-v3",
];
#[cfg(target_os = "android")]
const TOWNSHIP_INTENT_PLUGIN_IDENTIFIER: &str = "dev.treetop.lattice.township.intent";
#[cfg(any(target_os = "android", target_os = "ios"))]
static MOBILE_KEYRING_STORE_CONFIGURED: OnceLock<()> = OnceLock::new();
#[cfg(target_os = "android")]
#[link(name = "log")]
unsafe extern "C" {
    fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TownshipPairingDiscoveryAdvert {
    pub label: Option<String>,
    pub handoff: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct TownshipPairingDiscoveryPacket {
    #[serde(rename = "type")]
    packet_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    handoff: Option<String>,
}

pub trait CarrierKeySeedStore: Send + Sync {
    fn load_seed(&self, key_id: &str) -> Result<Option<[u8; 32]>, String>;
    fn save_seed(&self, key_id: &str, seed: [u8; 32]) -> Result<(), String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernanceWitnessCreateError {
    Duplicate,
    Backend(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GovernanceWitnessProviderKind {
    Unavailable,
    Injected,
    MacosProtectedKeychain,
    TestPresence,
}

pub trait GovernanceWitnessKeyStore: Send + Sync {
    fn provider_kind(&self) -> GovernanceWitnessProviderKind {
        GovernanceWitnessProviderKind::Injected
    }

    fn load_seed_public_key(&self) -> Result<Option<[u8; 32]>, String>;
    fn load_seed(&self) -> Result<Option<[u8; 32]>, GovernanceWitnessPresenceError>;
    fn load_public_key(&self) -> Result<Option<[u8; 32]>, String>;
    fn create_seed(&self, seed: [u8; 32]) -> Result<(), GovernanceWitnessCreateError>;
    fn create_public_key(&self, public_key: [u8; 32]) -> Result<(), GovernanceWitnessCreateError>;
    fn delete_seed(&self) -> Result<(), String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GovernanceWitnessPresenceError {
    Cancelled,
    Unavailable,
    Failed(String),
}

pub trait GovernanceWitnessPresence: Send + Sync {
    fn provider_kind(&self) -> GovernanceWitnessProviderKind {
        GovernanceWitnessProviderKind::Injected
    }

    fn authorize(&self, reason: &str) -> Result<(), GovernanceWitnessPresenceError>;
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GovernanceWitnessSignature {
    pub witness: String,
    pub signature: String,
    pub payload_digest: String,
}

#[derive(Clone, Default)]
pub struct InMemoryCarrierKeySeedStore {
    seeds: Arc<Mutex<HashMap<String, [u8; 32]>>>,
}

impl CarrierKeySeedStore for InMemoryCarrierKeySeedStore {
    fn load_seed(&self, key_id: &str) -> Result<Option<[u8; 32]>, String> {
        let seeds = self
            .seeds
            .lock()
            .map_err(|_| "carrier key seed store lock poisoned".to_string())?;
        Ok(seeds.get(key_id).copied())
    }

    fn save_seed(&self, key_id: &str, seed: [u8; 32]) -> Result<(), String> {
        let mut seeds = self
            .seeds
            .lock()
            .map_err(|_| "carrier key seed store lock poisoned".to_string())?;
        seeds.insert(key_id.to_string(), seed);
        Ok(())
    }
}

pub struct KeyringCarrierKeySeedStore {
    service: String,
}

impl KeyringCarrierKeySeedStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, key_id: &str) -> Result<keyring::Entry, String> {
        configure_mobile_keyring_store()?;
        keyring::Entry::new(&self.service, key_id)
            .map_err(|error| format!("carrier keyring entry unavailable: {error}"))
    }
}

impl CarrierKeySeedStore for KeyringCarrierKeySeedStore {
    fn load_seed(&self, key_id: &str) -> Result<Option<[u8; 32]>, String> {
        let encoded_seed = match self.entry(key_id)?.get_password() {
            Ok(encoded_seed) => encoded_seed,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(error) => return Err(format!("carrier keyring read failed: {error}")),
        };
        let seed = BASE64
            .decode(encoded_seed)
            .map_err(|error| format!("carrier keyring seed is not base64: {error}"))?;
        seed.try_into()
            .map(Some)
            .map_err(|_| "carrier keyring seed is not 32 bytes".to_string())
    }

    fn save_seed(&self, key_id: &str, seed: [u8; 32]) -> Result<(), String> {
        self.entry(key_id)?
            .set_password(&BASE64.encode(seed))
            .map_err(|error| format!("carrier keyring write failed: {error}"))
    }
}

pub struct TownshipNativeState {
    values: Mutex<HashMap<String, String>>,
    values_path: Mutex<Option<PathBuf>>,
    signing_keys: Mutex<HashMap<String, SigningKey>>,
    key_store: Arc<dyn CarrierKeySeedStore>,
    governance_key_store: Option<Arc<dyn GovernanceWitnessKeyStore>>,
    governance_presence: Option<Arc<dyn GovernanceWitnessPresence>>,
    governance_creation: Mutex<()>,
    governance_signing: Mutex<()>,
}

impl Default for TownshipNativeState {
    fn default() -> Self {
        Self::ephemeral()
    }
}

impl TownshipNativeState {
    pub fn ephemeral() -> Self {
        Self::with_key_store(InMemoryCarrierKeySeedStore::default())
    }

    pub fn with_key_store<S>(key_store: S) -> Self
    where
        S: CarrierKeySeedStore + 'static,
    {
        Self::with_values_and_key_stores(HashMap::new(), None, key_store, None, None)
    }

    pub fn with_governance_witness_key_store<S>(governance_key_store: S) -> Self
    where
        S: GovernanceWitnessKeyStore + 'static,
    {
        Self::with_values_and_key_stores(
            HashMap::new(),
            None,
            InMemoryCarrierKeySeedStore::default(),
            Some(Arc::new(governance_key_store)),
            None,
        )
    }

    pub fn with_governance_witness_custody<S, P>(
        governance_key_store: S,
        governance_presence: P,
    ) -> Self
    where
        S: GovernanceWitnessKeyStore + 'static,
        P: GovernanceWitnessPresence + 'static,
    {
        Self::with_values_and_key_stores(
            HashMap::new(),
            None,
            InMemoryCarrierKeySeedStore::default(),
            Some(Arc::new(governance_key_store)),
            Some(Arc::new(governance_presence)),
        )
    }

    pub fn with_persistent_values_file<P>(path: P) -> Result<Self, String>
    where
        P: AsRef<Path>,
    {
        Self::with_key_store_and_values_file(InMemoryCarrierKeySeedStore::default(), path)
    }

    pub fn with_key_store_and_values_file<S, P>(key_store: S, path: P) -> Result<Self, String>
    where
        S: CarrierKeySeedStore + 'static,
        P: AsRef<Path>,
    {
        let path = path.as_ref().to_path_buf();
        let values = load_values_file(&path)?;
        Ok(Self::with_values_and_key_stores(
            values,
            Some(path),
            key_store,
            None,
            None,
        ))
    }

    fn with_values_and_key_stores<S>(
        values: HashMap<String, String>,
        values_path: Option<PathBuf>,
        key_store: S,
        governance_key_store: Option<Arc<dyn GovernanceWitnessKeyStore>>,
        governance_presence: Option<Arc<dyn GovernanceWitnessPresence>>,
    ) -> Self
    where
        S: CarrierKeySeedStore + 'static,
    {
        Self {
            values: Mutex::new(values),
            values_path: Mutex::new(values_path),
            signing_keys: Mutex::new(HashMap::new()),
            key_store: Arc::new(key_store),
            governance_key_store,
            governance_presence,
            governance_creation: Mutex::new(()),
            governance_signing: Mutex::new(()),
        }
    }

    pub fn platform_secure(service: &str) -> Self {
        #[cfg(feature = "township-governance-test-presence")]
        {
            let custody = Arc::new(test_governance::TestGovernanceWitnessCustody);
            return Self::with_values_and_key_stores(
                HashMap::new(),
                None,
                KeyringCarrierKeySeedStore::new(service),
                Some(custody.clone()),
                Some(custody),
            );
        }

        #[cfg(all(
            not(feature = "township-governance-test-presence"),
            target_os = "macos"
        ))]
        {
            let custody = Arc::new(macos_governance::MacosGovernanceWitnessCustody::new(
                TOWNSHIP_GOVERNANCE_KEYRING_SERVICE,
            ));
            return Self::with_values_and_key_stores(
                HashMap::new(),
                None,
                KeyringCarrierKeySeedStore::new(service),
                Some(custody.clone()),
                Some(custody),
            );
        }

        #[cfg(all(
            not(feature = "township-governance-test-presence"),
            not(target_os = "macos")
        ))]
        Self::with_key_store(KeyringCarrierKeySeedStore::new(service))
    }

    pub fn platform_secure_with_values_file<P>(service: &str, path: P) -> Result<Self, String>
    where
        P: AsRef<Path>,
    {
        let state = Self::platform_secure(service);
        state.attach_persistent_values_file(path)?;
        Ok(state)
    }

    pub fn governance_witness_provider_kind(&self) -> GovernanceWitnessProviderKind {
        match (&self.governance_key_store, &self.governance_presence) {
            (Some(store), Some(presence)) if store.provider_kind() == presence.provider_kind() => {
                store.provider_kind()
            }
            _ => GovernanceWitnessProviderKind::Unavailable,
        }
    }

    pub fn governance_witness_custody_is_bound(&self) -> bool {
        self.governance_witness_provider_kind() != GovernanceWitnessProviderKind::Unavailable
    }

    pub fn kv_get(&self, key: &str) -> Result<Option<String>, String> {
        let values = self
            .values
            .lock()
            .map_err(|_| "key-value store lock poisoned".to_string())?;
        Ok(values.get(key).cloned())
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<(), String> {
        let values_path = self
            .values_path
            .lock()
            .map_err(|_| "key-value store path lock poisoned".to_string())?
            .clone();
        let mut values = self
            .values
            .lock()
            .map_err(|_| "key-value store lock poisoned".to_string())?;
        values.insert(key.to_string(), value.to_string());
        if let Some(path) = values_path {
            save_values_file(&path, &values)?;
        }
        Ok(())
    }

    pub fn attach_persistent_values_file<P>(&self, path: P) -> Result<(), String>
    where
        P: AsRef<Path>,
    {
        let path = path.as_ref().to_path_buf();
        let loaded_values = load_values_file(&path)?;
        let mut values = self
            .values
            .lock()
            .map_err(|_| "key-value store lock poisoned".to_string())?;
        if values.is_empty() {
            *values = loaded_values;
        } else {
            let existing_values = values.clone();
            *values = loaded_values;
            values.extend(existing_values);
            save_values_file(&path, &values)?;
        }
        let mut values_path = self
            .values_path
            .lock()
            .map_err(|_| "key-value store path lock poisoned".to_string())?;
        *values_path = Some(path);
        Ok(())
    }

    pub fn kv_snapshot(&self) -> Result<HashMap<String, String>, String> {
        let values = self
            .values
            .lock()
            .map_err(|_| "key-value store lock poisoned".to_string())?;
        Ok(values.clone())
    }

    pub fn insert_seeded_dev_key(&self, key_id: &str, seed: &str) -> Result<(), String> {
        reject_governance_carrier_alias(key_id)?;
        let digest = Sha256::digest(seed.as_bytes());
        let mut seed_bytes = [0u8; 32];
        seed_bytes.copy_from_slice(&digest);

        let mut signing_keys = self
            .signing_keys
            .lock()
            .map_err(|_| "signing key store lock poisoned".to_string())?;
        signing_keys.insert(key_id.to_string(), SigningKey::from_bytes(&seed_bytes));
        Ok(())
    }

    pub fn ensure_carrier_key(&self, key_id: &str) -> Result<String, String> {
        reject_governance_carrier_alias(key_id)?;
        let mut signing_keys = self
            .signing_keys
            .lock()
            .map_err(|_| "signing key store lock poisoned".to_string())?;
        if let Some(signing_key) = signing_keys.get(key_id) {
            return Ok(BASE64.encode(signing_key.verifying_key().as_bytes()));
        }

        if let Some(seed) = self.key_store.load_seed(key_id)? {
            let signing_key = SigningKey::from_bytes(&seed);
            let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());
            signing_keys.insert(key_id.to_string(), signing_key);
            return Ok(public_key);
        }

        let signing_key = SigningKey::generate(&mut OsRng);
        let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());
        self.key_store.save_seed(key_id, signing_key.to_bytes())?;

        signing_keys.insert(key_id.to_string(), signing_key);
        Ok(public_key)
    }

    pub fn public_key(&self, key_id: &str) -> Result<String, String> {
        reject_governance_carrier_alias(key_id)?;
        let signing_keys = self
            .signing_keys
            .lock()
            .map_err(|_| "signing key store lock poisoned".to_string())?;
        let signing_key = signing_keys
            .get(key_id)
            .ok_or_else(|| format!("missing signing key: {key_id}"))?;

        Ok(BASE64.encode(signing_key.verifying_key().as_bytes()))
    }

    pub fn sign_carrier(&self, key_id: &str, bytes_base64: &str) -> Result<String, String> {
        reject_governance_carrier_alias(key_id)?;
        let bytes = BASE64
            .decode(bytes_base64)
            .map_err(|error| format!("invalid carrier bytes: {error}"))?;
        if bytes.len() > TOWNSHIP_CARRIER_SIGNING_PAYLOAD_MAX_BYTES {
            return Err("signing payload too large".to_string());
        }
        if !recognized_carrier_signing_payload(&bytes) {
            return Err("unrecognized signing payload".to_string());
        }
        let signing_keys = self
            .signing_keys
            .lock()
            .map_err(|_| "signing key store lock poisoned".to_string())?;
        let signing_key = signing_keys
            .get(key_id)
            .ok_or_else(|| format!("missing signing key: {key_id}"))?;

        Ok(BASE64.encode(signing_key.sign(&bytes).to_bytes()))
    }

    pub fn ensure_governance_witness_key(&self) -> Result<String, String> {
        let store = self
            .governance_key_store
            .as_ref()
            .ok_or_else(|| "governance witness custody is unavailable".to_string())?;
        let _creation = self
            .governance_creation
            .lock()
            .map_err(|_| "governance witness creation lock poisoned".to_string())?;
        if let Some(public_key) = existing_governance_public_key(store.as_ref())? {
            return Ok(public_key);
        }

        let signing_key = SigningKey::generate(&mut OsRng);
        let public_key = signing_key.verifying_key().to_bytes();
        match store.create_seed(signing_key.to_bytes()) {
            Ok(()) => {}
            Err(GovernanceWitnessCreateError::Duplicate) => {
                return reconcile_duplicate_governance_identity(store.as_ref());
            }
            Err(error) => return Err(governance_create_error(error)),
        }
        if let Err(error) = store.create_public_key(public_key) {
            let create_error = governance_create_error(error);
            store.delete_seed().map_err(|rollback_error| {
                format!(
                    "governance witness public metadata creation failed: {create_error}; seed rollback failed: {rollback_error}"
                )
            })?;
            return Err(format!(
                "governance witness public metadata creation failed: {create_error}"
            ));
        }

        Ok(BASE64.encode(public_key))
    }

    pub fn governance_witness_public_key(&self) -> Result<String, String> {
        let store = self
            .governance_key_store
            .as_ref()
            .ok_or_else(|| "governance witness custody is unavailable".to_string())?;

        match governance_public_identity(store.as_ref())? {
            GovernancePublicIdentity::Complete(public_key) => Ok(BASE64.encode(public_key)),
            GovernancePublicIdentity::Missing => {
                Err("governance witness identity is missing".to_string())
            }
        }
    }

    pub fn sign_governance_witness(
        &self,
        claim: &serde_json::Value,
    ) -> Result<GovernanceWitnessSignature, String> {
        let payload = governance_witness::canonical_governance_witness_payload(claim)?;
        let replica = claim
            .get("replica")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "malformed governance witness claim: missing replica".to_string())?;
        let store = self
            .governance_key_store
            .as_ref()
            .ok_or_else(|| "governance witness custody is unavailable".to_string())?;
        let presence = self
            .governance_presence
            .as_ref()
            .ok_or_else(|| "governance witness presence is unavailable".to_string())?;
        let _signing = self
            .governance_signing
            .lock()
            .map_err(|_| "governance witness signing lock poisoned".to_string())?;
        let reason = format!("Sign clerk recovery witness for {replica}");
        presence
            .authorize(&reason)
            .map_err(governance_presence_error)?;

        let seed = store
            .load_seed()
            .map_err(governance_presence_error)?
            .ok_or_else(|| "governance witness protected seed is missing".to_string())?;
        let signing_key = SigningKey::from_bytes(&seed);
        let public_key = signing_key.verifying_key().to_bytes();
        let stored_public_key = match governance_public_identity(store.as_ref())? {
            GovernancePublicIdentity::Complete(public_key) => public_key,
            GovernancePublicIdentity::Missing => {
                return Err(
                    "governance witness identity is incomplete: public identity metadata is missing"
                        .to_string(),
                );
            }
        };
        if stored_public_key != public_key {
            return Err("governance witness identity is corrupt: public key mismatch".to_string());
        }

        Ok(GovernanceWitnessSignature {
            witness: BASE64.encode(public_key),
            signature: BASE64.encode(signing_key.sign(&payload.bytes).to_bytes()),
            payload_digest: URL_SAFE_NO_PAD.encode(payload.sha256),
        })
    }
}

#[cfg(feature = "township-governance-test-presence")]
pub fn governance_test_presence_authorization_count() -> usize {
    test_governance::authorization_count()
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
    store: &dyn GovernanceWitnessKeyStore,
) -> Result<Option<String>, String> {
    match governance_public_identity(store)? {
        GovernancePublicIdentity::Complete(public_key) => Ok(Some(BASE64.encode(public_key))),
        GovernancePublicIdentity::Missing => Ok(None),
    }
}

fn reconcile_duplicate_governance_identity(
    store: &dyn GovernanceWitnessKeyStore,
) -> Result<String, String> {
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
    store: &dyn GovernanceWitnessKeyStore,
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

fn reject_governance_carrier_alias(key_id: &str) -> Result<(), String> {
    if key_id == TOWNSHIP_GOVERNANCE_KEY_ALIAS {
        return Err("governance witness key is unavailable through carrier custody".to_string());
    }
    Ok(())
}

fn load_values_file(path: &Path) -> Result<HashMap<String, String>, String> {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|error| {
            format!(
                "native key-value store decode failed at {}: {error}",
                path.display()
            )
        }),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(format!(
            "native key-value store read failed at {}: {error}",
            path.display()
        )),
    }
}

fn save_values_file(path: &Path, values: &HashMap<String, String>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "native key-value store directory unavailable at {}: {error}",
                parent.display()
            )
        })?;
    }

    let encoded = serde_json::to_vec(values)
        .map_err(|error| format!("native key-value store encode failed: {error}"))?;
    let tmp_path = path.with_extension("tmp");
    let mut tmp_file = fs::File::create(&tmp_path).map_err(|error| {
        format!(
            "native key-value store write failed at {}: {error}",
            tmp_path.display()
        )
    })?;
    tmp_file.write_all(&encoded).map_err(|error| {
        format!(
            "native key-value store write failed at {}: {error}",
            tmp_path.display()
        )
    })?;
    tmp_file.sync_all().map_err(|error| {
        format!(
            "native key-value store sync failed at {}: {error}",
            tmp_path.display()
        )
    })?;
    drop(tmp_file);
    fs::rename(&tmp_path, path).map_err(|error| {
        format!(
            "native key-value store replace failed at {}: {error}",
            path.display()
        )
    })?;

    Ok(())
}

fn township_native_kv_path_from_env() -> Result<Option<PathBuf>, String> {
    #[cfg(not(any(debug_assertions, feature = "township-dev-trace")))]
    {
        return Ok(None);
    }

    #[cfg(any(debug_assertions, feature = "township-dev-trace"))]
    match std::env::var(TOWNSHIP_NATIVE_KV_FILE_ENV) {
        Ok(path) => {
            let path = path.trim();
            if path.is_empty() {
                Err(format!("{TOWNSHIP_NATIVE_KV_FILE_ENV} cannot be empty"))
            } else {
                Ok(Some(PathBuf::from(path)))
            }
        }
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(error) => Err(format!(
            "{TOWNSHIP_NATIVE_KV_FILE_ENV} is not valid unicode: {error}"
        )),
    }
}

pub fn decode_township_pairing_discovery_packet(
    bytes: &[u8],
) -> Result<Option<TownshipPairingDiscoveryAdvert>, String> {
    let packet: TownshipPairingDiscoveryPacket = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid discovery packet: {error}"))?;

    if packet.packet_type != TOWNSHIP_PAIRING_DISCOVERY_PACKET_TYPE {
        return Ok(None);
    }

    let handoff = present_string(packet.handoff)
        .ok_or_else(|| "discovery packet handoff cannot be empty".to_string())?;

    Ok(Some(TownshipPairingDiscoveryAdvert {
        label: present_string(packet.label),
        handoff,
    }))
}

pub fn encode_township_pairing_discovery_packet(
    advert: &TownshipPairingDiscoveryAdvert,
) -> Result<Vec<u8>, String> {
    let handoff = present_string(Some(advert.handoff.clone()))
        .ok_or_else(|| "discovery packet handoff cannot be empty".to_string())?;
    let packet = TownshipPairingDiscoveryPacket {
        packet_type: TOWNSHIP_PAIRING_DISCOVERY_PACKET_TYPE.to_string(),
        label: present_string(advert.label.clone()),
        handoff: Some(handoff),
    };
    let bytes = serde_json::to_vec(&packet)
        .map_err(|error| format!("discovery packet encode failed: {error}"))?;

    if bytes.len() > TOWNSHIP_PAIRING_DISCOVERY_MAX_PACKET_BYTES {
        return Err(format!("discovery packet too large: {} bytes", bytes.len()));
    }

    Ok(bytes)
}

pub fn advertise_township_pairing_handoff(
    handoff: String,
    label: Option<String>,
    target_addr: Option<String>,
) -> Result<(), String> {
    let packet = encode_township_pairing_discovery_packet(&TownshipPairingDiscoveryAdvert {
        label,
        handoff,
    })?;
    let target_addr = pairing_discovery_target(target_addr)?;
    let socket = UdpSocket::bind("0.0.0.0:0")
        .map_err(|error| format!("pairing discovery advertise bind failed: {error}"))?;
    socket
        .set_broadcast(true)
        .map_err(|error| format!("pairing discovery broadcast setup failed: {error}"))?;
    socket
        .send_to(&packet, target_addr)
        .map_err(|error| format!("pairing discovery advertise send failed: {error}"))?;

    Ok(())
}

fn recognized_carrier_signing_payload(bytes: &[u8]) -> bool {
    bytes == TOWNSHIP_NATIVE_PROBE_SIGNING_PAYLOAD
        || TOWNSHIP_CARRIER_SIGNING_PREFIXES
            .iter()
            .any(|prefix| bytes.starts_with(prefix))
}

pub fn pairing_discovery_target(target_addr: Option<String>) -> Result<SocketAddr, String> {
    let target = present_string(target_addr)
        .unwrap_or_else(|| TOWNSHIP_PAIRING_DISCOVERY_BROADCAST_ADDR.to_string());
    let address: SocketAddr = target
        .parse()
        .map_err(|_| "pairing discovery target is invalid".to_string())?;

    match address.ip() {
        IpAddr::V4(ip)
            if ip.is_broadcast() || ip.is_loopback() || ip.is_private() || ip.is_link_local() =>
        {
            Ok(address)
        }

        _other => Err("pairing discovery target is not local".to_string()),
    }
}

pub fn discover_township_pairing_adverts(
    timeout_ms: Option<u64>,
) -> Result<Vec<TownshipPairingDiscoveryAdvert>, String> {
    let socket = UdpSocket::bind(TOWNSHIP_PAIRING_DISCOVERY_BIND_ADDR).map_err(|error| {
        format!(
            "pairing discovery listen failed on {TOWNSHIP_PAIRING_DISCOVERY_BIND_ADDR}: {error}"
        )
    })?;

    collect_township_pairing_discovery_adverts(socket, pairing_discovery_timeout(timeout_ms))
}

pub fn collect_township_pairing_discovery_adverts(
    socket: UdpSocket,
    timeout: Duration,
) -> Result<Vec<TownshipPairingDiscoveryAdvert>, String> {
    let deadline = Instant::now()
        .checked_add(timeout)
        .unwrap_or_else(Instant::now);
    let mut buffer = [0u8; TOWNSHIP_PAIRING_DISCOVERY_MAX_PACKET_BYTES];
    let mut adverts = Vec::new();
    let mut seen_handoffs = HashSet::new();

    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }

        socket
            .set_read_timeout(Some(remaining))
            .map_err(|error| format!("pairing discovery timeout setup failed: {error}"))?;

        match socket.recv_from(&mut buffer) {
            Ok((len, _)) => {
                if let Ok(Some(advert)) = decode_township_pairing_discovery_packet(&buffer[..len]) {
                    if seen_handoffs.insert(advert.handoff.clone()) {
                        adverts.push(advert);
                    }
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) =>
            {
                break;
            }
            Err(error) => return Err(format!("pairing discovery receive failed: {error}")),
        }
    }

    Ok(adverts)
}

fn pairing_discovery_timeout(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        timeout_ms
            .unwrap_or(TOWNSHIP_PAIRING_DISCOVERY_DEFAULT_TIMEOUT_MS)
            .clamp(1, TOWNSHIP_PAIRING_DISCOVERY_MAX_TIMEOUT_MS),
    )
}

fn present_string(value: Option<String>) -> Option<String> {
    let trimmed = value?.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[cfg(feature = "township-dev-trace")]
pub fn township_command_names() -> &'static [&'static str] {
    &[
        "lattice_kv_get",
        "lattice_kv_set",
        "lattice_ensure_carrier_key",
        "lattice_public_key",
        "lattice_sign_carrier",
        "lattice_ensure_governance_witness_key",
        "lattice_governance_witness_public_key",
        "lattice_sign_governance_witness",
        "lattice_discover_pairing_adverts",
        "lattice_advertise_pairing_handoff",
        "lattice_android_current_pairing_handoff_b64",
        "lattice_log_probe",
        "lattice_log_ios_key_reuse_probe",
        "lattice_trace_dev_event",
    ]
}

#[cfg(not(feature = "township-dev-trace"))]
pub fn township_command_names() -> &'static [&'static str] {
    &[
        "lattice_kv_get",
        "lattice_kv_set",
        "lattice_ensure_carrier_key",
        "lattice_public_key",
        "lattice_sign_carrier",
        "lattice_ensure_governance_witness_key",
        "lattice_governance_witness_public_key",
        "lattice_sign_governance_witness",
        "lattice_discover_pairing_adverts",
        "lattice_advertise_pairing_handoff",
        "lattice_android_current_pairing_handoff_b64",
        "lattice_log_probe",
        "lattice_log_ios_key_reuse_probe",
    ]
}

pub fn configure_township_builder<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    state: TownshipNativeState,
) -> tauri::Builder<R> {
    configure_township_commands(builder).manage(state)
}

#[cfg(feature = "township-dev-trace")]
fn configure_township_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    configure_township_plugins(builder).invoke_handler(tauri::generate_handler![
        lattice_kv_get,
        lattice_kv_set,
        lattice_ensure_carrier_key,
        lattice_public_key,
        lattice_sign_carrier,
        lattice_ensure_governance_witness_key,
        lattice_governance_witness_public_key,
        lattice_sign_governance_witness,
        lattice_discover_pairing_adverts,
        lattice_advertise_pairing_handoff,
        lattice_android_current_pairing_handoff_b64,
        lattice_log_probe,
        lattice_log_ios_key_reuse_probe,
        lattice_trace_dev_event
    ])
}

#[cfg(not(feature = "township-dev-trace"))]
fn configure_township_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    configure_township_plugins(builder).invoke_handler(tauri::generate_handler![
        lattice_kv_get,
        lattice_kv_set,
        lattice_ensure_carrier_key,
        lattice_public_key,
        lattice_sign_carrier,
        lattice_ensure_governance_witness_key,
        lattice_governance_witness_public_key,
        lattice_sign_governance_witness,
        lattice_discover_pairing_adverts,
        lattice_advertise_pairing_handoff,
        lattice_android_current_pairing_handoff_b64,
        lattice_log_probe,
        lattice_log_ios_key_reuse_probe
    ])
}

fn configure_township_plugins<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    let builder = builder.plugin(tauri_plugin_deep_link::init());

    #[cfg(target_os = "android")]
    {
        return builder.plugin(android_intent::init());
    }

    #[cfg(not(target_os = "android"))]
    builder
}

#[cfg(target_os = "android")]
mod android_intent {
    use serde::Deserialize;
    use tauri::{
        plugin::{Builder, PluginHandle, TauriPlugin},
        Manager, Runtime,
    };

    use super::TOWNSHIP_INTENT_PLUGIN_IDENTIFIER;

    pub struct TownshipIntentPlugin<R: Runtime>(PluginHandle<R>);

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CurrentPairingHandoffResponse {
        handoff_b64: Option<String>,
    }

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("township-intent")
            .setup(|app, api| {
                let handle = api.register_android_plugin(
                    TOWNSHIP_INTENT_PLUGIN_IDENTIFIER,
                    "TownshipIntentPlugin",
                )?;
                app.manage(TownshipIntentPlugin(handle));
                Ok(())
            })
            .build()
    }

    pub fn current_pairing_handoff_b64<R: Runtime>(
        plugin: tauri::State<'_, TownshipIntentPlugin<R>>,
    ) -> Result<Option<String>, String> {
        let response = plugin
            .0
            .run_mobile_plugin::<CurrentPairingHandoffResponse>("getCurrent", ())
            .map_err(|error| format!("android current pairing handoff unavailable: {error}"))?;
        Ok(response.handoff_b64)
    }
}

pub fn configure_platform_secure_township_builder<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    let state = TownshipNativeState::platform_secure(TOWNSHIP_KEYRING_SERVICE);
    if let Some(values_path) = township_native_kv_path_from_env()
        .expect("invalid Township native key-value store path env")
    {
        state
            .attach_persistent_values_file(values_path)
            .expect("invalid Township native key-value store file");
        seed_dev_carrier_key_from_env(&state).expect("invalid Township dev carrier key seed env");

        return configure_township_commands(builder).manage(state);
    }

    configure_township_commands(builder)
        .manage(state)
        .setup(|app| {
            let values_path = app
                .path()
                .app_local_data_dir()
                .map_err(|error| tauri::Error::Io(std::io::Error::other(error)))?
                .join("township-native-kv.json");
            let state = app.state::<TownshipNativeState>();
            state
                .attach_persistent_values_file(values_path)
                .map_err(|error| tauri::Error::Io(std::io::Error::other(error)))?;
            seed_dev_carrier_key_from_env(&state)
                .map_err(|error| tauri::Error::Io(std::io::Error::other(error)))?;
            Ok(())
        })
}

pub fn configure_platform_secure_township_builder_with_values_file<R, P>(
    builder: tauri::Builder<R>,
    values_path: P,
) -> tauri::Builder<R>
where
    R: tauri::Runtime,
    P: AsRef<Path>,
{
    let state = TownshipNativeState::platform_secure(TOWNSHIP_KEYRING_SERVICE);
    state
        .attach_persistent_values_file(values_path)
        .expect("invalid Township native key-value store file");
    seed_dev_carrier_key_from_env(&state).expect("invalid Township dev carrier key seed env");

    configure_township_commands(builder).manage(state)
}

#[cfg(target_os = "android")]
fn configure_mobile_keyring_store() -> Result<(), String> {
    if MOBILE_KEYRING_STORE_CONFIGURED.get().is_some() {
        return Ok(());
    }

    let config = HashMap::from([("name", TOWNSHIP_KEYRING_SERVICE)]);
    let store = android_native_keyring_store::Store::new_with_configuration(&config)
        .map_err(|error| format!("android keyring store unavailable: {error}"))?;
    keyring_core::set_default_store(store);
    let _ = MOBILE_KEYRING_STORE_CONFIGURED.set(());
    Ok(())
}

#[cfg(target_os = "ios")]
fn configure_mobile_keyring_store() -> Result<(), String> {
    if MOBILE_KEYRING_STORE_CONFIGURED.get().is_some() {
        return Ok(());
    }

    let store = apple_native_keyring_store::protected::Store::new()
        .map_err(|error| format!("iOS keyring store unavailable: {error}"))?;
    keyring_core::set_default_store(store);
    let _ = MOBILE_KEYRING_STORE_CONFIGURED.set(());
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn configure_mobile_keyring_store() -> Result<(), String> {
    Ok(())
}

pub fn build_platform_secure_township_app<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    context: tauri::Context<R>,
) -> tauri::Result<tauri::App<R>> {
    configure_platform_secure_township_builder(builder).build(context)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    maybe_log_ios_key_reuse_startup_probe();
    configure_platform_secure_township_builder(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("error while running Township Tauri shell");
}

pub fn seed_dev_carrier_key_from_env(state: &TownshipNativeState) -> Result<bool, String> {
    #[cfg(not(any(debug_assertions, feature = "township-dev-trace")))]
    {
        let _ = state;
        return Ok(false);
    }

    #[cfg(any(debug_assertions, feature = "township-dev-trace"))]
    seed_dev_carrier_key_from_vars(state, std::env::vars())
}

#[cfg(any(debug_assertions, feature = "township-dev-trace"))]
pub fn seed_dev_carrier_key_from_vars<I, K, V>(
    state: &TownshipNativeState,
    vars: I,
) -> Result<bool, String>
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: Into<String>,
{
    let mut key_id = None;
    let mut seed = None;

    for (key, value) in vars {
        match key.as_ref() {
            TOWNSHIP_DEV_CARRIER_KEY_ID_ENV => key_id = Some(value.into()),
            TOWNSHIP_DEV_CARRIER_KEY_SEED_ENV => seed = Some(value.into()),
            _ => {}
        }
    }

    match (key_id, seed) {
        (None, None) => Ok(false),
        (Some(key_id), Some(seed)) => {
            let key_id = key_id.trim();
            let seed = seed.trim();
            if key_id.is_empty() {
                return Err(format!("{TOWNSHIP_DEV_CARRIER_KEY_ID_ENV} cannot be empty"));
            }
            if seed.is_empty() {
                return Err(format!(
                    "{TOWNSHIP_DEV_CARRIER_KEY_SEED_ENV} cannot be empty"
                ));
            }

            state.insert_seeded_dev_key(key_id, seed)?;
            Ok(true)
        }
        (Some(_), None) => Err(format!(
            "{TOWNSHIP_DEV_CARRIER_KEY_ID_ENV} requires {TOWNSHIP_DEV_CARRIER_KEY_SEED_ENV}"
        )),
        (None, Some(_)) => Err(format!(
            "{TOWNSHIP_DEV_CARRIER_KEY_SEED_ENV} requires {TOWNSHIP_DEV_CARRIER_KEY_ID_ENV}"
        )),
    }
}

#[tauri::command]
fn lattice_kv_get(
    state: tauri::State<'_, TownshipNativeState>,
    key: String,
) -> Result<Option<String>, String> {
    trace_dev_command("lattice_kv_get");
    state.kv_get(&key)
}

#[tauri::command]
fn lattice_kv_set(
    state: tauri::State<'_, TownshipNativeState>,
    key: String,
    value: String,
) -> Result<(), String> {
    trace_dev_command("lattice_kv_set");
    state.kv_set(&key, &value)
}

#[tauri::command]
fn lattice_ensure_carrier_key(
    state: tauri::State<'_, TownshipNativeState>,
    key_id: String,
) -> Result<String, String> {
    trace_dev_command("lattice_ensure_carrier_key");
    state.ensure_carrier_key(&key_id)
}

#[tauri::command]
fn lattice_public_key(
    state: tauri::State<'_, TownshipNativeState>,
    key_id: String,
) -> Result<String, String> {
    trace_dev_command("lattice_public_key");
    state.public_key(&key_id)
}

#[tauri::command]
fn lattice_sign_carrier(
    state: tauri::State<'_, TownshipNativeState>,
    key_id: String,
    bytes: String,
) -> Result<String, String> {
    trace_dev_command("lattice_sign_carrier");
    state.sign_carrier(&key_id, &bytes)
}

#[tauri::command]
fn lattice_ensure_governance_witness_key(
    state: tauri::State<'_, TownshipNativeState>,
) -> Result<String, String> {
    trace_dev_command("lattice_ensure_governance_witness_key");
    state.ensure_governance_witness_key()
}

#[tauri::command]
fn lattice_governance_witness_public_key(
    state: tauri::State<'_, TownshipNativeState>,
) -> Result<String, String> {
    trace_dev_command("lattice_governance_witness_public_key");
    state.governance_witness_public_key()
}

#[tauri::command]
fn lattice_sign_governance_witness(
    state: tauri::State<'_, TownshipNativeState>,
    claim: serde_json::Value,
) -> Result<GovernanceWitnessSignature, String> {
    trace_dev_command("lattice_sign_governance_witness");
    state.sign_governance_witness(&claim)
}

#[tauri::command]
fn lattice_discover_pairing_adverts(
    timeout_ms: Option<u64>,
) -> Result<Vec<TownshipPairingDiscoveryAdvert>, String> {
    trace_dev_command("lattice_discover_pairing_adverts");
    discover_township_pairing_adverts(timeout_ms)
}

#[tauri::command]
fn lattice_advertise_pairing_handoff(
    handoff: String,
    label: Option<String>,
    target_addr: Option<String>,
) -> Result<(), String> {
    trace_dev_command("lattice_advertise_pairing_handoff");
    advertise_township_pairing_handoff(handoff, label, target_addr)
}

#[cfg(target_os = "android")]
#[tauri::command]
fn lattice_android_current_pairing_handoff_b64(
    plugin: tauri::State<'_, android_intent::TownshipIntentPlugin<tauri::Wry>>,
) -> Result<Option<String>, String> {
    trace_dev_command("lattice_android_current_pairing_handoff_b64");
    android_intent::current_pairing_handoff_b64(plugin)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn lattice_android_current_pairing_handoff_b64() -> Result<Option<String>, String> {
    trace_dev_command("lattice_android_current_pairing_handoff_b64");
    Ok(None)
}

#[tauri::command]
fn lattice_log_probe(event: String) -> Result<(), String> {
    log_probe_event(&event);
    Ok(())
}

#[tauri::command]
fn lattice_log_ios_key_reuse_probe(event: String) -> Result<(), String> {
    log_ios_key_reuse_probe_event(&event)
}

#[cfg(feature = "township-dev-trace")]
#[tauri::command]
fn lattice_trace_dev_event(event: String) -> Result<(), String> {
    write_trace_dev_event(&event)
}

#[cfg(target_os = "android")]
fn log_probe_event(event: &str) {
    const ANDROID_LOG_INFO: c_int = 4;

    let Ok(tag) = CString::new(TOWNSHIP_PROBE_LOG_TAG) else {
        return;
    };
    let Ok(message) = CString::new(sanitize_probe_event(event, None)) else {
        return;
    };

    unsafe {
        let _ = __android_log_write(ANDROID_LOG_INFO, tag.as_ptr(), message.as_ptr());
    }
}

#[cfg(not(target_os = "android"))]
fn log_probe_event(event: &str) {
    let line = format_probe_event(event, std::process::id(), None, None);
    println!("{line}");
}

#[cfg(all(target_os = "ios", feature = "township-ios-key-reuse-native-probe"))]
fn log_probe_line_to_stderr(line: &str) {
    let mut stderr = std::io::stderr().lock();
    let _ = writeln!(stderr, "{line}");
    let _ = stderr.flush();
}

fn sanitize_probe_event(event: &str, max_bytes: Option<usize>) -> String {
    let capacity = max_bytes.map_or(event.len(), |limit| event.len().min(limit));
    let mut sanitized = String::with_capacity(capacity);
    for character in event.chars() {
        let character = if (' '..='~').contains(&character) {
            character
        } else {
            ' '
        };
        if max_bytes.is_some_and(|limit| sanitized.len() + character.len_utf8() > limit) {
            break;
        }
        sanitized.push(character);
    }
    sanitized
}

#[cfg(not(target_os = "android"))]
fn format_probe_event(
    event: &str,
    process_id: u32,
    max_bytes: Option<usize>,
    launch_nonce: Option<&str>,
) -> String {
    let event = sanitize_probe_event(event, max_bytes);
    match launch_nonce {
        Some(nonce) => format!(
            "{TOWNSHIP_PROBE_LOG_TAG}: {event} launch_nonce={nonce} process_id={process_id}"
        ),
        None => format!("{TOWNSHIP_PROBE_LOG_TAG}: {event} process_id={process_id}"),
    }
}

#[cfg(any(
    test,
    all(target_os = "ios", feature = "township-ios-key-reuse-native-probe")
))]
fn validate_ios_probe_launch_nonce(nonce: Option<&str>) -> Result<&str, &'static str> {
    let nonce = nonce.ok_or("missing iOS probe launch nonce")?;
    if nonce.len() == 32
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(nonce)
    } else {
        Err("invalid iOS probe launch nonce")
    }
}

#[cfg(any(
    test,
    all(target_os = "ios", feature = "township-ios-key-reuse-native-probe")
))]
fn ios_probe_artifact_file_name(nonce: &str) -> String {
    format!("{TOWNSHIP_IOS_KEY_REUSE_PROBE_ARTIFACT_PREFIX}{nonce}.log")
}

#[cfg(all(target_os = "ios", feature = "township-ios-key-reuse-native-probe"))]
fn log_ios_key_reuse_probe_event(event: &str) -> Result<(), String> {
    let nonce = std::env::var(TOWNSHIP_IOS_PROBE_LAUNCH_NONCE_ENV)
        .map_err(|_| "missing iOS probe launch nonce".to_string())?;
    let nonce = validate_ios_probe_launch_nonce(Some(&nonce)).map_err(str::to_string)?;
    let line = format_probe_event(
        event,
        std::process::id(),
        Some(TOWNSHIP_IOS_KEY_REUSE_PROBE_EVENT_MAX_BYTES),
        Some(nonce),
    );
    log_probe_line_to_stderr(&line);
    append_ios_probe_artifact(nonce, &line)
}

#[cfg(not(all(target_os = "ios", feature = "township-ios-key-reuse-native-probe")))]
fn log_ios_key_reuse_probe_event(event: &str) -> Result<(), String> {
    log_probe_event(event);
    Ok(())
}

#[cfg(all(target_os = "ios", feature = "township-ios-key-reuse-native-probe"))]
fn ios_probe_artifact_path(nonce: &str) -> PathBuf {
    let cache_directory = PathBuf::from(NSHomeDirectory().to_string())
        .join("Library")
        .join("Caches");
    ios_probe_artifact_path_in(&cache_directory, nonce)
}

#[cfg(all(target_os = "ios", feature = "township-ios-key-reuse-native-probe"))]
fn reset_ios_probe_artifact(nonce: &str) -> Result<(), String> {
    let path = ios_probe_artifact_path(nonce);
    let cache_directory = path
        .parent()
        .ok_or_else(|| "iOS probe artifact path has no parent".to_string())?;
    reset_ios_probe_artifact_in(cache_directory, nonce)
}

#[cfg(any(
    test,
    all(target_os = "ios", feature = "township-ios-key-reuse-native-probe")
))]
fn ios_probe_artifact_path_in(cache_directory: &Path, nonce: &str) -> PathBuf {
    cache_directory.join(ios_probe_artifact_file_name(nonce))
}

#[cfg(any(
    all(test, unix),
    all(target_os = "ios", feature = "township-ios-key-reuse-native-probe")
))]
fn reset_ios_probe_artifact_in(cache_directory: &Path, nonce: &str) -> Result<(), String> {
    fs::create_dir_all(cache_directory)
        .map_err(|_| "unable to create iOS probe artifact directory")?;
    let path = ios_probe_artifact_path_in(cache_directory, nonce);
    for entry in
        fs::read_dir(cache_directory).map_err(|_| "unable to inspect iOS probe artifacts")?
    {
        let entry = entry.map_err(|_| "unable to inspect iOS probe artifact")?;
        let file_type = entry
            .file_type()
            .map_err(|_| "unable to inspect iOS probe artifact type")?;
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if file_type.is_file()
            && entry.path() != path
            && file_name.starts_with(TOWNSHIP_IOS_KEY_REUSE_PROBE_ARTIFACT_PREFIX)
            && file_name.ends_with(".log")
        {
            fs::remove_file(entry.path())
                .map_err(|_| "unable to remove stale iOS probe artifact")?;
        }
    }
    let file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|_| "unable to reset iOS probe artifact")?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "unable to protect iOS probe artifact")?;
    file.sync_all()
        .map_err(|_| "unable to sync iOS probe artifact".to_string())
}

#[cfg(all(target_os = "ios", feature = "township-ios-key-reuse-native-probe"))]
fn append_ios_probe_artifact(nonce: &str, line: &str) -> Result<(), String> {
    let path = ios_probe_artifact_path(nonce);
    let cache_directory = path
        .parent()
        .ok_or_else(|| "iOS probe artifact path has no parent".to_string())?;
    append_ios_probe_artifact_in(cache_directory, nonce, line)
}

#[cfg(any(
    all(test, unix),
    all(target_os = "ios", feature = "township-ios-key-reuse-native-probe")
))]
fn append_ios_probe_artifact_in(
    cache_directory: &Path,
    nonce: &str,
    line: &str,
) -> Result<(), String> {
    let path = ios_probe_artifact_path_in(cache_directory, nonce);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|_| "unable to append iOS probe artifact")?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "unable to protect iOS probe artifact")?;
    writeln!(file, "{line}").map_err(|_| "unable to write iOS probe artifact")?;
    file.flush()
        .map_err(|_| "unable to flush iOS probe artifact")?;
    file.sync_all()
        .map_err(|_| "unable to sync iOS probe artifact".to_string())
}

#[cfg(all(target_os = "ios", feature = "township-ios-key-reuse-native-probe"))]
fn maybe_log_ios_key_reuse_startup_probe() {
    let nonce = std::env::var(TOWNSHIP_IOS_PROBE_LAUNCH_NONCE_ENV).ok();
    let Ok(nonce) = validate_ios_probe_launch_nonce(nonce.as_deref()) else {
        log_probe_event(
            "township-ios-key-reuse-probe stage=native_startup error=invalid_launch_nonce",
        );
        return;
    };
    if reset_ios_probe_artifact(nonce).is_ok() {
        let _ = log_ios_key_reuse_probe_event("township-ios-key-reuse-probe stage=native_startup");
    } else {
        log_probe_event(
            "township-ios-key-reuse-probe stage=native_startup error=artifact_unavailable",
        );
    }
}

#[cfg(not(all(target_os = "ios", feature = "township-ios-key-reuse-native-probe")))]
fn maybe_log_ios_key_reuse_startup_probe() {}

#[cfg(feature = "township-dev-trace")]
fn trace_dev_command(command: &str) {
    let _ = write_trace_dev_event(command);
}

#[cfg(feature = "township-dev-trace")]
fn write_trace_dev_event(command: &str) -> Result<(), String> {
    let path = trace_dev_file_path()
        .ok_or_else(|| "unable to write Township development trace".to_string())?;

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|_| "unable to write Township development trace".to_string())?;
    writeln!(file, "{}", sanitize_trace_dev_event(command))
        .map_err(|_| "unable to write Township development trace".to_string())
}

#[cfg(feature = "township-dev-trace")]
fn trace_dev_file_path() -> Option<String> {
    if let Ok(path) = std::env::var(TOWNSHIP_DEV_TRACE_FILE_ENV) {
        let path = path.trim().to_string();
        if !path.is_empty() {
            return Some(path);
        }
    }

    trace_dev_file_path_from_platform()
}

#[cfg(all(feature = "township-dev-trace", target_os = "macos"))]
fn trace_dev_file_path_from_platform() -> Option<String> {
    let output = std::process::Command::new("/usr/bin/defaults")
        .args([
            "read",
            TOWNSHIP_APP_IDENTIFIER,
            TOWNSHIP_DEV_TRACE_FILE_DEFAULTS_KEY,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let path = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(all(feature = "township-dev-trace", not(target_os = "macos")))]
fn trace_dev_file_path_from_platform() -> Option<String> {
    None
}

#[cfg(not(feature = "township-dev-trace"))]
fn trace_dev_command(_command: &str) {}

#[cfg(feature = "township-dev-trace")]
fn sanitize_trace_dev_event(command: &str) -> String {
    command
        .replace(['\r', '\n', '\0'], " ")
        .chars()
        .take(TOWNSHIP_DEV_TRACE_EVENT_MAX_CHARS)
        .collect()
}

#[cfg(test)]
mod probe_event_tests {
    use super::{
        format_probe_event, ios_probe_artifact_file_name, sanitize_probe_event,
        validate_ios_probe_launch_nonce, TOWNSHIP_IOS_KEY_REUSE_PROBE_EVENT_MAX_BYTES,
    };

    #[cfg(unix)]
    use super::{append_ios_probe_artifact_in, reset_ios_probe_artifact_in};
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn probe_events_are_single_line_and_only_ios_key_reuse_is_bounded() {
        assert_eq!(
            sanitize_probe_event("ready\r\nforged\0", None),
            "ready  forged "
        );
        assert_eq!(
            sanitize_probe_event("ready\u{2028}\u{202e}", None),
            "ready  "
        );
        assert_eq!(
            format_probe_event("ready\nforged", 42, None, None),
            "LATTICE_PROBE: ready forged process_id=42"
        );

        let oversized = "x".repeat(TOWNSHIP_IOS_KEY_REUSE_PROBE_EVENT_MAX_BYTES + 100);
        assert_eq!(
            sanitize_probe_event(&oversized, None).len(),
            oversized.len()
        );
        assert_eq!(
            sanitize_probe_event(
                &oversized,
                Some(TOWNSHIP_IOS_KEY_REUSE_PROBE_EVENT_MAX_BYTES)
            )
            .len(),
            TOWNSHIP_IOS_KEY_REUSE_PROBE_EVENT_MAX_BYTES
        );
    }

    #[test]
    fn ios_probe_records_bind_valid_launch_nonce_and_artifact_name() {
        let nonce = "0123456789abcdef0123456789abcdef";
        assert_eq!(validate_ios_probe_launch_nonce(Some(nonce)), Ok(nonce));
        assert!(validate_ios_probe_launch_nonce(None).is_err());
        assert!(validate_ios_probe_launch_nonce(Some("A123456789abcdef0123456789abcdef")).is_err());
        assert!(validate_ios_probe_launch_nonce(Some("0123456789abcdef")).is_err());
        assert_eq!(
            ios_probe_artifact_file_name(nonce),
            "township-ios-key-reuse-probe-0123456789abcdef0123456789abcdef.log"
        );
        assert_eq!(
            format_probe_event(
                "township-ios-key-reuse-probe stage=native_startup",
                42,
                Some(TOWNSHIP_IOS_KEY_REUSE_PROBE_EVENT_MAX_BYTES),
                Some(nonce)
            ),
            "LATTICE_PROBE: township-ios-key-reuse-probe stage=native_startup launch_nonce=0123456789abcdef0123456789abcdef process_id=42"
        );
    }

    #[cfg(unix)]
    #[test]
    fn ios_probe_artifact_writer_resets_appends_protects_and_removes_stale_files() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should follow the Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "township-ios-probe-writer-{}-{unique}",
            std::process::id()
        ));
        let cache = root.join("nested").join("Library").join("Caches");
        let nonce = "0123456789abcdef0123456789abcdef";

        reset_ios_probe_artifact_in(&cache, nonce).expect("reset should create the cache path");
        let current = cache.join(ios_probe_artifact_file_name(nonce));
        assert_eq!(fs::read_to_string(&current).unwrap(), "");
        assert_eq!(
            fs::metadata(&current).unwrap().permissions().mode() & 0o777,
            0o600
        );

        fs::write(&current, "obsolete current content\n").unwrap();
        let stale = cache.join(ios_probe_artifact_file_name(
            "fedcba9876543210fedcba9876543210",
        ));
        fs::write(&stale, "stale probe content\n").unwrap();
        let unrelated = cache.join("unrelated-cache-file");
        fs::write(&unrelated, "keep me\n").unwrap();

        reset_ios_probe_artifact_in(&cache, nonce).expect("reset should truncate and sweep");
        assert_eq!(fs::read_to_string(&current).unwrap(), "");
        assert!(!stale.exists());
        assert!(unrelated.exists());
        assert_eq!(
            fs::metadata(&current).unwrap().permissions().mode() & 0o777,
            0o600
        );

        append_ios_probe_artifact_in(&cache, nonce, "first").expect("first append should work");
        append_ios_probe_artifact_in(&cache, nonce, "second").expect("second append should work");
        assert_eq!(fs::read_to_string(&current).unwrap(), "first\nsecond\n");
        assert_eq!(
            fs::metadata(&current).unwrap().permissions().mode() & 0o777,
            0o600
        );

        fs::remove_dir_all(root).unwrap();
    }
}
