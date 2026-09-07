#[path = "../src/witness_bridge.rs"]
mod witness_bridge;
use witness_bridge::*;

fn b(v: u8) -> String {
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [v; 32])
}

#[test]
fn closed_generate_and_owned_cancel_decode() {
    let generate = format!(
        r#"{{"kind":"generate","protocol":"{PRIVATE_PROTOCOL}","operationId":"{}","sessionDigest":"{}","expectedRevision":"7","creationAttemptId":"{}","generationChallenge":"{}"}}"#,
        b(1),
        b(2),
        b(3),
        b(4)
    );
    assert!(matches!(
        decode_request(generate.as_bytes()),
        Ok(PrivateRequest::Generate(_))
    ));
    let cancel = format!(
        r#"{{"kind":"cancel","protocol":"{PRIVATE_PROTOCOL}","operationId":"{}","sessionDigest":"{}","targetOperationId":"{}"}}"#,
        b(1),
        b(2),
        b(5)
    );
    assert!(matches!(
        decode_request(cancel.as_bytes()),
        Ok(PrivateRequest::Cancel(_))
    ));
}

#[test]
fn duplicate_extra_wrong_types_noncanonical_and_bounds_refuse() {
    let base = format!(
        r#"{{"kind":"identity","protocol":"{PRIVATE_PROTOCOL}","operationId":"{}","sessionDigest":"{}"}}"#,
        b(1),
        b(2)
    );
    for bad in [
        base.replacen("\"operationId\"", "\"extra\":true,\"operationId\"", 1),
        base.replacen(
            "\"operationId\"",
            "\"operationId\":\"{}\",\"operationId\"",
            1,
        ),
        base.replace(&format!("\"{}\"", b(1)), "7"),
        base.replace(&b(1), &b(1).replace('=', "")),
    ] {
        assert_eq!(
            decode_request(bad.as_bytes()),
            Err("invalid_private_request")
        );
    }
    assert_eq!(
        decode_request(&vec![b'x'; MAX_PRIVATE_MESSAGE + 1]),
        Err("invalid_private_request")
    );
    assert_eq!(decode_request(&[0xff]), Err("invalid_private_request"));
}

#[test]
fn revisions_and_replica_are_canonical_and_bounded() {
    let template = |revision: &str, replica: &str| {
        format!(
            r#"{{"kind":"proof","protocol":"{PRIVATE_PROTOCOL}","operationId":"{}","sessionDigest":"{}","expectedRevision":"{revision}","replica":"{replica}","enrollmentId":"{}","recipient":"{}","freshValidatorNonce":"{}"}}"#,
            b(1),
            b(2),
            b(3),
            b(4),
            b(5)
        )
    };
    assert!(decode_request(template("9223372036854775807", "r").as_bytes()).is_ok());
    for (revision, replica) in [
        ("0", "r"),
        ("01", "r"),
        ("9223372036854775808", "r"),
        ("1", ""),
    ] {
        assert!(decode_request(template(revision, replica).as_bytes()).is_err());
    }
    assert!(decode_request(template("1", &"é".repeat(257)).as_bytes()).is_err());
}

#[test]
fn session_vector_is_stable() {
    assert_eq!(
        base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            session_digest(Bytes32([1; 32]), Bytes32([2; 32])).0
        ),
        "+B2fiDqLxK9o9j2jlmOX6x5qPkg4Aj8eLsDRiGIe3po="
    );
}

#[test]
fn terminal_responses_are_closed_and_reason_bounded() {
    let response =
        TerminalResponse::refused(ResponseKind::Generate, Bytes32([1; 32]), "storage_busy")
            .unwrap();
    let encoded = encode_terminal_response(&response).unwrap();
    assert_eq!(decode_terminal_response(&encoded), Ok(response));
    assert!(
        TerminalResponse::refused(ResponseKind::Proof, Bytes32([1; 32]), "Bad reason").is_err()
    );
    assert!(TerminalResponse::terminal(
        ResponseKind::Identity,
        Bytes32([1; 32]),
        TerminalStatus::Missing
    )
    .is_ok());
    let surplus = String::from_utf8(encoded)
        .unwrap()
        .replacen("{", "{\"extra\":true,", 1);
    assert!(decode_terminal_response(surplus.as_bytes()).is_err());
    let explicit_null = format!(
        r#"{{"protocol":"{PRIVATE_PROTOCOL}","kind":"identity","operationId":"{}","status":"missing","reason":null}}"#,
        b(1)
    );
    assert!(decode_terminal_response(explicit_null.as_bytes()).is_err());
}

#[test]
fn encoding_revalidates_constructed_values_and_escaped_replica_round_trips() {
    let valid = PrivateRequest::Prepare(PrepareRequest {
        protocol: (),
        operation_id: Bytes32([1; 32]),
        session_digest: Bytes32([2; 32]),
        replica: "line\n\"é".into(),
        enrollment_id: Bytes32([3; 32]),
        recipient: Bytes32([4; 32]),
        creation_attempt_id: Bytes32([5; 32]),
    });
    assert_eq!(
        decode_request(&encode_request(&valid).unwrap()).unwrap(),
        valid
    );
    let invalid = PrivateRequest::Generate(GenerateRequest {
        protocol: (),
        operation_id: Bytes32([1; 32]),
        session_digest: Bytes32([2; 32]),
        expected_revision: Revision(-1),
        creation_attempt_id: Bytes32([3; 32]),
        generation_challenge: Bytes32([4; 32]),
    });
    assert!(encode_request(&invalid).is_err());
}
