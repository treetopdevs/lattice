use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use lattice_mobile_core::CarrierKeySeedStore;

pub(crate) const KEY_ALIAS: &str = "device-carrier-v1";
pub(crate) const KEY_SERVICE: &str = "dev.treetop.lattice.treehouse.carrier";
pub(crate) struct TreehouseKeyStore;
impl TreehouseKeyStore {
    fn entry(&self, key_id: &str) -> Result<keyring::Entry, String> {
        if key_id != KEY_ALIAS {
            return Err("invalid_key_alias".into());
        }
        keyring::Entry::new(KEY_SERVICE, KEY_ALIAS).map_err(|_| "key_store_unavailable".into())
    }
}
impl CarrierKeySeedStore for TreehouseKeyStore {
    fn load_seed(&self, key_id: &str) -> Result<Option<[u8; 32]>, String> {
        let encoded = match self.entry(key_id)?.get_password() {
            Ok(value) => value,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(_) => return Err("key_store_unavailable".into()),
        };
        let seed = BASE64
            .decode(encoded)
            .map_err(|_| "invalid_stored_key".to_string())?;
        seed.try_into()
            .map(Some)
            .map_err(|_| "invalid_stored_key".into())
    }
    fn save_seed(&self, key_id: &str, seed: [u8; 32]) -> Result<(), String> {
        self.entry(key_id)?
            .set_password(&BASE64.encode(seed))
            .map_err(|_| "key_store_unavailable".into())
    }
}
