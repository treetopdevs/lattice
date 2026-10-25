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
