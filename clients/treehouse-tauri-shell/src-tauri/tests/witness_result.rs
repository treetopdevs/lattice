#[path = "../src/witness_binding.rs"]
mod witness_binding;
#[path = "../src/witness_bridge.rs"]
mod witness_bridge;
#[path = "../src/witness_result.rs"]
mod witness_result;
#[path = "../src/witness_reviewed.rs"]
mod witness_reviewed;
#[path = "../src/witness_snapshot.rs"]
mod witness_snapshot;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use witness_bridge::*;
use witness_result::*;
use witness_reviewed::*;
use witness_snapshot::{decode_snapshot, SnapshotResponse};
fn b(v: u8) -> String {
    STANDARD.encode([v; 32])
}
fn key() -> SigningKey {
    SigningKey::from_bytes(&[11; 32])
}
fn public() -> String {
    STANDARD.encode(key().verifying_key().to_bytes())
}
fn original(phase: &str) -> Value {
    let metadata = json!({"publicKey":public(),"spki":STANDARD.encode([vec![0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0],key().verifying_key().to_bytes().to_vec()].concat()),"appSignerSha256":b(12),"creationVersionCode":"9223372036854775807","certificateChain":[STANDARD.encode([1,2,3]),STANDARD.encode([4,5,6])]});
    json!({"creationAttemptId":b(3),"phase":phase,"generationChallenge":if phase=="prepared"{Value::Null}else{b(4).into()},"metadata":if phase=="generated_unvalidated"{metadata}else{Value::Null},"revision":"9"})
}
fn envelope(identity: Value, kind: &str) -> Value {
    json!({"protocol":PRIVATE_PROTOCOL,"kind":kind,"operationId":b(7),"sessionDigest":b(8),"status":"snapshot","eligible":false,"identity":identity,"enrollment":if kind=="prepare"{json!({"replica":"line\n\"é😀","enrollmentId":b(1),"recipient":b(2),"creationAttemptId":b(3)})}else{Value::Null}})
}
fn snapshot(identity: Value, kind: &str) -> SnapshotResponse {
    let request = match kind {
        "prepare" => PrivateRequest::Prepare(PrepareRequest {
            protocol: (),
            operation_id: Bytes32([7; 32]),
            session_digest: Bytes32([8; 32]),
            replica: "line\n\"é😀".into(),
            enrollment_id: Bytes32([1; 32]),
            recipient: Bytes32([2; 32]),
            creation_attempt_id: Bytes32([3; 32]),
        }),
        "generate" => PrivateRequest::Generate(GenerateRequest {
            protocol: (),
            operation_id: Bytes32([7; 32]),
            session_digest: Bytes32([8; 32]),
            expected_revision: Revision(7),
            creation_attempt_id: Bytes32([3; 32]),
            generation_challenge: Bytes32([4; 32]),
        }),
        _ => PrivateRequest::Identity(IdentityRequest {
            protocol: (),
            operation_id: Bytes32([7; 32]),
            session_digest: Bytes32([8; 32]),
        }),
    };
    decode_snapshot(
        &serde_json::to_vec(&envelope(identity, kind)).unwrap(),
        &request,
    )
    .unwrap()
}
fn verified() -> VerifiedBinding {
    let digest: [u8; 32] = Sha256::digest([4; 32]).into();
    let context = ReviewedBindingContext::from_native_review(
        Bytes32([7; 32]),
        Bytes32([8; 32]),
        "line\n\"é😀".into(),
        Bytes32([1; 32]),
        Bytes32([2; 32]),
        Bytes32([5; 32]),
        Bytes32([3; 32]),
        Bytes32(key().verifying_key().to_bytes()),
        Bytes32(digest),
        Bytes32([6; 32]),
    )
    .unwrap();
    let claim = json!({"replica":"line\n\"é😀","enrollmentId":b(1),"recipient":b(2),"creationAttemptId":b(3),"actualWitnessPublicKey":public(),"generationChallengeDigest":STANDARD.encode(digest),"freshValidatorNonce":b(5),"nativeRandomNonce":b(6),"nativeCallerSessionDigest":b(8)});
    let prepared = json!({"protocol":PRIVATE_PROTOCOL,"kind":"proof","operationId":b(7),"sessionDigest":b(8),"status":"prepared","handle":b(9),"claim":claim,"remainingMillis":60_000});
    let sealed = accept_prepared(context, &serde_json::to_vec(&prepared).unwrap(), 0).unwrap();
    let signature = key().sign(sealed.signing_request().bytes());
    let signed = json!({"protocol":PRIVATE_PROTOCOL,"kind":"proof","operationId":b(7),"sessionDigest":b(8),"status":"signed","handle":b(9),"claim":claim,"signature":STANDARD.encode(signature.to_bytes())});
    accept_signed(
        &sealed,
        &serde_json::to_vec(&signed).unwrap(),
        Bytes32([7; 32]),
        Bytes32([8; 32]),
        1,
    )
    .unwrap()
}
fn value(bytes: Result<Vec<u8>, &str>) -> Value {
    serde_json::from_slice(&bytes.unwrap()).unwrap()
}
#[test]
fn incomplete_identity_and_exact_versioned_result_shapes() {
    for phase in ["prepared", "generation_started", "generated_unvalidated"] {
        let record = original(phase);
        let snap = snapshot(record.clone(), "identity");
        assert_eq!(
            value(encode_identity(&snap)),
            json!({"version":1,"status":if phase=="generated_unvalidated"{"identity"}else{"incomplete"},"eligible":false,"identity":record})
        );
    }
    let record = original("prepared");
    let snap = snapshot(record.clone(), "prepare");
    assert_eq!(
        value(encode_prepare(&snap)),
        json!({"version":1,"status":"prepared","eligible":false,"identity":record,"enrollment":envelope(original("prepared"),"prepare")["enrollment"]})
    );
    assert_eq!(
        value(encode_generate(&snapshot(
            original("generated_unvalidated"),
            "generate"
        ))),
        json!({"version":1,"status":"generated_unvalidated","eligible":false,"identity":original("generated_unvalidated")})
    );
    assert_eq!(
        value(encode_missing()),
        json!({"version":1,"status":"missing"})
    );
    assert_eq!(
        value(encode_cancelled()),
        json!({"version":1,"status":"cancelled"})
    );
}
#[test]
fn public_software_signature_projection_retains_exact_claim_and_original_chain() {
    let verified = verified();
    let bytes = encode_proof(
        &verified,
        &snapshot(original("generated_unvalidated"), "identity"),
    )
    .unwrap();
    assert!(bytes.len() <= 131072);
    let result: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(result.as_object().unwrap().len(), 5);
    assert_eq!(result["version"], 1);
    assert_eq!(result["status"], "signed");
    assert_eq!(result["eligible"], false);
    assert_eq!(result["identity"], original("generated_unvalidated"));
    assert_eq!(result["binding"].as_object().unwrap().len(), 2);
    let claim = &result["binding"]["claim"];
    assert_eq!(claim.as_object().unwrap().len(), 13);
    assert_eq!(claim["domain"], "lattice-witness-binding-challenge-v1");
    assert_eq!(claim["version"], 1);
    assert_eq!(claim["product"], "treehouse");
    assert_eq!(claim["appId"], "dev.treetop.lattice.treehouse");
    assert_eq!(*claim, verified.claim().public_projection());
    let mut raw = claim.clone();
    for field in ["domain", "version", "product", "appId"] {
        raw.as_object_mut().unwrap().remove(field);
    }
    let reconstructed = witness_binding::BindingClaim::from_public_json(&raw.to_string()).unwrap();
    assert_eq!(reconstructed.canonical_bytes(), verified.claim_bytes());
    let signature: [u8; 64] = STANDARD
        .decode(result["binding"]["signature"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    key()
        .verifying_key()
        .verify_strict(
            &reconstructed.canonical_bytes(),
            &Signature::from_bytes(&signature),
        )
        .unwrap();
    assert!(!String::from_utf8(bytes).unwrap().contains("handle"));
}
#[test]
fn mismatched_original_attempt_key_challenge_and_incomplete_proof_refuse() {
    let verified = verified();
    for field in ["creationAttemptId", "generationChallenge", "key"] {
        let mut record = original("generated_unvalidated");
        if field == "key" {
            let key = SigningKey::from_bytes(&[42; 32]).verifying_key().to_bytes();
            record["metadata"]["publicKey"] = STANDARD.encode(key).into();
            record["metadata"]["spki"] = STANDARD
                .encode(
                    [
                        vec![
                            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0,
                        ],
                        key.to_vec(),
                    ]
                    .concat(),
                )
                .into();
        } else {
            record[field] = b(42).into();
        }
        assert_eq!(
            encode_proof(&verified, &snapshot(record, "identity")),
            Err(PUBLIC_RESULT_REFUSED)
        );
    }
    for phase in ["prepared", "generation_started"] {
        let snap = snapshot(original(phase), "identity");
        assert_eq!(encode_proof(&verified, &snap), Err(PUBLIC_RESULT_REFUSED));
        assert_eq!(encode_generate(&snap), Err(PUBLIC_RESULT_REFUSED));
    }
    assert_eq!(
        encode_prepare(&snapshot(original("prepared"), "identity")),
        Err(PUBLIC_RESULT_REFUSED)
    );
}
#[test]
fn malformed_metadata_is_never_exported_even_from_unvalidated_deserialization() {
    // SnapshotResponse's Deserialize is crate-visible, so projection also checks semantic metadata.
    for field in ["spki", "certificateChain"] {
        let mut raw = envelope(original("generated_unvalidated"), "identity");
        raw["identity"]["metadata"][field] = if field == "spki" {
            STANDARD.encode([0; 44]).into()
        } else {
            json!([])
        };
        if field == "certificateChain" {
            assert!(serde_json::from_value::<SnapshotResponse>(raw).is_err());
            continue;
        }
        let snap: SnapshotResponse = serde_json::from_value(raw).unwrap();
        assert_eq!(encode_identity(&snap), Err(PUBLIC_RESULT_REFUSED));
        assert_eq!(encode_proof(&verified(), &snap), Err(PUBLIC_RESULT_REFUSED));
    }
}

#[test]
fn largest_original_chain_is_preserved_within_actual_public_envelope_limit() {
    let mut identity = original("generated_unvalidated");
    identity["metadata"]["certificateChain"] = json!(vec![STANDARD.encode(vec![255; 16384]); 4]);
    let snapshot = snapshot(identity.clone(), "identity");
    let encoded = encode_proof(&verified(), &snapshot).unwrap();
    assert!(encoded.len() > 87000 && encoded.len() <= 131072);
    let decoded: Value = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(decoded["identity"], identity);
}
