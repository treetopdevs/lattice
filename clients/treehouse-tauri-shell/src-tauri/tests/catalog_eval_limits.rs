use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use treehouse_tauri_shell::catalog_eval::{
    canonical::{decode, encode, Term, MAX_BYTES, MAX_NODES},
    envelope, frame,
};

fn fixture() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../lattice-client/test/vectors/catalog/rust_codec.json"
    )))
    .unwrap()
}
fn field<'a>(record: &'a mut Value, name: &str) -> &'a mut Value {
    &mut record[1]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|pair| pair[0] == json!(["atom", name]))
        .unwrap()[1]
}
fn text(value: &str) -> Value {
    json!(["bin", STANDARD.encode(value.as_bytes())])
}
fn signed(catalog: Value) -> (Vec<u8>, [u8; 32]) {
    let signer = SigningKey::from_bytes(&[42; 32]);
    let bytes = encode(&Term::List(vec![
        Term::Binary(b"lattice-treehouse-transport-catalog-v1".to_vec()),
        Term::from_carrier(&catalog).unwrap(),
    ]))
    .unwrap();
    let envelope = json!([
        "map",
        [
            [["atom", "catalog"], catalog],
            [
                ["atom", "signature"],
                ["bin", STANDARD.encode(signer.sign(&bytes).to_bytes())]
            ]
        ]
    ]);
    (
        serde_json::to_vec(&envelope).unwrap(),
        signer.verifying_key().to_bytes(),
    )
}

#[test]
fn correctly_signed_malformed_catalogs_refuse_each_closed_record_constraint() {
    let mut f = fixture();
    let good = field(&mut f["catalog_envelope_term"], "catalog").clone();
    let mut malformed = Vec::new();
    for (key, value) in [
        ("version", json!(["int", 2])),
        ("product", json!(["atom", "township"])),
        ("space", text("")),
        ("bootstrap", text("wrong")),
        ("binding", text("wrong")),
        ("revision", json!(["int", "18446744073709551615"])),
        ("previous", json!(["nil"])),
        ("entries", json!(["list", []])),
    ] {
        let mut changed = good.clone();
        *field(&mut changed, key) = value;
        malformed.push(changed);
    }
    for (key, value) in [
        ("product", json!(["atom", "township"])),
        ("replica", json!(["bin", "/w=="])),
        ("kind", json!(["atom", "bogus"])),
        ("schema", json!(["atom", "treehouse_thread_v1"])),
        ("root", json!(["bin", STANDARD.encode([0; 31])])),
        ("genesis", text("bad")),
        ("creation", text("bad")),
        ("reference", text("bad")),
        ("route", text("/r/../x")),
        ("service_id", text("bad")),
        ("service_key", json!(["bin", STANDARD.encode([0; 33])])),
    ] {
        let mut changed = good.clone();
        let entries = field(&mut changed, "entries");
        *field(&mut entries[1][0], key) = value;
        malformed.push(changed);
    }
    let mut wrong_bootstrap = good.clone();
    *field(&mut wrong_bootstrap, "bootstrap") = text(&"A".repeat(43));
    malformed.push(wrong_bootstrap);
    let mut zero_revision = good.clone();
    *field(&mut zero_revision, "revision") = json!(["int", 0]);
    malformed.push(zero_revision);
    for fault in [
        "duplicate_route",
        "service_id",
        "service_key",
        "two_spaces",
        "unsorted",
        "too_many",
    ] {
        let mut changed = good.clone();
        let entries = field(&mut changed, "entries");
        let mut child = entries[1][0].clone();
        *field(&mut child, "replica") = text("treehouse:thread:rust-native-codec");
        *field(&mut child, "kind") = json!(["atom", "thread"]);
        *field(&mut child, "schema") = json!(["atom", "treehouse_thread_v1"]);
        if fault != "duplicate_route" {
            *field(&mut child, "route") = text(&format!("/r/{}", "A".repeat(43)));
        }
        match fault {
            "service_id" => *field(&mut child, "service_id") = text(&"A".repeat(43)),
            "service_key" => {
                *field(&mut child, "service_key") = json!(["bin", STANDARD.encode([0; 32])])
            }
            "two_spaces" => {
                *field(&mut child, "kind") = json!(["atom", "space"]);
                *field(&mut child, "schema") = json!(["atom", "treehouse_space_v1"]);
            }
            _ => {}
        }
        entries[1].as_array_mut().unwrap().push(child);
        if fault == "unsorted" {
            entries[1].as_array_mut().unwrap().reverse();
        }
        if fault == "too_many" {
            let child = entries[1][1].clone();
            while entries[1].as_array().unwrap().len() < 14 {
                entries[1].as_array_mut().unwrap().push(child.clone());
            }
        }
        malformed.push(changed);
    }
    let mut extra = good.clone();
    extra[1]
        .as_array_mut()
        .unwrap()
        .push(json!([["atom", "extra"], ["nil"]]));
    malformed.push(extra);
    let mut missing = good.clone();
    missing[1].as_array_mut().unwrap().pop();
    malformed.push(missing);
    for (index, catalog) in malformed.into_iter().enumerate() {
        let (bytes, key) = signed(catalog);
        assert!(
            envelope::verify(&bytes, &key).is_err(),
            "signed malformed case {index}"
        );
    }
}

#[test]
fn exact_artifact_frame_and_canonical_limits_have_positive_and_negative_sides() {
    let f = fixture();
    let key = STANDARD
        .decode(f["expected_catalog_key"].as_str().unwrap())
        .unwrap();
    let mut artifact = serde_json::to_vec(&f["catalog_envelope_term"]).unwrap();
    artifact.resize(MAX_BYTES, b' ');
    assert!(envelope::verify(&artifact, &key).is_ok());
    artifact.push(b' ');
    assert!(envelope::verify(&artifact, &key).is_err());
    let mut raw = serde_json::to_vec(&f["frame"]).unwrap();
    raw.resize(frame::MAX_FRAME_BYTES, b' ');
    assert!(frame::verify(&raw).is_ok());
    raw.push(b' ');
    assert!(frame::verify(&raw).is_err());
    let exact = Term::Binary(vec![0; MAX_BYTES - 5]);
    let bytes = encode(&exact).unwrap();
    assert_eq!(bytes.len(), MAX_BYTES);
    assert!(decode(&bytes).is_ok());
    assert!(encode(&Term::Binary(vec![0; MAX_BYTES - 4])).is_err());
    let exact = Term::List(vec![Term::Nil; MAX_NODES - 1]);
    let bytes = encode(&exact).unwrap();
    assert!(decode(&bytes).is_ok());
    assert!(encode(&Term::List(vec![Term::Nil; MAX_NODES])).is_err());
    let too_many = [vec![0x99, 0x80, 0x00], vec![0xf6; MAX_NODES]].concat();
    assert!(decode(&too_many).is_err());
}

#[test]
fn frame_metadata_and_weak_key_cannot_bypass_authenticity_boundary() {
    let f = fixture();
    for (key, value) in [("v", json!(2)), ("extra", json!(true))] {
        let mut raw = f["frame"].clone();
        raw[key] = value;
        assert!(frame::verify(&serde_json::to_vec(&raw).unwrap()).is_err());
    }
    let mut key = [0; 32];
    key[0] = 1;
    let payload = encode(&Term::List(vec![
        Term::Binary(b"lattice-op-v2".to_vec()),
        Term::Binary(b"replica".to_vec()),
        Term::Binary(key.to_vec()),
        Term::List(vec![]),
        Term::Atom("command".into()),
        Term::Nil,
        Term::Nil,
    ]))
    .unwrap();
    use sha2::{Digest, Sha256};
    let mut signature = [0; 64];
    signature[0] = 1;
    let raw = json!({"v":1,"id":URL_SAFE_NO_PAD.encode(Sha256::digest(payload)),"replica":"replica","author":STANDARD.encode(key),"deps":[],"kind":"command","body":["nil"],"cap":["nil"],"sig":STANDARD.encode(signature)});
    assert!(frame::verify(&serde_json::to_vec(&raw).unwrap()).is_err());
}
