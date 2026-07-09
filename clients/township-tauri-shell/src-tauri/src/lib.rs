use std::collections::{HashMap, HashSet};
#[cfg(target_os = "android")]
use std::ffi::CString;
use std::fs;
use std::io::ErrorKind;
use std::net::UdpSocket;
#[cfg(target_os = "android")]
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "android", target_os = "ios"))]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use tauri::Manager;

pub const TOWNSHIP_KEYRING_SERVICE: &str = "dev.treetop.lattice.township.carrier";
pub const TOWNSHIP_DEV_CARRIER_KEY_ID_ENV: &str = "TOWNSHIP_DEV_CARRIER_KEY_ID";
pub const TOWNSHIP_DEV_CARRIER_KEY_SEED_ENV: &str = "TOWNSHIP_DEV_CARRIER_KEY_SEED";
pub const TOWNSHIP_DEV_TRACE_FILE_ENV: &str = "TOWNSHIP_DEV_TRACE_FILE";
pub const TOWNSHIP_NATIVE_KV_FILE_ENV: &str = "TOWNSHIP_NATIVE_KV_FILE";
pub const TOWNSHIP_PROBE_LOG_TAG: &str = "LATTICE_PROBE";
pub const TOWNSHIP_PAIRING_DISCOVERY_PACKET_TYPE: &str = "township-pairing-discovery";
pub const TOWNSHIP_PAIRING_DISCOVERY_BIND_ADDR: &str = "0.0.0.0:45721";
pub const TOWNSHIP_PAIRING_DISCOVERY_BROADCAST_ADDR: &str = "255.255.255.255:45721";
pub const TOWNSHIP_PAIRING_DISCOVERY_DEFAULT_TIMEOUT_MS: u64 = 750;
pub const TOWNSHIP_PAIRING_DISCOVERY_MAX_TIMEOUT_MS: u64 = 5_000;
const TOWNSHIP_PAIRING_DISCOVERY_MAX_PACKET_BYTES: usize = 16 * 1024;
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
        Self::with_values_and_key_store(HashMap::new(), None, key_store)
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
        Ok(Self::with_values_and_key_store(
            values,
            Some(path),
            key_store,
        ))
    }

    fn with_values_and_key_store<S>(
        values: HashMap<String, String>,
        values_path: Option<PathBuf>,
        key_store: S,
    ) -> Self
    where
        S: CarrierKeySeedStore + 'static,
    {
        Self {
            values: Mutex::new(values),
            values_path: Mutex::new(values_path),
            signing_keys: Mutex::new(HashMap::new()),
            key_store: Arc::new(key_store),
        }
    }

    pub fn platform_secure(service: &str) -> Self {
        Self::with_key_store(KeyringCarrierKeySeedStore::new(service))
    }

    pub fn platform_secure_with_values_file<P>(service: &str, path: P) -> Result<Self, String>
    where
        P: AsRef<Path>,
    {
        Self::with_key_store_and_values_file(KeyringCarrierKeySeedStore::new(service), path)
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
        let bytes = BASE64
            .decode(bytes_base64)
            .map_err(|error| format!("invalid carrier bytes: {error}"))?;
        let signing_keys = self
            .signing_keys
            .lock()
            .map_err(|_| "signing key store lock poisoned".to_string())?;
        let signing_key = signing_keys
            .get(key_id)
            .ok_or_else(|| format!("missing signing key: {key_id}"))?;

        Ok(BASE64.encode(signing_key.sign(&bytes).to_bytes()))
    }
}

fn load_values_file(path: &Path) -> Result<HashMap<String, String>, String> {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).or_else(|_| Ok(HashMap::new())),
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
    fs::write(&tmp_path, encoded).map_err(|error| {
        format!(
            "native key-value store write failed at {}: {error}",
            tmp_path.display()
        )
    })?;
    fs::rename(&tmp_path, path).map_err(|error| {
        format!(
            "native key-value store replace failed at {}: {error}",
            path.display()
        )
    })?;

    Ok(())
}

fn township_native_kv_path_from_env() -> Result<Option<PathBuf>, String> {
    #[cfg(not(debug_assertions))]
    {
        return Ok(None);
    }

    #[cfg(debug_assertions)]
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
    let target_addr = present_string(target_addr)
        .unwrap_or_else(|| TOWNSHIP_PAIRING_DISCOVERY_BROADCAST_ADDR.to_string());
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

pub fn township_command_names() -> &'static [&'static str] {
    #[cfg(debug_assertions)]
    {
        return &[
            "lattice_kv_get",
            "lattice_kv_set",
            "lattice_ensure_carrier_key",
            "lattice_public_key",
            "lattice_sign_carrier",
            "lattice_discover_pairing_adverts",
            "lattice_advertise_pairing_handoff",
            "lattice_log_probe",
            "lattice_trace_dev_event",
        ];
    }

    #[cfg(not(debug_assertions))]
    &[
        "lattice_kv_get",
        "lattice_kv_set",
        "lattice_ensure_carrier_key",
        "lattice_public_key",
        "lattice_sign_carrier",
        "lattice_discover_pairing_adverts",
        "lattice_advertise_pairing_handoff",
        "lattice_log_probe",
    ]
}

pub fn configure_township_builder<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    state: TownshipNativeState,
) -> tauri::Builder<R> {
    configure_township_commands(builder).manage(state)
}

fn configure_township_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(debug_assertions)]
    {
        return builder
            .plugin(tauri_plugin_deep_link::init())
            .invoke_handler(tauri::generate_handler![
                lattice_kv_get,
                lattice_kv_set,
                lattice_ensure_carrier_key,
                lattice_public_key,
                lattice_sign_carrier,
                lattice_discover_pairing_adverts,
                lattice_advertise_pairing_handoff,
                lattice_log_probe,
                lattice_trace_dev_event
            ]);
    }

    #[cfg(not(debug_assertions))]
    builder
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            lattice_kv_get,
            lattice_kv_set,
            lattice_ensure_carrier_key,
            lattice_public_key,
            lattice_sign_carrier,
            lattice_discover_pairing_adverts,
            lattice_advertise_pairing_handoff,
            lattice_log_probe
        ])
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
    configure_platform_secure_township_builder(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("error while running Township Tauri shell");
}

pub fn seed_dev_carrier_key_from_env(state: &TownshipNativeState) -> Result<bool, String> {
    #[cfg(not(debug_assertions))]
    {
        let _ = state;
        return Ok(false);
    }

    #[cfg(debug_assertions)]
    seed_dev_carrier_key_from_vars(state, std::env::vars())
}

#[cfg(debug_assertions)]
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

#[tauri::command]
fn lattice_log_probe(event: String) -> Result<(), String> {
    log_probe_event(&event);
    Ok(())
}

#[tauri::command]
fn lattice_trace_dev_event(event: String) -> Result<(), String> {
    trace_dev_command(&event);
    Ok(())
}

#[cfg(target_os = "android")]
fn log_probe_event(event: &str) {
    const ANDROID_LOG_INFO: c_int = 4;

    let Ok(tag) = CString::new(TOWNSHIP_PROBE_LOG_TAG) else {
        return;
    };
    let Ok(message) = CString::new(event.replace('\0', " ")) else {
        return;
    };

    unsafe {
        let _ = __android_log_write(ANDROID_LOG_INFO, tag.as_ptr(), message.as_ptr());
    }
}

#[cfg(not(target_os = "android"))]
fn log_probe_event(event: &str) {
    println!("{TOWNSHIP_PROBE_LOG_TAG}: {event}");
}

#[cfg(debug_assertions)]
fn trace_dev_command(command: &str) {
    use std::io::Write as _;

    let Ok(path) = std::env::var(TOWNSHIP_DEV_TRACE_FILE_ENV) else {
        return;
    };
    if path.trim().is_empty() {
        return;
    }

    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{command}");
    }
}

#[cfg(not(debug_assertions))]
fn trace_dev_command(_command: &str) {}
