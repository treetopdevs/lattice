//! Bounded public projections of native snapshots and sealed verified signatures.
//! Serialization confers no eligibility, custody, presence, or command activation.
use crate::witness_reviewed::VerifiedBinding;
use crate::witness_snapshot::{IdentityRecord, Phase, SnapshotResponse};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(crate) const PUBLIC_RESULT_REFUSED: &str = "invalid_witness_result";
const MAX_PUBLIC_RESULT: usize = 131_072;

pub(crate) fn encode_identity(snapshot: &SnapshotResponse) -> Result<Vec<u8>, &'static str> {
    let identity = snapshot.identity();
    let status = if matches!(identity.phase(), Phase::GeneratedUnvalidated) {
        "identity"
    } else {
        "incomplete"
    };
    bounded(
        json!({"version": 1, "status": status, "eligible": false, "identity": identity_value(identity)?}),
    )
}

pub(crate) fn encode_prepare(snapshot: &SnapshotResponse) -> Result<Vec<u8>, &'static str> {
    let identity = snapshot.identity();
    if !matches!(
        identity.phase(),
        Phase::Prepared | Phase::GeneratedUnvalidated
    ) {
        return Err(PUBLIC_RESULT_REFUSED);
    }
    let enrollment = snapshot.enrollment().ok_or(PUBLIC_RESULT_REFUSED)?;
    if enrollment.creation_attempt_id() != identity.creation_attempt_id() {
        return Err(PUBLIC_RESULT_REFUSED);
    }
    bounded(
        json!({"version": 1, "status": "prepared", "eligible": false, "identity": identity_value(identity)?,
        "enrollment": {"replica": enrollment.replica(), "enrollmentId": STANDARD.encode(enrollment.enrollment_id().0),
            "recipient": STANDARD.encode(enrollment.recipient().0), "creationAttemptId": STANDARD.encode(enrollment.creation_attempt_id().0)}}),
    )
}

pub(crate) fn encode_generate(snapshot: &SnapshotResponse) -> Result<Vec<u8>, &'static str> {
    if !matches!(snapshot.identity().phase(), Phase::GeneratedUnvalidated) {
        return Err(PUBLIC_RESULT_REFUSED);
    }
    bounded(
        json!({"version": 1, "status": "generated_unvalidated", "eligible": false,
        "identity": identity_value(snapshot.identity())?}),
    )
}

/// Only a successfully verified sealed response supplies the claim and signature.
/// The retained original snapshot must still match all three key-generation facts.
pub(crate) fn encode_proof(
    verified: &VerifiedBinding,
    snapshot: &SnapshotResponse,
) -> Result<Vec<u8>, &'static str> {
    let identity = snapshot.identity();
    if !matches!(identity.phase(), Phase::GeneratedUnvalidated) {
        return Err(PUBLIC_RESULT_REFUSED);
    }
    let metadata = identity.metadata().ok_or(PUBLIC_RESULT_REFUSED)?;
    let challenge = identity
        .generation_challenge()
        .ok_or(PUBLIC_RESULT_REFUSED)?;
    let digest: [u8; 32] = Sha256::digest(challenge.0).into();
    let claim = verified.claim();
    if &metadata.public_key().0 != claim.actual_witness_public_key()
        || &identity.creation_attempt_id().0 != claim.creation_attempt_id()
        || &digest != claim.generation_challenge_digest()
    {
        return Err(PUBLIC_RESULT_REFUSED);
    }
    bounded(
        json!({"version": 1, "status": "signed", "eligible": false, "identity": identity_value(identity)?,
        "binding": {"claim": claim.public_projection(), "signature": STANDARD.encode(verified.signature())}}),
    )
}

pub(crate) fn encode_missing() -> Result<Vec<u8>, &'static str> {
    bounded(json!({"version": 1, "status": "missing"}))
}
pub(crate) fn encode_cancelled() -> Result<Vec<u8>, &'static str> {
    bounded(json!({"version": 1, "status": "cancelled"}))
}

fn identity_value(identity: &IdentityRecord) -> Result<Value, &'static str> {
    let phase = match (
        identity.phase(),
        identity.generation_challenge(),
        identity.metadata(),
    ) {
        (Phase::Prepared, None, None) => "prepared",
        (Phase::GenerationStarted, Some(_), None) => "generation_started",
        (Phase::GeneratedUnvalidated, Some(_), Some(_)) => "generated_unvalidated",
        _ => return Err(PUBLIC_RESULT_REFUSED),
    };
    let metadata = if let Some(metadata) = identity.metadata() {
        let prefix = [
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        if metadata.spki().len() != 44
            || metadata.spki()[..12] != prefix
            || metadata.spki()[12..] != metadata.public_key().0
            || metadata.certificate_chain().is_empty()
        {
            return Err(PUBLIC_RESULT_REFUSED);
        }
        json!({"publicKey": STANDARD.encode(metadata.public_key().0), "spki": STANDARD.encode(metadata.spki()),
            "appSignerSha256": STANDARD.encode(metadata.app_signer_sha256().0),
            "creationVersionCode": metadata.creation_version_code().0.to_string(),
            "certificateChain": metadata.certificate_chain().iter().map(|cert| STANDARD.encode(cert)).collect::<Vec<_>>()})
    } else {
        Value::Null
    };
    Ok(
        json!({"creationAttemptId": STANDARD.encode(identity.creation_attempt_id().0), "phase": phase,
        "generationChallenge": identity.generation_challenge().map(|challenge| STANDARD.encode(challenge.0)),
        "metadata": metadata, "revision": identity.revision().0.to_string()}),
    )
}

fn bounded(value: Value) -> Result<Vec<u8>, &'static str> {
    let bytes = serde_json::to_vec(&value).map_err(|_| PUBLIC_RESULT_REFUSED)?;
    if bytes.len() > MAX_PUBLIC_RESULT {
        return Err(PUBLIC_RESULT_REFUSED);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_serialized_json_escape_expansion_is_bounded_at_exact_limit() {
        let content = "\n".repeat((MAX_PUBLIC_RESULT - 2) / 2);
        assert_eq!(
            bounded(Value::String(content.clone())).unwrap().len(),
            MAX_PUBLIC_RESULT
        );
        assert_eq!(
            bounded(Value::String(content + "x")),
            Err(PUBLIC_RESULT_REFUSED)
        );
    }
}
