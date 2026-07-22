//! Product-neutral native carrier signer seam.
//!
//! Extracted from the Township shell: the seed-store boundary and the keyed
//! Ed25519 signing cache. Platform key-store backends (keyring services,
//! biometric custody) stay in each shell — this crate never learns a product
//! service name, and seeds never leave the `CarrierKeySeedStore` boundary.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signer as _, SigningKey};
use rand_core::OsRng;
use sha2::{Digest, Sha256};

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

/// Keyed Ed25519 signing cache over a seed store. Seeds are loaded or
/// generated on demand; public keys and signatures are base64.
pub struct NativeCarrierSigner {
    signing_keys: Mutex<HashMap<String, SigningKey>>,
    key_store: Arc<dyn CarrierKeySeedStore>,
}

impl NativeCarrierSigner {
    pub fn new(key_store: Arc<dyn CarrierKeySeedStore>) -> Self {
        Self {
            signing_keys: Mutex::new(HashMap::new()),
            key_store,
        }
    }

    /// Install a deterministic development key derived from a seed phrase.
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

    /// Load or create the key for `key_id`, returning the base64 public key.
    pub fn ensure_key(&self, key_id: &str) -> Result<String, String> {
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

    pub fn sign(&self, key_id: &str, bytes_base64: &str) -> Result<String, String> {
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
