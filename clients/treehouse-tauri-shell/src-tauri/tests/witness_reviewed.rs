#[path = "../src/witness_binding.rs"]
mod witness_binding;
#[path = "../src/witness_bridge.rs"]
mod witness_bridge;
#[path = "../src/witness_reviewed.rs"]
mod witness_reviewed;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signer as _, SigningKey};
use serde_json::{json, Value};
use witness_bridge::{Bytes32, PRIVATE_PROTOCOL};
use witness_reviewed::*;

fn b(value: u8) -> String {
    STANDARD.encode([value; 32])
}

fn key() -> SigningKey {
    SigningKey::from_bytes(&[11; 32])
}

fn claim(public_key: [u8; 32]) -> Value {
    json!({
        "replica":"replica:test", "enrollmentId":b(1), "recipient":b(2),
        "creationAttemptId":b(3), "actualWitnessPublicKey":STANDARD.encode(public_key),
        "generationChallengeDigest":b(4), "freshValidatorNonce":b(5),
        "nativeRandomNonce":b(6), "nativeCallerSessionDigest":b(8)
    })
}

fn context(public_key: [u8; 32]) -> ReviewedBindingContext {
    ReviewedBindingContext::from_native_review(
        Bytes32([7; 32]),
        Bytes32([8; 32]),
        "replica:test".into(),
        Bytes32([1; 32]),
        Bytes32([2; 32]),
        Bytes32([5; 32]),
        Bytes32([3; 32]),
        Bytes32(public_key),
        Bytes32([4; 32]),
        Bytes32([6; 32]),
    )
    .unwrap()
}

fn prepared(claim: Value, remaining: u64) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocol":PRIVATE_PROTOCOL, "kind":"proof", "operationId":b(7),
        "sessionDigest":b(8), "status":"prepared", "handle":b(9),
        "claim":claim, "remainingMillis":remaining
    }))
    .unwrap()
}

fn signed(claim: Value, signature: &[u8]) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocol":PRIVATE_PROTOCOL, "kind":"proof", "operationId":b(7),
        "sessionDigest":b(8), "status":"signed", "handle":b(9), "claim":claim,
        "signature":STANDARD.encode(signature)
    }))
    .unwrap()
}

#[test]
fn exact_native_claim_is_sealed_and_actual_signature_verifies_once() {
    let signer = key();
    let claim = claim(signer.verifying_key().to_bytes());
    let sealed = accept_prepared(
        context(signer.verifying_key().to_bytes()),
        &prepared(claim.clone(), 60_000),
        1_000,
    )
    .unwrap();
    assert_eq!(sealed.handle(), Bytes32([9; 32]));
    let request = sealed.signing_request();
    let signature = signer.sign(request.bytes()).to_bytes();
    let verified = accept_signed(
        &sealed,
        &signed(claim, &signature),
        Bytes32([7; 32]),
        Bytes32([8; 32]),
        60_999,
    )
    .unwrap();
    assert_eq!(verified.claim_bytes(), request.bytes());
    assert_eq!(verified.signature(), signature);
    assert!(matches!(
        accept_signed(&sealed, b"{}", Bytes32([7; 32]), Bytes32([8; 32]), 60_999),
        Err(REVIEWED_BINDING_REFUSED)
    ));
}

#[test]
fn prepared_claim_must_equal_proposal_and_independent_native_observation() {
    let public_key = key().verifying_key().to_bytes();
    for field in [
        "enrollmentId",
        "recipient",
        "creationAttemptId",
        "actualWitnessPublicKey",
        "generationChallengeDigest",
        "freshValidatorNonce",
        "nativeRandomNonce",
        "nativeCallerSessionDigest",
    ] {
        let mut changed = claim(public_key);
        changed[field] = b(42).into();
        assert!(
            accept_prepared(context(public_key), &prepared(changed, 1), 0).is_err(),
            "{field}"
        );
    }
    let mut changed = claim(public_key);
    changed["replica"] = "other".into();
    assert!(accept_prepared(context(public_key), &prepared(changed, 1), 0).is_err());
}

#[test]
fn receipt_ttl_session_operation_signature_and_cancel_are_one_shot() {
    let signer = key();
    let public_key = signer.verifying_key().to_bytes();
    for remaining in [0, 60_001] {
        assert!(accept_prepared(
            context(public_key),
            &prepared(claim(public_key), remaining),
            0
        )
        .is_err());
    }
    assert!(accept_prepared(
        context(public_key),
        &prepared(claim(public_key), 1,),
        u64::MAX
    )
    .is_err());

    let expired = accept_prepared(context(public_key), &prepared(claim(public_key), 1), 0).unwrap();
    let expired_signature = signer.sign(expired.signing_request().bytes()).to_bytes();
    assert!(accept_signed(
        &expired,
        &signed(claim(public_key), &expired_signature),
        Bytes32([7; 32]),
        Bytes32([8; 32]),
        1,
    )
    .is_err());

    for (operation, session, now, signature) in [
        (Bytes32([0; 32]), Bytes32([8; 32]), 1, vec![0; 64]),
        (Bytes32([7; 32]), Bytes32([0; 32]), 1, vec![0; 64]),
        (Bytes32([7; 32]), Bytes32([8; 32]), 2, vec![0; 64]),
        (Bytes32([7; 32]), Bytes32([8; 32]), 0, vec![1; 64]),
    ] {
        let sealed =
            accept_prepared(context(public_key), &prepared(claim(public_key), 1), 0).unwrap();
        assert!(accept_signed(
            &sealed,
            &signed(claim(public_key), &signature),
            operation,
            session,
            now
        )
        .is_err());
        assert!(cancel(&sealed, Bytes32([7; 32]), Bytes32([8; 32])).is_err());
    }
    let sealed = accept_prepared(context(public_key), &prepared(claim(public_key), 1), 0).unwrap();
    assert!(cancel(&sealed, Bytes32([7; 32]), Bytes32([8; 32])).is_ok());
    assert!(cancel(&sealed, Bytes32([7; 32]), Bytes32([8; 32])).is_err());

    let stale = accept_prepared(context(public_key), &prepared(claim(public_key), 1), 0).unwrap();
    assert!(cancel(&stale, Bytes32([7; 32]), Bytes32([0; 32])).is_err());
    assert!(cancel(&stale, Bytes32([7; 32]), Bytes32([8; 32])).is_err());
}

#[test]
fn success_envelopes_are_closed_and_canonical() {
    let public_key = key().verifying_key().to_bytes();
    let base = String::from_utf8(prepared(claim(public_key), 1)).unwrap();
    for invalid in [
        base.replacen('{', "{\"extra\":true,", 1),
        base.replacen(
            "\"handle\"",
            &format!("\"handle\":\"{}\",\"handle\"", b(9)),
            1,
        ),
        base.replace(&format!("\"{}\"", b(9)), "7"),
        base.replace(PRIVATE_PROTOCOL, "other"),
        base.replace("\"prepared\"", "\"signed\""),
    ] {
        assert!(accept_prepared(context(public_key), invalid.as_bytes(), 0).is_err());
    }

    for changed_handle in [None, Some(b(42))] {
        let sealed =
            accept_prepared(context(public_key), &prepared(claim(public_key), 10), 0).unwrap();
        let signature = key().sign(sealed.signing_request().bytes()).to_bytes();
        let mut response: Value =
            serde_json::from_slice(&signed(claim(public_key), &signature)).unwrap();
        match changed_handle {
            None => {
                response.as_object_mut().unwrap().remove("handle");
            }
            Some(value) => response["handle"] = value.into(),
        }
        assert!(accept_signed(
            &sealed,
            &serde_json::to_vec(&response).unwrap(),
            Bytes32([7; 32]),
            Bytes32([8; 32]),
            0,
        )
        .is_err());
    }
}
