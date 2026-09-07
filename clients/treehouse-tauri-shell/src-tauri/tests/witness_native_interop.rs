//! Host-only reciprocal codec proof. Public deterministic software key; no JNI/custody evidence.
#[path = "../src/witness_binding.rs"]
mod witness_binding;
#[path = "../src/witness_bridge.rs"]
mod witness_bridge;
#[path = "../src/witness_drain.rs"]
mod witness_drain;
#[path = "../src/witness_mobile.rs"]
mod witness_mobile;
#[path = "../src/witness_reviewed.rs"]
mod witness_reviewed;
#[path = "../src/witness_snapshot.rs"]
mod witness_snapshot;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;
use std::{fs, path::PathBuf};
use witness_bridge::*;
use witness_reviewed::*;
const REPLICA: &str = "line\n\"é😀";
fn b(n: u8) -> Bytes32 {
    Bytes32([n; 32])
}
fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("gen/android/app/src/test/resources/native_interop")
}
fn read(name: &str) -> Vec<u8> {
    fs::read(fixtures().join(name)).unwrap()
}
fn requests() -> Vec<PrivateRequest> {
    vec![
        PrivateRequest::Identity(IdentityRequest {
            protocol: (),
            operation_id: b(7),
            session_digest: b(8),
        }),
        PrivateRequest::Prepare(PrepareRequest {
            protocol: (),
            operation_id: b(7),
            session_digest: b(8),
            replica: REPLICA.into(),
            enrollment_id: b(1),
            recipient: b(2),
            creation_attempt_id: b(3),
        }),
        PrivateRequest::Generate(GenerateRequest {
            protocol: (),
            operation_id: b(7),
            session_digest: b(8),
            expected_revision: Revision(i64::MAX),
            creation_attempt_id: b(3),
            generation_challenge: b(4),
        }),
        PrivateRequest::Proof(ProofRequest {
            protocol: (),
            operation_id: b(7),
            session_digest: b(8),
            expected_revision: Revision(1),
            replica: REPLICA.into(),
            enrollment_id: b(1),
            recipient: b(2),
            fresh_validator_nonce: b(5),
            native_nonce: b(6),
        }),
        PrivateRequest::SignPrepared(SignPreparedRequest {
            protocol: (),
            operation_id: b(7),
            session_digest: b(8),
            handle: b(9),
        }),
        PrivateRequest::Cancel(CancelRequest {
            protocol: (),
            operation_id: b(7),
            session_digest: b(8),
            target_operation_id: b(10),
        }),
    ]
}
#[test]
fn rust_producer_reproduces_exact_request_bytes() {
    let encoded: Vec<String> = requests()
        .iter()
        .map(|r| String::from_utf8(encode_request(r).unwrap()).unwrap())
        .collect();
    let bytes = serde_json::to_vec_pretty(&encoded).unwrap();
    if std::env::var_os("TREEHOUSE_INTEROP_EXPORT").is_some() {
        fs::write(fixtures().join("rust_requests.json"), &bytes).unwrap();
    }
    assert_eq!(read("rust_requests.json"), bytes);
    for (wire, expected) in encoded.iter().zip(requests()) {
        assert_eq!(decode_request(wire.as_bytes()).unwrap(), expected);
    }
}
fn public_key() -> Bytes32 {
    let raw: Vec<u8> = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
        .as_bytes()
        .chunks(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect();
    Bytes32(raw.try_into().unwrap())
}
fn context() -> ReviewedBindingContext {
    ReviewedBindingContext::from_native_review(
        b(7),
        b(8),
        REPLICA.into(),
        b(1),
        b(2),
        b(5),
        b(3),
        public_key(),
        b(4),
        b(6),
    )
    .unwrap()
}
fn changed(bytes: &[u8], field: &str, value: Value) -> Vec<u8> {
    let mut v: Value = serde_json::from_slice(bytes).unwrap();
    v[field] = value;
    serde_json::to_vec(&v).unwrap()
}
#[test]
fn kotlin_snapshots_cross_strict_parser_and_mobile_dispatch() {
    for (name, index) in [
        ("kotlin_identity_prepared.json", 0),
        ("kotlin_identity_started.json", 0),
        ("kotlin_identity_generated.json", 0),
        ("kotlin_prepare.json", 1),
        ("kotlin_generate.json", 2),
    ] {
        let bytes = read(name);
        let request = requests().remove(index);
        let snapshot = witness_snapshot::decode_snapshot(&bytes, &request).unwrap();
        assert_eq!(snapshot.identity().creation_attempt_id(), b(3));
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        let response = tauri::async_runtime::block_on(
            witness_mobile::test_adapter::dispatch(
                request,
                move |_| async move { Ok(value) },
                || true,
            )
            .receive(),
        )
        .unwrap();
        assert!(matches!(
            response,
            witness_mobile::MobileResponse::Snapshot(_)
        ));
    }
}
#[test]
fn kotlin_proof_is_sealed_and_real_software_signature_verifies_once() {
    let sealed = accept_prepared(context(), &read("kotlin_prepared.json"), 100).unwrap();
    assert_eq!(sealed.handle(), b(9));
    assert_eq!(sealed.signing_request().bytes(), read("kotlin_claim.bin"));
    let verified = accept_signed(&sealed, &read("kotlin_signed.json"), b(7), b(8), 101).unwrap();
    assert_eq!(verified.claim_bytes(), read("kotlin_claim.bin"));
    assert!(accept_signed(&sealed, &read("kotlin_signed.json"), b(7), b(8), 101).is_err());
}
#[test]
fn substituted_proof_bindings_and_closed_shape_are_negative_controls() {
    let prepared = read("kotlin_prepared.json");
    let signed = read("kotlin_signed.json");
    for field in ["operationId", "sessionDigest"] {
        assert!(accept_prepared(
            context(),
            &changed(&prepared, field, STANDARD.encode([42; 32]).into()),
            0
        )
        .is_err());
    }
    for field in [
        "freshValidatorNonce",
        "nativeRandomNonce",
        "nativeCallerSessionDigest",
    ] {
        let mut value: Value = serde_json::from_slice(&prepared).unwrap();
        value["claim"][field] = STANDARD.encode([42; 32]).into();
        assert!(accept_prepared(context(), &serde_json::to_vec(&value).unwrap(), 0).is_err());
    }
    for (field, value) in [
        ("extra", Value::Null),
        ("handle", Value::Null),
        ("status", "signed".into()),
        ("remainingMillis", 0.into()),
    ] {
        assert!(accept_prepared(context(), &changed(&prepared, field, value), 0).is_err());
    }
    for field in ["operationId", "sessionDigest", "handle"] {
        let sealed = accept_prepared(context(), &prepared, 0).unwrap();
        assert!(accept_signed(
            &sealed,
            &changed(&signed, field, STANDARD.encode([42; 32]).into()),
            b(7),
            b(8),
            1
        )
        .is_err());
    }
    for field in [
        "freshValidatorNonce",
        "nativeRandomNonce",
        "nativeCallerSessionDigest",
    ] {
        let sealed = accept_prepared(context(), &prepared, 0).unwrap();
        let mut value: Value = serde_json::from_slice(&signed).unwrap();
        value["claim"][field] = STANDARD.encode([42; 32]).into();
        assert!(
            accept_signed(&sealed, &serde_json::to_vec(&value).unwrap(), b(7), b(8), 1).is_err()
        );
    }
    for (field, value) in [
        ("signature", STANDARD.encode([0; 64]).into()),
        ("status", "prepared".into()),
        ("extra", Value::Null),
    ] {
        let sealed = accept_prepared(context(), &prepared, 0).unwrap();
        assert!(accept_signed(&sealed, &changed(&signed, field, value), b(7), b(8), 1).is_err());
    }
    let duplicate =
        String::from_utf8(prepared)
            .unwrap()
            .replacen('{', "{\"h\\u0061ndle\":null,", 1);
    assert!(accept_prepared(context(), duplicate.as_bytes(), 0).is_err());
}
#[test]
fn snapshot_null_phase_and_terminal_omission_are_negative_controls() {
    let bytes = read("kotlin_identity_prepared.json");
    let request = requests().remove(0);
    for (field, value) in [
        ("operationId", STANDARD.encode([42; 32]).into()),
        ("sessionDigest", STANDARD.encode([42; 32]).into()),
        ("eligible", true.into()),
        ("extra", Value::Null),
    ] {
        assert!(
            witness_snapshot::decode_snapshot(&changed(&bytes, field, value), &request).is_err()
        );
    }
    let mut v: Value = serde_json::from_slice(&bytes).unwrap();
    v["identity"]["phase"] = "generated_unvalidated".into();
    assert!(witness_snapshot::decode_snapshot(&serde_json::to_vec(&v).unwrap(), &request).is_err());
    for name in [
        "kotlin_missing.json",
        "kotlin_refused.json",
        "kotlin_cancelled.json",
    ] {
        assert!(decode_terminal_response(&read(name)).is_ok());
    }
    assert!(decode_terminal_response(&changed(
        &read("kotlin_missing.json"),
        "reason",
        Value::Null
    ))
    .is_err());
}

#[test]
fn snapshot_required_null_fields_cannot_be_omitted() {
    let bytes = read("kotlin_identity_prepared.json");
    let request = requests().remove(0);
    let mut wrongly_accepted_omissions = Vec::new();
    for field in ["metadata", "generationChallenge", "enrollment"] {
        let mut v: Value = serde_json::from_slice(&bytes).unwrap();
        if field == "enrollment" {
            v.as_object_mut().unwrap().remove(field);
        } else {
            v["identity"].as_object_mut().unwrap().remove(field);
        }
        if witness_snapshot::decode_snapshot(&serde_json::to_vec(&v).unwrap(), &request).is_ok() {
            wrongly_accepted_omissions.push(field);
        }
    }
    assert!(
        wrongly_accepted_omissions.is_empty(),
        "required nullable fields were accepted as absent: {wrongly_accepted_omissions:?}"
    );
}
