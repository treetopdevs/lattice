#[path = "../src/witness_bridge.rs"]
mod witness_bridge;
#[path = "../src/witness_public.rs"]
mod witness_public;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use tauri::ipc::InvokeBody;
use witness_public::*;

fn b(value: u8) -> String {
    STANDARD.encode([value; 32])
}

fn bytes(value: Value) -> InvokeBody {
    InvokeBody::Json(Value::Array(
        serde_json::to_vec(&value)
            .unwrap()
            .into_iter()
            .map(|byte| json!(byte))
            .collect(),
    ))
}

#[test]
fn exact_public_requests_decode_to_owned_internal_values() {
    assert_eq!(
        decode_public_request(WITNESS_IDENTITY, &InvokeBody::Json(json!({}))),
        Ok(PublicRequest::Identity)
    );

    assert_eq!(
        decode_public_request(
            WITNESS_PREPARE_CREATION,
            &bytes(json!({"replica":"replica:test","enrollmentId":b(1),"recipient":b(2)})),
        ),
        Ok(PublicRequest::Prepare(PreparePublicRequest {
            replica: "replica:test".into(),
            enrollment_id: witness_bridge::Bytes32([1; 32]),
            recipient: witness_bridge::Bytes32([2; 32]),
        }))
    );
    assert!(matches!(
        decode_public_request(
            WITNESS_GENERATE,
            &bytes(json!({"creationAttemptId":b(3),"generationChallenge":b(4)})),
        ),
        Ok(PublicRequest::Generate(_))
    ));
    assert!(matches!(
        decode_public_request(
            WITNESS_PROVE_BINDING,
            &bytes(
                json!({"replica":"r","enrollmentId":b(1),"recipient":b(2),"freshValidatorNonce":b(5)})
            ),
        ),
        Ok(PublicRequest::Proof(_))
    ));
    assert!(matches!(
        decode_public_request(WITNESS_CANCEL, &bytes(json!({"attemptId":b(6)}))),
        Ok(PublicRequest::Cancel(_))
    ));
}

#[test]
fn outer_invoke_body_is_exact_and_bounded() {
    for body in [
        InvokeBody::Raw(b"{}".to_vec()),
        InvokeBody::Json(json!("{}")),
        InvokeBody::Json(json!({})),
        InvokeBody::Json(json!([1.0])),
        InvokeBody::Json(json!([1.5])),
        InvokeBody::Json(json!([true])),
        InvokeBody::Json(json!([[1]])),
        InvokeBody::Json(json!([-1])),
        InvokeBody::Json(json!([256])),
    ] {
        assert_eq!(
            decode_public_request(WITNESS_CANCEL, &body),
            Err(PUBLIC_REQUEST_REFUSED)
        );
    }
    assert_eq!(
        decode_public_request(
            WITNESS_CANCEL,
            &InvokeBody::Json(Value::Array(vec![json!(0); MAX_PUBLIC_REQUEST + 1])),
        ),
        Err(PUBLIC_REQUEST_REFUSED)
    );
    assert_eq!(
        decode_public_request(WITNESS_IDENTITY, &InvokeBody::Json(json!({"x":1}))),
        Err(PUBLIC_REQUEST_REFUSED)
    );
    assert_eq!(
        decode_public_request(WITNESS_IDENTITY, &InvokeBody::Json(json!([]))),
        Err(PUBLIC_REQUEST_REFUSED)
    );

    let mut float_encoded_object = match bytes(json!({"attemptId":b(8)})) {
        InvokeBody::Json(Value::Array(values)) => values,
        _ => unreachable!(),
    };
    float_encoded_object[0] = json!(123.0);
    assert_eq!(
        decode_public_request(
            WITNESS_CANCEL,
            &InvokeBody::Json(Value::Array(float_encoded_object)),
        ),
        Err(PUBLIC_REQUEST_REFUSED)
    );

    let mut maximum = format!(r#"{{"attemptId":"{}"}}"#, b(8)).into_bytes();
    maximum.resize(MAX_PUBLIC_REQUEST, b' ');
    let maximum = InvokeBody::Json(Value::Array(
        maximum.into_iter().map(|value| json!(value)).collect(),
    ));
    assert!(decode_public_request(WITNESS_CANCEL, &maximum).is_ok());
}

#[test]
fn decoded_json_is_utf8_closed_and_canonical() {
    let valid = format!(r#"{{"attemptId":"{}"}}"#, b(7));
    let cases = [
        valid
            .replacen("}", &format!(r#","attemptId":"{}"}}"#, b(7)), 1)
            .into_bytes(),
        valid.replacen("}", ",\"extra\":true}", 1).into_bytes(),
        format!(r#"{{"attemptId":7}}"#).into_bytes(),
        format!(r#"["{}"]"#, b(7)).into_bytes(),
        format!(r#"{{"attemptId":"{}"}} true"#, b(7)).into_bytes(),
        format!(r#"{{"attemptId":"{}"}}"#, b(7).trim_end_matches('=')).into_bytes(),
        vec![0xff],
        Vec::new(),
    ];
    for (index, invalid) in cases.into_iter().enumerate() {
        let body = InvokeBody::Json(Value::Array(
            invalid.into_iter().map(|v| json!(v)).collect(),
        ));
        assert_eq!(
            decode_public_request(WITNESS_CANCEL, &body),
            Err(PUBLIC_REQUEST_REFUSED),
            "case {index}"
        );
    }
}

#[test]
fn command_specific_fields_and_replica_bounds_are_closed() {
    let prepare =
        |replica: &str| bytes(json!({"replica":replica,"enrollmentId":b(1),"recipient":b(2)}));
    for replica in ["", &"r".repeat(513)] {
        assert_eq!(
            decode_public_request(WITNESS_PREPARE_CREATION, &prepare(replica)),
            Err(PUBLIC_REQUEST_REFUSED)
        );
    }
    assert!(decode_public_request(WITNESS_PREPARE_CREATION, &prepare(&"é".repeat(256))).is_ok());

    let forbidden = bytes(json!({
        "creationAttemptId":b(3), "generationChallenge":b(4), "sessionDigest":b(9)
    }));
    assert_eq!(
        decode_public_request(WITNESS_GENERATE, &forbidden),
        Err(PUBLIC_REQUEST_REFUSED)
    );
    assert_eq!(
        decode_public_request("treehouse_open", &bytes(json!({"attemptId":b(1)}))),
        Err(PUBLIC_REQUEST_REFUSED)
    );
}
