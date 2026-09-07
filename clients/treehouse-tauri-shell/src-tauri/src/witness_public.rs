//! Closed public WebView-to-Rust witness request boundary. This module does not dispatch custody work.

use crate::witness_bridge::Bytes32;
use serde::{de::Error as _, Deserialize, Deserializer};
use tauri::ipc::InvokeBody;

pub const WITNESS_IDENTITY: &str = "treehouse_witness_public_identity";
pub const WITNESS_PREPARE_CREATION: &str = "treehouse_witness_prepare_creation";
pub const WITNESS_GENERATE: &str = "treehouse_witness_generate";
pub const WITNESS_PROVE_BINDING: &str = "treehouse_witness_prove_binding";
pub const WITNESS_CANCEL: &str = "treehouse_witness_cancel";
pub const MAX_PUBLIC_REQUEST: usize = 128 * 1024;
pub const PUBLIC_REQUEST_REFUSED: &str = "invalid_witness_request";

#[derive(Debug, PartialEq)]
pub enum PublicRequest {
    Identity,
    Prepare(PreparePublicRequest),
    Generate(GeneratePublicRequest),
    Proof(ProofPublicRequest),
    Cancel(CancelPublicRequest),
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PreparePublicRequest {
    #[serde(deserialize_with = "replica")]
    pub replica: String,
    #[serde(rename = "enrollmentId")]
    pub enrollment_id: Bytes32,
    pub recipient: Bytes32,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct GeneratePublicRequest {
    #[serde(rename = "creationAttemptId")]
    pub creation_attempt_id: Bytes32,
    #[serde(rename = "generationChallenge")]
    pub generation_challenge: Bytes32,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProofPublicRequest {
    #[serde(deserialize_with = "replica")]
    pub replica: String,
    #[serde(rename = "enrollmentId")]
    pub enrollment_id: Bytes32,
    pub recipient: Bytes32,
    #[serde(rename = "freshValidatorNonce")]
    pub fresh_validator_nonce: Bytes32,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CancelPublicRequest {
    #[serde(rename = "attemptId")]
    pub attempt_id: Bytes32,
}

pub fn decode_public_request(
    command: &str,
    body: &InvokeBody,
) -> Result<PublicRequest, &'static str> {
    if command == WITNESS_IDENTITY {
        return match body {
            InvokeBody::Json(serde_json::Value::Object(fields)) if fields.is_empty() => {
                Ok(PublicRequest::Identity)
            }
            _ => Err(PUBLIC_REQUEST_REFUSED),
        };
    }

    let bytes = transport_bytes(body)?;
    match command {
        WITNESS_PREPARE_CREATION => decode(&bytes).map(PublicRequest::Prepare),
        WITNESS_GENERATE => decode(&bytes).map(PublicRequest::Generate),
        WITNESS_PROVE_BINDING => decode(&bytes).map(PublicRequest::Proof),
        WITNESS_CANCEL => decode(&bytes).map(PublicRequest::Cancel),
        _ => Err(PUBLIC_REQUEST_REFUSED),
    }
}

fn transport_bytes(body: &InvokeBody) -> Result<Vec<u8>, &'static str> {
    let InvokeBody::Json(serde_json::Value::Array(values)) = body else {
        return Err(PUBLIC_REQUEST_REFUSED);
    };
    if values.is_empty() || values.len() > MAX_PUBLIC_REQUEST {
        return Err(PUBLIC_REQUEST_REFUSED);
    }
    values
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|integer| u8::try_from(integer).ok())
                .ok_or(PUBLIC_REQUEST_REFUSED)
        })
        .collect()
}

fn decode<'de, T: Deserialize<'de>>(bytes: &'de [u8]) -> Result<T, &'static str> {
    let text = std::str::from_utf8(bytes).map_err(|_| PUBLIC_REQUEST_REFUSED)?;
    if text.trim_start().as_bytes().first() != Some(&b'{') {
        return Err(PUBLIC_REQUEST_REFUSED);
    }
    serde_json::from_slice(bytes).map_err(|_| PUBLIC_REQUEST_REFUSED)
}

fn replica<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.is_empty() || value.len() > 512 {
        return Err(D::Error::custom("invalid_replica"));
    }
    Ok(value)
}
