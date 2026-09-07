//! Closed native identity snapshots returned by the private Android plugin.

use crate::witness_bridge::{Bytes32, PrivateRequest, ResponseKind, Revision, PRIVATE_PROTOCOL};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{de::Error as _, Deserialize, Deserializer};

pub(crate) const SNAPSHOT_REFUSED: &str = "invalid_private_response";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SnapshotResponse {
    protocol: String,
    kind: ResponseKind,
    #[serde(rename = "operationId")]
    operation_id: Bytes32,
    #[serde(rename = "sessionDigest")]
    session_digest: Bytes32,
    status: String,
    eligible: bool,
    identity: IdentityRecord,
    #[serde(deserialize_with = "required_nullable")]
    enrollment: Nullable<EnrollmentRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    Prepared,
    GenerationStarted,
    GeneratedUnvalidated,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct IdentityRecord {
    #[serde(rename = "creationAttemptId")]
    creation_attempt_id: Bytes32,
    phase: Phase,
    #[serde(rename = "generationChallenge", deserialize_with = "required_nullable")]
    generation_challenge: Nullable<Bytes32>,
    #[serde(deserialize_with = "required_nullable")]
    metadata: Nullable<IdentityMetadata>,
    revision: Revision,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct IdentityMetadata {
    #[serde(rename = "publicKey")]
    public_key: Bytes32,
    #[serde(deserialize_with = "binary", rename = "spki")]
    spki: Vec<u8>,
    #[serde(rename = "appSignerSha256")]
    app_signer_sha256: Bytes32,
    #[serde(rename = "creationVersionCode")]
    creation_version_code: Revision,
    #[serde(deserialize_with = "certificate_chain", rename = "certificateChain")]
    certificate_chain: Vec<Vec<u8>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EnrollmentRecord {
    #[serde(deserialize_with = "replica")]
    replica: String,
    #[serde(rename = "enrollmentId")]
    enrollment_id: Bytes32,
    recipient: Bytes32,
    #[serde(rename = "creationAttemptId")]
    creation_attempt_id: Bytes32,
}

#[derive(Debug)]
struct Nullable<T>(Option<T>);
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Nullable<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Option::<T>::deserialize(deserializer).map(Self)
    }
}

// Field-level deserialization makes omission an error; explicit JSON null remains valid.
fn required_nullable<'de, D, T>(deserializer: D) -> Result<Nullable<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Nullable::deserialize(deserializer)
}

impl SnapshotResponse {
    pub(crate) fn identity(&self) -> &IdentityRecord {
        &self.identity
    }
    pub(crate) fn enrollment(&self) -> Option<&EnrollmentRecord> {
        self.enrollment.0.as_ref()
    }
}
impl IdentityRecord {
    pub(crate) fn creation_attempt_id(&self) -> Bytes32 {
        self.creation_attempt_id
    }
    pub(crate) fn phase(&self) -> &Phase {
        &self.phase
    }
    pub(crate) fn generation_challenge(&self) -> Option<Bytes32> {
        self.generation_challenge.0
    }
    pub(crate) fn metadata(&self) -> Option<&IdentityMetadata> {
        self.metadata.0.as_ref()
    }
    pub(crate) fn revision(&self) -> Revision {
        self.revision
    }
}
impl IdentityMetadata {
    pub(crate) fn public_key(&self) -> Bytes32 {
        self.public_key
    }
    pub(crate) fn spki(&self) -> &[u8] {
        &self.spki
    }
    pub(crate) fn app_signer_sha256(&self) -> Bytes32 {
        self.app_signer_sha256
    }
    pub(crate) fn creation_version_code(&self) -> Revision {
        self.creation_version_code
    }
    pub(crate) fn certificate_chain(&self) -> &[Vec<u8>] {
        &self.certificate_chain
    }
}
impl EnrollmentRecord {
    pub(crate) fn replica(&self) -> &str {
        &self.replica
    }
    pub(crate) fn enrollment_id(&self) -> Bytes32 {
        self.enrollment_id
    }
    pub(crate) fn recipient(&self) -> Bytes32 {
        self.recipient
    }
    pub(crate) fn creation_attempt_id(&self) -> Bytes32 {
        self.creation_attempt_id
    }
}

pub(crate) fn decode_snapshot(
    bytes: &[u8],
    request: &PrivateRequest,
) -> Result<SnapshotResponse, &'static str> {
    if bytes.is_empty() || bytes.len() > crate::witness_bridge::MAX_PRIVATE_MESSAGE {
        return Err(SNAPSHOT_REFUSED);
    }
    let response: SnapshotResponse = serde_json::from_slice(bytes).map_err(|_| SNAPSHOT_REFUSED)?;
    let (kind, operation, session) = match request {
        PrivateRequest::Identity(r) => (ResponseKind::Identity, r.operation_id, r.session_digest),
        PrivateRequest::Prepare(r) => (ResponseKind::Prepare, r.operation_id, r.session_digest),
        PrivateRequest::Generate(r) => (ResponseKind::Generate, r.operation_id, r.session_digest),
        _ => return Err(SNAPSHOT_REFUSED),
    };
    if response.protocol != PRIVATE_PROTOCOL
        || response.kind != kind
        || response.operation_id != operation
        || response.session_digest != session
        || response.status != "snapshot"
        || response.eligible
    {
        return Err(SNAPSHOT_REFUSED);
    }
    validate_identity(&response.identity)?;
    match (request, &response.enrollment.0) {
        (PrivateRequest::Identity(_), None) => {}
        (PrivateRequest::Generate(r), None)
            if matches!(response.identity.phase, Phase::GeneratedUnvalidated)
                && response.identity.creation_attempt_id == r.creation_attempt_id
                && response.identity.generation_challenge.0 == Some(r.generation_challenge) => {}
        (PrivateRequest::Prepare(r), Some(e))
            if e.replica == r.replica
                && e.enrollment_id == r.enrollment_id
                && e.recipient == r.recipient
                && e.creation_attempt_id == r.creation_attempt_id
                && e.creation_attempt_id == response.identity.creation_attempt_id
                && matches!(
                    response.identity.phase,
                    Phase::Prepared | Phase::GeneratedUnvalidated
                ) => {}
        _ => return Err(SNAPSHOT_REFUSED),
    }
    Ok(response)
}

fn validate_identity(identity: &IdentityRecord) -> Result<(), &'static str> {
    match (
        &identity.phase,
        &identity.generation_challenge.0,
        &identity.metadata.0,
    ) {
        (Phase::Prepared, None, None) | (Phase::GenerationStarted, Some(_), None) => Ok(()),
        (Phase::GeneratedUnvalidated, Some(_), Some(metadata)) => validate_metadata(metadata),
        _ => Err(SNAPSHOT_REFUSED),
    }
}

fn validate_metadata(metadata: &IdentityMetadata) -> Result<(), &'static str> {
    const PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    if metadata.spki.len() != 44
        || metadata.spki[..12] != PREFIX
        || metadata.spki[12..] != metadata.public_key.0
        || metadata.certificate_chain.is_empty()
    {
        return Err(SNAPSHOT_REFUSED);
    }
    let _ = (metadata.app_signer_sha256, metadata.creation_version_code);
    Ok(())
}

fn binary<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
    let value = String::deserialize(deserializer)?;
    let bytes = STANDARD.decode(&value).map_err(D::Error::custom)?;
    if STANDARD.encode(&bytes) != value {
        return Err(D::Error::custom("noncanonical_binary"));
    }
    Ok(bytes)
}
fn certificate_chain<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<Vec<u8>>, D::Error> {
    let values = Vec::<String>::deserialize(deserializer)?;
    if values.is_empty() || values.len() > 8 {
        return Err(D::Error::custom("invalid_chain"));
    }
    let mut total = 0usize;
    values
        .into_iter()
        .map(|value| {
            let bytes = STANDARD.decode(&value).map_err(D::Error::custom)?;
            total = total
                .checked_add(bytes.len())
                .ok_or_else(|| D::Error::custom("invalid_chain"))?;
            if bytes.is_empty()
                || bytes.len() > 16_384
                || total > 65_536
                || STANDARD.encode(&bytes) != value
            {
                return Err(D::Error::custom("invalid_chain"));
            }
            Ok(bytes)
        })
        .collect()
}
fn replica<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.is_empty() || value.len() > 512 {
        Err(D::Error::custom("invalid_replica"))
    } else {
        Ok(value)
    }
}
