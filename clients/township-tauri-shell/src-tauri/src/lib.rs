use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use rand_core::OsRng;
use sha2::{Digest, Sha256};

pub const TOWNSHIP_KEYRING_SERVICE: &str = "dev.treetop.lattice.township.carrier";
pub const TOWNSHIP_DEV_CARRIER_KEY_ID_ENV: &str = "TOWNSHIP_DEV_CARRIER_KEY_ID";
pub const TOWNSHIP_DEV_CARRIER_KEY_SEED_ENV: &str = "TOWNSHIP_DEV_CARRIER_KEY_SEED";
pub const TOWNSHIP_DEV_TRACE_FILE_ENV: &str = "TOWNSHIP_DEV_TRACE_FILE";

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
        Self {
            values: Mutex::new(HashMap::new()),
            signing_keys: Mutex::new(HashMap::new()),
            key_store: Arc::new(key_store),
        }
    }

    pub fn platform_secure(service: &str) -> Self {
        Self::with_key_store(KeyringCarrierKeySeedStore::new(service))
    }

    pub fn kv_get(&self, key: &str) -> Result<Option<String>, String> {
        let values = self
            .values
            .lock()
            .map_err(|_| "key-value store lock poisoned".to_string())?;
        Ok(values.get(key).cloned())
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<(), String> {
        let mut values = self
            .values
            .lock()
            .map_err(|_| "key-value store lock poisoned".to_string())?;
        values.insert(key.to_string(), value.to_string());
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
        {
            let signing_keys = self
                .signing_keys
                .lock()
                .map_err(|_| "signing key store lock poisoned".to_string())?;
            if let Some(signing_key) = signing_keys.get(key_id) {
                return Ok(BASE64.encode(signing_key.verifying_key().as_bytes()));
            }
        }

        if let Some(seed) = self.key_store.load_seed(key_id)? {
            let signing_key = SigningKey::from_bytes(&seed);
            let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());
            let mut signing_keys = self
                .signing_keys
                .lock()
                .map_err(|_| "signing key store lock poisoned".to_string())?;
            signing_keys.insert(key_id.to_string(), signing_key);
            return Ok(public_key);
        }

        let signing_key = SigningKey::generate(&mut OsRng);
        let public_key = BASE64.encode(signing_key.verifying_key().as_bytes());
        self.key_store.save_seed(key_id, signing_key.to_bytes())?;

        let mut signing_keys = self
            .signing_keys
            .lock()
            .map_err(|_| "signing key store lock poisoned".to_string())?;
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

pub fn township_command_names() -> &'static [&'static str] {
    &[
        "lattice_kv_get",
        "lattice_kv_set",
        "lattice_ensure_carrier_key",
        "lattice_public_key",
        "lattice_sign_carrier",
    ]
}

pub fn configure_township_builder<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    state: TownshipNativeState,
) -> tauri::Builder<R> {
    builder
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            lattice_kv_get,
            lattice_kv_set,
            lattice_ensure_carrier_key,
            lattice_public_key,
            lattice_sign_carrier
        ])
}

pub fn configure_platform_secure_township_builder<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    let state = TownshipNativeState::platform_secure(TOWNSHIP_KEYRING_SERVICE);
    #[cfg(debug_assertions)]
    seed_dev_carrier_key_from_env(&state).expect("invalid Township dev carrier key seed env");

    configure_township_builder(builder, state)
}

pub fn build_platform_secure_township_app<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    context: tauri::Context<R>,
) -> tauri::Result<tauri::App<R>> {
    configure_platform_secure_township_builder(builder).build(context)
}

pub fn run() {
    configure_platform_secure_township_builder(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("error while running Township Tauri shell");
}

#[cfg(debug_assertions)]
pub fn seed_dev_carrier_key_from_env(state: &TownshipNativeState) -> Result<bool, String> {
    seed_dev_carrier_key_from_vars(state, std::env::vars())
}

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
