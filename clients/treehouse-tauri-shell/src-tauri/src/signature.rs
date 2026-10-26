//! Common strict Ed25519 verification. No secrets, authority or admission judgment.
use ed25519_dalek::{Signature, VerifyingKey};
/// Require canonical public-key bytes as well as dalek's strict scalar/R/equation
/// and small-order checks. Dalek decoding alone can retain noncanonical keys.
pub fn verify(key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let Ok(key_bytes) = <&[u8; 32]>::try_from(key) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(key_bytes) else {
        return false;
    };
    if key.to_edwards().compress().to_bytes() != *key_bytes {
        return false;
    }
    let Ok(signature) = Signature::from_slice(signature) else {
        return false;
    };
    key.verify_strict(message, &signature).is_ok()
}
