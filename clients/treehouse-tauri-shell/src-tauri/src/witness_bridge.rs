//! Closed private Rust-to-Android witness protocol. This module performs no custody operation.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

pub const PRIVATE_PROTOCOL: &str = "treehouse-witness-private-v1";
pub const APP_ID: &str = "dev.treetop.lattice.treehouse";
pub const MAIN_OWNER: &str = "main";
pub const MAX_PRIVATE_MESSAGE: usize = 128 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Bytes32(pub [u8; 32]);

impl Serialize for Bytes32 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(self.0))
    }
}

impl<'de> Deserialize<'de> for Bytes32 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.len() != 44 {
            return Err(D::Error::custom("invalid_32"));
        }
        let decoded = STANDARD.decode(&value).map_err(D::Error::custom)?;
        if STANDARD.encode(&decoded) != value {
            return Err(D::Error::custom("noncanonical_32"));
        }
        Ok(Self(
            decoded
                .try_into()
                .map_err(|_| D::Error::custom("invalid_32"))?,
        ))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Revision(pub i64);

impl Serialize for Revision {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for Revision {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.is_empty()
            || value.len() > 19
            || !value.bytes().all(|b| b.is_ascii_digit())
            || (value.len() > 1 && value.starts_with('0'))
        {
            return Err(D::Error::custom("invalid_revision"));
        }
        let parsed = value.parse::<i64>().map_err(D::Error::custom)?;
        if parsed <= 0 {
            return Err(D::Error::custom("invalid_revision"));
        }
        Ok(Self(parsed))
    }
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrivateRequest {
    Identity(IdentityRequest),
    Prepare(PrepareRequest),
    Generate(GenerateRequest),
    Proof(ProofRequest),
    SignPrepared(SignPreparedRequest),
    Cancel(CancelRequest),
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct IdentityRequest {
    #[serde(deserialize_with = "protocol", serialize_with = "serialize_protocol")]
    pub protocol: (),
    #[serde(rename = "operationId")]
    pub operation_id: Bytes32,
    #[serde(rename = "sessionDigest")]
    pub session_digest: Bytes32,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PrepareRequest {
    #[serde(deserialize_with = "protocol", serialize_with = "serialize_protocol")]
    pub protocol: (),
    #[serde(rename = "operationId")]
    pub operation_id: Bytes32,
    #[serde(rename = "sessionDigest")]
    pub session_digest: Bytes32,
    #[serde(deserialize_with = "replica")]
    pub replica: String,
    #[serde(rename = "enrollmentId")]
    pub enrollment_id: Bytes32,
    pub recipient: Bytes32,
    #[serde(rename = "creationAttemptId")]
    pub creation_attempt_id: Bytes32,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct GenerateRequest {
    #[serde(deserialize_with = "protocol", serialize_with = "serialize_protocol")]
    pub protocol: (),
    #[serde(rename = "operationId")]
    pub operation_id: Bytes32,
    #[serde(rename = "sessionDigest")]
    pub session_digest: Bytes32,
    #[serde(rename = "expectedRevision")]
    pub expected_revision: Revision,
    #[serde(rename = "creationAttemptId")]
    pub creation_attempt_id: Bytes32,
    #[serde(rename = "generationChallenge")]
    pub generation_challenge: Bytes32,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProofRequest {
    #[serde(deserialize_with = "protocol", serialize_with = "serialize_protocol")]
    pub protocol: (),
    #[serde(rename = "operationId")]
    pub operation_id: Bytes32,
    #[serde(rename = "sessionDigest")]
    pub session_digest: Bytes32,
    #[serde(rename = "expectedRevision")]
    pub expected_revision: Revision,
    #[serde(deserialize_with = "replica")]
    pub replica: String,
    #[serde(rename = "enrollmentId")]
    pub enrollment_id: Bytes32,
    pub recipient: Bytes32,
    #[serde(rename = "freshValidatorNonce")]
    pub fresh_validator_nonce: Bytes32,
    #[serde(rename = "nativeNonce")]
    pub native_nonce: Bytes32,
}

/// Opaque private bridge token; never accepts bytes to sign or a key selector.
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SignPreparedRequest {
    #[serde(deserialize_with = "protocol", serialize_with = "serialize_protocol")]
    pub protocol: (),
    #[serde(rename = "operationId")]
    pub operation_id: Bytes32,
    #[serde(rename = "sessionDigest")]
    pub session_digest: Bytes32,
    pub handle: Bytes32,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CancelRequest {
    #[serde(deserialize_with = "protocol", serialize_with = "serialize_protocol")]
    pub protocol: (),
    #[serde(rename = "operationId")]
    pub operation_id: Bytes32,
    #[serde(rename = "sessionDigest")]
    pub session_digest: Bytes32,
    #[serde(rename = "targetOperationId")]
    pub target_operation_id: Bytes32,
}

pub fn decode_request(bytes: &[u8]) -> Result<PrivateRequest, &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_PRIVATE_MESSAGE {
        return Err("invalid_private_request");
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "invalid_private_request")?;
    serde_json::from_str(text).map_err(|_| "invalid_private_request")
}

pub fn encode_request(request: &PrivateRequest) -> Result<Vec<u8>, &'static str> {
    let bytes = serde_json::to_vec(request).map_err(|_| "invalid_private_request")?;
    decode_request(&bytes)?;
    Ok(bytes)
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ResponseKind {
    Identity,
    Prepare,
    Generate,
    Proof,
    Cancel,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Missing,
    Refused,
    Cancelled,
}

/// Closed terminal framing. Successful payloads remain deferred to their typed coordinator owners.
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TerminalResponse {
    #[serde(deserialize_with = "protocol", serialize_with = "serialize_protocol")]
    pub protocol: (),
    pub kind: ResponseKind,
    #[serde(rename = "operationId")]
    pub operation_id: Bytes32,
    pub status: TerminalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl TerminalResponse {
    pub fn refused(
        kind: ResponseKind,
        operation_id: Bytes32,
        reason: &str,
    ) -> Result<Self, &'static str> {
        if !valid_reason(reason) {
            return Err("invalid_private_response");
        }
        Ok(Self {
            protocol: (),
            kind,
            operation_id,
            status: TerminalStatus::Refused,
            reason: Some(reason.into()),
        })
    }
    pub fn terminal(
        kind: ResponseKind,
        operation_id: Bytes32,
        status: TerminalStatus,
    ) -> Result<Self, &'static str> {
        if status == TerminalStatus::Refused {
            return Err("invalid_private_response");
        }
        Ok(Self {
            protocol: (),
            kind,
            operation_id,
            status,
            reason: None,
        })
    }
}

pub fn decode_terminal_response(bytes: &[u8]) -> Result<TerminalResponse, &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_PRIVATE_MESSAGE {
        return Err("invalid_private_response");
    }
    let raw: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "invalid_private_response")?;
    let object = raw.as_object().ok_or("invalid_private_response")?;
    let refused = object.get("status").and_then(|v| v.as_str()) == Some("refused");
    let expected: std::collections::BTreeSet<_> = (if refused {
        ["protocol", "kind", "operationId", "status", "reason"].as_slice()
    } else {
        ["protocol", "kind", "operationId", "status"].as_slice()
    })
    .iter()
    .copied()
    .collect();
    if object
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>()
        != expected
    {
        return Err("invalid_private_response");
    }
    let response: TerminalResponse =
        serde_json::from_slice(bytes).map_err(|_| "invalid_private_response")?;
    match (&response.status, &response.reason) {
        (TerminalStatus::Refused, Some(reason)) if valid_reason(reason) => Ok(response),
        (TerminalStatus::Missing | TerminalStatus::Cancelled, None) => Ok(response),
        _ => Err("invalid_private_response"),
    }
}

pub fn encode_terminal_response(response: &TerminalResponse) -> Result<Vec<u8>, &'static str> {
    let bytes = serde_json::to_vec(response).map_err(|_| "invalid_private_response")?;
    decode_terminal_response(&bytes)?;
    Ok(bytes)
}

fn valid_reason(reason: &str) -> bool {
    !reason.is_empty()
        && reason.len() <= 64
        && reason.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

fn protocol<'de, D: Deserializer<'de>>(deserializer: D) -> Result<(), D::Error> {
    if String::deserialize(deserializer)? == PRIVATE_PROTOCOL {
        Ok(())
    } else {
        Err(D::Error::custom("wrong_protocol"))
    }
}
fn serialize_protocol<S: Serializer>(_: &(), serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(PRIVATE_PROTOCOL)
}
fn replica<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.is_empty() || value.as_bytes().len() > 512 {
        Err(D::Error::custom("invalid_replica"))
    } else {
        Ok(value)
    }
}

/// Exact canonical binary-array session binding shared with the Android side.
pub fn session_digest(launch_nonce: Bytes32, navigation_nonce: Bytes32) -> Bytes32 {
    let mut framed = vec![0x85];
    for value in [
        b"treehouse-native-caller-session-v1".as_slice(),
        APP_ID.as_bytes(),
        MAIN_OWNER.as_bytes(),
        &launch_nonce.0,
        &navigation_nonce.0,
    ] {
        append_binary(&mut framed, value);
    }
    Bytes32(Sha256::digest(framed).into())
}

fn append_binary(out: &mut Vec<u8>, value: &[u8]) {
    match value.len() {
        0..=23 => out.push(0x40 | value.len() as u8),
        24..=255 => out.extend([0x58, value.len() as u8]),
        _ => {
            out.push(0x59);
            out.extend((value.len() as u16).to_be_bytes());
        }
    }
    out.extend(value);
}
