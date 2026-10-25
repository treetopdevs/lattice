use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use treehouse_tauri_shell::catalog_eval::canonical::{decode, encode, Term};

fn vectors(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../lattice-client/test/vectors/treehouse_catalog")
        .join(name);
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn existing_beam_and_ts_catalog_signing_bytes_agree_with_native_encoder() {
    for name in ["beam_codec.json", "ts_codec.json"] {
        let fixture = vectors(name);
        let envelope = Term::from_carrier(&fixture["catalog_envelope_term"]).unwrap();
        let catalog = envelope.atom_field("catalog").unwrap().clone();
        let term = Term::List(vec![
            Term::Binary(b"lattice-treehouse-transport-catalog-v1".to_vec()),
            catalog,
        ]);
        assert_eq!(
            STANDARD.encode(encode(&term).unwrap()),
            fixture["catalog_bytes"],
            "{name}"
        );
    }
}

#[test]
fn integer_boundaries_and_encoded_key_collisions_are_closed() {
    assert_eq!(
        encode(&Term::from_carrier(&json!(["int", "18446744073709551615"])).unwrap()).unwrap(),
        [vec![0x1b], u64::MAX.to_be_bytes().to_vec()].concat()
    );
    for value in [
        json!(["int", -1]),
        json!(["int", 1.5]),
        json!(["int", 9007199254740992u64]),
        json!(["int", "01"]),
        json!(["int", "18446744073709551616"]),
        json!(["nil", 0]),
        json!(["map", [[["int", 1], ["nil"]], [["int", "1"], ["nil"]]]]),
        json!(["mapset", [["int", 1], ["int", "1"]]]),
    ] {
        assert!(
            Term::from_carrier(&value)
                .and_then(|term| encode(&term))
                .is_err(),
            "{value}"
        );
    }
}

#[test]
fn canonical_reader_refuses_aliases_trailing_data_and_unbounded_lengths() {
    for value in [
        Term::Nil,
        Term::Bool(true),
        Term::Integer(u64::MAX),
        Term::Atom("Unicode:雪".into()),
        Term::Tuple(vec![Term::Nil]),
        Term::Set(vec![Term::Integer(3), Term::Integer(1)]),
    ] {
        let bytes = encode(&value).unwrap();
        assert_eq!(encode(&decode(&bytes).unwrap()).unwrap(), bytes);
    }
    for bytes in [
        vec![0x18, 0],
        vec![0xf6, 0xf6],
        vec![0x9f, 0xff],
        vec![0x20],
        vec![0x1b, 0xff],
        vec![0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        vec![0xd9, 0xea, 0x60, 0x41, 0xff],
        vec![0xf9, 0, 0],
    ] {
        assert!(decode(&bytes).is_err(), "{bytes:?}");
    }
}

#[test]
fn artifact_json_rejects_duplicate_decoded_names_and_oversized_or_lossy_input() {
    use treehouse_tauri_shell::catalog_eval::json::parse;
    for text in [
        r#"{"catalog":1,"catalog":2}"#,
        r#"{"x":{"v":1,"\u0076":2}}"#,
        r#"["bin","\ud800"]"#,
        "1.5",
        "-1",
        "{}{}",
    ] {
        assert!(parse(text.as_bytes()).is_err(), "{text}");
    }
    assert!(parse(&vec![b' '; 128 * 1024 + 1]).is_err());
    assert_eq!(
        parse(r#"{"x":[1,true,null,"雪"]}"#.as_bytes()).unwrap(),
        json!({"x":[1,true,null,"雪"]})
    );
}

#[test]
fn actual_ts_signed_catalog_histories_authenticate_without_an_authority_verdict() {
    use treehouse_tauri_shell::catalog_eval::frame::verify;
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../lattice-client/test/vectors/catalog/ts_trust.json"
    )))
    .unwrap();
    let mut count = 0;
    for history in fixture["histories"].as_array().unwrap() {
        for frame in history["frames"].as_array().unwrap() {
            let authentic = verify(&serde_json::to_vec(frame).unwrap()).unwrap();
            assert_eq!(authentic.id(), frame["id"].as_str().unwrap());
            assert_eq!(authentic.replica(), history["replica"].as_str().unwrap());
            for field in [
                "id", "replica", "author", "deps", "kind", "body", "cap", "sig",
            ] {
                let mut changed = frame.clone();
                changed[field] = match field {
                    "body" | "cap" => json!(["bin", "dGFtcGVy"]),
                    "deps" => json!(["A".repeat(43)]),
                    "kind" => json!("tombstone"),
                    _ => json!("changed"),
                };
                if changed != *frame {
                    assert!(
                        verify(&serde_json::to_vec(&changed).unwrap()).is_err(),
                        "{field}"
                    );
                }
            }
            count += 1;
        }
    }
    assert_eq!(count, 8, "all Space and Thread frames in this fixture");
}

#[test]
fn real_beam_and_ts_catalog_envelopes_verify_under_only_the_supplied_key() {
    use treehouse_tauri_shell::catalog_eval::envelope::{public_key, verify};
    for name in ["beam_codec.json", "ts_codec.json"] {
        let fixture = vectors(name);
        let key = public_key(fixture["expected_catalog_key"].as_str().unwrap()).unwrap();
        let bytes = serde_json::to_vec(&fixture["catalog_envelope_term"]).unwrap();
        let verified = verify(&bytes, &key).unwrap();
        assert_eq!(verified.id(), fixture["catalog_id"].as_str().unwrap());
        assert_eq!(
            STANDARD.encode(verified.signing_bytes()),
            fixture["catalog_bytes"]
        );
        let mut wrong_key = key.clone();
        wrong_key[0] ^= 1;
        assert!(verify(&bytes, &wrong_key).is_err());
        assert!(verify(&bytes, &key[..31]).is_err());
        let mut extra = fixture["catalog_envelope_term"].clone();
        extra[1]
            .as_array_mut()
            .unwrap()
            .push(json!([["atom", "unexpected"], ["nil"]]));
        assert!(verify(&serde_json::to_vec(&extra).unwrap(), &key).is_err());
        let mut duplicated = fixture["catalog_envelope_term"].clone();
        let first = duplicated[1][0].clone();
        duplicated[1].as_array_mut().unwrap().push(first);
        assert!(verify(&serde_json::to_vec(&duplicated).unwrap(), &key).is_err());
    }
}

#[test]
fn delegation_decode_and_public_encode_reject_wrong_shapes_and_noncanonical_names() {
    let good = vec![
        Term::Binary(b"id".to_vec()),
        Term::Binary(b"replica".to_vec()),
        Term::Binary(vec![0; 32]),
        Term::Binary(vec![1; 32]),
        Term::Nil,
        Term::List(vec![Term::Atom("post".into())]),
        Term::List(vec![]),
        Term::Bool(true),
        Term::Binary(vec![2; 64]),
    ];
    for leased in [false, true] {
        let mut fields = good.clone();
        if leased {
            fields.push(Term::Integer(7));
        }
        let bytes = encode(&Term::Delegation(fields)).unwrap();
        assert_eq!(encode(&decode(&bytes).unwrap()).unwrap(), bytes);
    }
    let mut malformed = vec![vec![Term::Nil; 9]];
    for (index, wrong) in [
        (0, Term::Nil),
        (1, Term::Binary(vec![255])),
        (2, Term::Binary(vec![0; 31])),
        (3, Term::Binary(vec![0; 33])),
        (4, Term::Bool(false)),
        (
            5,
            Term::List(vec![Term::Atom("post".into()), Term::Atom("post".into())]),
        ),
        (
            6,
            Term::List(vec![Term::Atom("z".into()), Term::Atom("a".into())]),
        ),
        (7, Term::Nil),
        (8, Term::Binary(vec![0; 63])),
    ] {
        let mut fields = good.clone();
        fields[index] = wrong;
        malformed.push(fields);
    }
    for lease in [Term::Nil, Term::Integer(u64::MAX)] {
        let mut fields = good.clone();
        fields.push(lease);
        malformed.push(fields);
    }
    for fields in malformed {
        assert!(encode(&Term::Delegation(fields.clone())).is_err());
        let raw = [vec![0xd9, 0xea, 0x63], encode(&Term::List(fields)).unwrap()].concat();
        assert!(decode(&raw).is_err());
    }
}

#[test]
fn exact_json_node_and_term_depth_limits_are_enforced_before_acceptance() {
    use treehouse_tauri_shell::catalog_eval::{
        canonical::{MAX_DEPTH, MAX_NODES},
        json::parse,
    };
    let within = serde_json::to_vec(&vec![0; MAX_NODES - 1]).unwrap();
    assert!(parse(&within).is_ok());
    let over = serde_json::to_vec(&vec![0; MAX_NODES]).unwrap();
    assert!(parse(&over).is_err());
    assert!(parse(&serde_json::to_vec(&vec![0; 40_000]).unwrap()).is_err());
    let mut term = Term::Nil;
    let mut carrier = json!(["nil"]);
    for _ in 0..MAX_DEPTH {
        term = Term::List(vec![term]);
        carrier = json!(["list", [carrier]]);
    }
    let bytes = encode(&term).unwrap();
    assert!(decode(&bytes).is_ok());
    assert!(Term::from_carrier(&parse(&serde_json::to_vec(&carrier).unwrap()).unwrap()).is_ok());
    assert!(encode(&Term::List(vec![term])).is_err());
    assert!(Term::from_carrier(&json!(["list", [carrier]])).is_err());
}
