//! Seals one native-reviewed binding claim and verifies its one-shot fixed-key result.
//! The private bridge wraps Kotlin callbacks with native-owned operation/session fields,
//! maps the 32-byte opaque handle to Kotlin's handle object, and sends sign-prepared only
//! that handle. Neither the WebView nor the signing request supplies bytes to sign.

use crate::witness_binding::{BindingClaim, BindingSigningRequest};
use crate::witness_bridge::{Bytes32, PRIVATE_PROTOCOL};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{de::Error as _, Deserialize, Deserializer};
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) const REVIEWED_BINDING_REFUSED: &str = "invalid_reviewed_binding";
const MAX_PRIVATE_SUCCESS: usize = 128 * 1024;

pub(crate) struct ReviewedBindingContext {
    operation_id: Bytes32,
    session_digest: Bytes32,
    actual_public_key: Bytes32,
    claim_bytes: Vec<u8>,
}

impl ReviewedBindingContext {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_native_review(
        operation_id: Bytes32,
        session_digest: Bytes32,
        replica: String,
        enrollment_id: Bytes32,
        recipient: Bytes32,
        validator_nonce: Bytes32,
        original_creation_attempt_id: Bytes32,
        actual_public_key: Bytes32,
        generation_challenge_digest: Bytes32,
        native_nonce: Bytes32,
    ) -> Result<Self, &'static str> {
        if replica.is_empty() || replica.len() > 512 {
            return Err(REVIEWED_BINDING_REFUSED);
        }
        Ok(Self {
            operation_id,
            session_digest,
            actual_public_key,
            claim_bytes: canonical_claim(
                &replica,
                enrollment_id,
                recipient,
                original_creation_attempt_id,
                actual_public_key,
                generation_challenge_digest,
                validator_nonce,
                native_nonce,
                session_digest,
            ),
        })
    }
}

pub(crate) struct SealedReviewedBinding {
    operation_id: Bytes32,
    session_digest: Bytes32,
    handle: Bytes32,
    public_key: Bytes32,
    claim_bytes: Vec<u8>,
    expires_at_millis: u64,
    consumed: AtomicBool,
}

impl SealedReviewedBinding {
    pub(crate) fn handle(&self) -> Bytes32 {
        self.handle
    }

    pub(crate) fn signing_request(&self) -> BindingSigningRequest {
        BindingSigningRequest::from_sealed(self)
    }

    pub(crate) fn sealed_claim_bytes(&self) -> &[u8] {
        &self.claim_bytes
    }
}

pub(crate) struct VerifiedBinding {
    claim_bytes: Vec<u8>,
    signature: [u8; 64],
}

impl VerifiedBinding {
    pub(crate) fn claim_bytes(&self) -> &[u8] {
        &self.claim_bytes
    }

    pub(crate) fn signature(&self) -> [u8; 64] {
        self.signature
    }
}

pub(crate) fn accept_prepared(
    context: ReviewedBindingContext,
    bytes: &[u8],
    receipt_instant_millis: u64,
) -> Result<SealedReviewedBinding, &'static str> {
    let prepared: PreparedSuccess = decode(bytes)?;
    if prepared.protocol != PRIVATE_PROTOCOL
        || prepared.kind != "proof"
        || prepared.status != "prepared"
        || prepared.operation_id != context.operation_id
        || prepared.session_digest != context.session_digest
        || prepared.remaining_millis == 0
        || prepared.remaining_millis > 60_000
        || prepared.claim.canonical_bytes() != context.claim_bytes
    {
        return Err(REVIEWED_BINDING_REFUSED);
    }
    let expires_at_millis = receipt_instant_millis
        .checked_add(prepared.remaining_millis)
        .ok_or(REVIEWED_BINDING_REFUSED)?;
    Ok(SealedReviewedBinding {
        operation_id: context.operation_id,
        session_digest: context.session_digest,
        handle: prepared.handle,
        public_key: context.actual_public_key,
        claim_bytes: context.claim_bytes,
        expires_at_millis,
        consumed: AtomicBool::new(false),
    })
}

pub(crate) fn accept_signed(
    sealed: &SealedReviewedBinding,
    bytes: &[u8],
    current_operation_id: Bytes32,
    current_session_digest: Bytes32,
    now_millis: u64,
) -> Result<VerifiedBinding, &'static str> {
    consume(sealed)?;
    if current_operation_id != sealed.operation_id
        || current_session_digest != sealed.session_digest
        || now_millis >= sealed.expires_at_millis
    {
        return Err(REVIEWED_BINDING_REFUSED);
    }
    let signed: SignedSuccess = decode(bytes)?;
    if signed.protocol != PRIVATE_PROTOCOL
        || signed.kind != "proof"
        || signed.status != "signed"
        || signed.operation_id != sealed.operation_id
        || signed.session_digest != sealed.session_digest
        || signed.handle != sealed.handle
        || signed.claim.canonical_bytes() != sealed.claim_bytes
    {
        return Err(REVIEWED_BINDING_REFUSED);
    }
    let key =
        VerifyingKey::from_bytes(&sealed.public_key.0).map_err(|_| REVIEWED_BINDING_REFUSED)?;
    let signature = Signature::from_bytes(&signed.signature);
    key.verify_strict(&sealed.claim_bytes, &signature)
        .map_err(|_| REVIEWED_BINDING_REFUSED)?;
    Ok(VerifiedBinding {
        claim_bytes: sealed.claim_bytes.clone(),
        signature: signed.signature,
    })
}

pub(crate) fn cancel(
    sealed: &SealedReviewedBinding,
    current_operation_id: Bytes32,
    current_session_digest: Bytes32,
) -> Result<(), &'static str> {
    consume(sealed)?;
    if current_operation_id != sealed.operation_id
        || current_session_digest != sealed.session_digest
    {
        return Err(REVIEWED_BINDING_REFUSED);
    }
    Ok(())
}

fn consume(sealed: &SealedReviewedBinding) -> Result<(), &'static str> {
    sealed
        .consumed
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| ())
        .map_err(|_| REVIEWED_BINDING_REFUSED)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreparedSuccess {
    protocol: String,
    kind: String,
    #[serde(rename = "operationId")]
    operation_id: Bytes32,
    #[serde(rename = "sessionDigest")]
    session_digest: Bytes32,
    status: String,
    handle: Bytes32,
    claim: BindingClaim,
    #[serde(rename = "remainingMillis")]
    remaining_millis: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedSuccess {
    protocol: String,
    kind: String,
    #[serde(rename = "operationId")]
    operation_id: Bytes32,
    #[serde(rename = "sessionDigest")]
    session_digest: Bytes32,
    status: String,
    handle: Bytes32,
    claim: BindingClaim,
    #[serde(deserialize_with = "binary64")]
    signature: [u8; 64],
}

fn decode<'de, T: Deserialize<'de>>(bytes: &'de [u8]) -> Result<T, &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_PRIVATE_SUCCESS {
        return Err(REVIEWED_BINDING_REFUSED);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| REVIEWED_BINDING_REFUSED)?;
    if text.trim_start().as_bytes().first() != Some(&b'{') {
        return Err(REVIEWED_BINDING_REFUSED);
    }
    serde_json::from_slice(bytes).map_err(|_| REVIEWED_BINDING_REFUSED)
}

fn binary64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<[u8; 64], D::Error> {
    let value = String::deserialize(deserializer)?;
    let decoded = STANDARD.decode(&value).map_err(D::Error::custom)?;
    if value.len() != 88 || STANDARD.encode(&decoded) != value {
        return Err(D::Error::custom("invalid_signature"));
    }
    decoded
        .try_into()
        .map_err(|_| D::Error::custom("invalid_signature"))
}

#[allow(clippy::too_many_arguments)]
fn canonical_claim(
    replica: &str,
    enrollment_id: Bytes32,
    recipient: Bytes32,
    creation_attempt_id: Bytes32,
    public_key: Bytes32,
    challenge_digest: Bytes32,
    validator_nonce: Bytes32,
    native_nonce: Bytes32,
    session_digest: Bytes32,
) -> Vec<u8> {
    let product = lattice_mobile_core::ProductManifest::for_product("treehouse")
        .expect("checked-in Treehouse product manifest");
    let mut out = vec![0x8d];
    append_binary(&mut out, b"lattice-witness-binding-challenge-v1");
    out.push(1);
    for value in [
        product.product.as_bytes(),
        product.app_id.as_bytes(),
        replica.as_bytes(),
        &enrollment_id.0,
        &recipient.0,
        &creation_attempt_id.0,
        &public_key.0,
        &challenge_digest.0,
        &validator_nonce.0,
        &native_nonce.0,
        &session_digest.0,
    ] {
        append_binary(&mut out, value);
    }
    out
}

fn append_binary(out: &mut Vec<u8>, value: &[u8]) {
    match value.len() {
        length @ 0..=23 => out.push(0x40 | length as u8),
        length @ 24..=255 => out.extend([0x58, length as u8]),
        length => {
            out.push(0x59);
            out.extend((length as u16).to_be_bytes());
        }
    }
    out.extend(value);
}
