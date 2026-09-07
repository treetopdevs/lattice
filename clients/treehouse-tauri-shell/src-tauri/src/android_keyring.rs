//! Android startup for the existing seed-backed carrier identity only.
use std::{collections::HashMap, sync::OnceLock};

static CONFIGURED: OnceLock<Result<(), String>> = OnceLock::new();

pub(crate) fn configure() -> Result<(), String> {
    CONFIGURED
        .get_or_init(|| {
            let config = HashMap::from([("name", crate::key_store::KEY_SERVICE)]);
            let store = android_native_keyring_store::Store::new_with_configuration(&config)
                .map_err(|_| "key_store_unavailable".to_string())?;
            keyring_core::set_default_store(store);
            Ok(())
        })
        .clone()
}
