//! Pure, closed public binding claims. Encoding is not native consent or authority.
//! No witness IPC, signer, key backend or production request constructor exists here.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Deserializer};

/// Proposed public fields, deliberately separate from a native signing request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingClaim {
    #[serde(deserialize_with = "replica")]
    replica: String,
    #[serde(deserialize_with = "binary32")]
    enrollment_id: [u8; 32],
    #[serde(deserialize_with = "binary32")]
    recipient: [u8; 32],
    #[serde(deserialize_with = "binary32")]
    creation_attempt_id: [u8; 32],
    #[serde(deserialize_with = "binary32")]
    actual_witness_public_key: [u8; 32],
    #[serde(deserialize_with = "binary32")]
    generation_challenge_digest: [u8; 32],
    #[serde(deserialize_with = "binary32")]
    fresh_validator_nonce: [u8; 32],
    #[serde(deserialize_with = "binary32")]
    native_random_nonce: [u8; 32],
    #[serde(deserialize_with = "binary32")]
    native_caller_session_digest: [u8; 32],
}

impl BindingClaim {
    pub fn from_public_json(json: &str) -> Result<Self, String> {
        if json.len() > 128 * 1024 {
            return Err("invalid_binding_claim".into());
        }
        let claim: Self =
            serde_json::from_str(json).map_err(|_| "invalid_binding_claim".to_string())?;
        if claim.replica.is_empty() || claim.replica.len() > 512 {
            return Err("invalid_binding_replica".into());
        }
        Ok(claim)
    }

    /// An owned copy of the fixed-array canonical bytes, with no signing side effect.
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let product = lattice_mobile_core::ProductManifest::for_product("treehouse")
            .expect("checked-in Treehouse product manifest");
        let mut bytes = vec![0x8d]; // The closed 13-field array; no general CBOR encoder.
        append_binary(&mut bytes, b"lattice-witness-binding-challenge-v1");
        bytes.push(1);
        for value in [
            product.product.as_bytes(),
            product.app_id.as_bytes(),
            self.replica.as_bytes(),
            &self.enrollment_id,
            &self.recipient,
            &self.creation_attempt_id,
            &self.actual_witness_public_key,
            &self.generation_challenge_digest,
            &self.fresh_validator_nonce,
            &self.native_random_nonce,
            &self.native_caller_session_digest,
        ] {
            append_binary(&mut bytes, value);
        }
        bytes
    }
}

fn append_binary(out: &mut Vec<u8>, bytes: &[u8]) {
    match bytes.len() {
        length @ 0..=23 => out.push(0x40 | length as u8),
        length @ 24..=255 => out.extend([0x58, length as u8]),
        length => {
            out.push(0x59);
            out.extend((length as u16).to_be_bytes());
        }
    }
    out.extend(bytes);
}

fn binary32<'de, D: Deserializer<'de>>(deserializer: D) -> Result<[u8; 32], D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.len() != 44 {
        return Err(serde::de::Error::custom("invalid binding field length"));
    }
    let bytes = STANDARD.decode(&value).map_err(serde::de::Error::custom)?;
    if STANDARD.encode(&bytes) != value {
        return Err(serde::de::Error::custom("noncanonical binding field"));
    }
    bytes
        .try_into()
        .map_err(|_| serde::de::Error::custom("binding field must be 32 bytes"))
}

fn replica<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.is_empty() || value.len() > 512 {
        return Err(serde::de::Error::custom("invalid binding replica"));
    }
    Ok(value)
}

/// Only a later native enrollment/session gate may construct this type.
/// Public proposed claims cannot be promoted into consent by deserialization.
///
/// ```compile_fail
/// use treehouse_tauri_shell::witness_binding::BindingSigningRequest;
/// let forged = BindingSigningRequest { bytes: vec![1, 2, 3] };
/// ```
/// ```compile_fail
/// use treehouse_tauri_shell::witness_binding::BindingSigningRequest;
/// let forged: BindingSigningRequest = serde_json::from_str("{}").unwrap();
/// ```
pub struct BindingSigningRequest {
    bytes: Vec<u8>,
}

impl BindingSigningRequest {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}
