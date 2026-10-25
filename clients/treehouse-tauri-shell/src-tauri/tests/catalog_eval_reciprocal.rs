//! Execute both real peer runtimes. Missing prerequisites fail, never substitute saved verdicts.
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
#[path = "support/catalog_codec_peer.rs"]
mod codec_peer;
use codec_peer::peer;
use treehouse_tauri_shell::catalog_eval::{
    canonical::{encode, Term},
    envelope, frame,
};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}
fn text(value: &str) -> Value {
    json!(["bin", STANDARD.encode(value.as_bytes())])
}
fn id(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}
fn record(fields: Vec<(&str, Value)>) -> Value {
    json!([
        "map",
        fields
            .into_iter()
            .map(|(key, value)| json!([["atom", key], value]))
            .collect::<Vec<_>>()
    ])
}
fn bytes(term: &Value) -> Vec<u8> {
    encode(&Term::from_carrier(term).unwrap()).unwrap()
}

fn rust_fixture() -> Value {
    // Disposable synthetic codec metadata, never an installation or authority claim.
    let signer = SigningKey::from_bytes(&[42; 32]);
    let public = signer.verifying_key().to_bytes();
    let service = SigningKey::from_bytes(&[17; 32]).verifying_key().to_bytes();
    let space = "treehouse:space:rust-native-codec";
    let bootstrap = id("rust-bootstrap");
    let entry = record(vec![
        ("product", json!(["atom", "treehouse"])),
        ("replica", text(space)),
        ("kind", json!(["atom", "space"])),
        ("schema", json!(["atom", "treehouse_space_v1"])),
        ("root", json!(["bin", STANDARD.encode(public)])),
        ("genesis", text(&id("rust-genesis"))),
        ("creation", text(&id("rust-creation"))),
        ("reference", text(&bootstrap)),
        ("route", text(&format!("/r/{}", id("rust-route")))),
        ("service_id", text(&id("rust-service"))),
        ("service_key", json!(["bin", STANDARD.encode(service)])),
    ]);
    let catalog = record(vec![
        ("version", json!(["int", 1])),
        ("product", json!(["atom", "treehouse"])),
        ("space", text(space)),
        ("bootstrap", text(&bootstrap)),
        ("binding", text(&bootstrap)),
        ("revision", json!(["int", 1])),
        ("previous", text(&id("rust-prior"))),
        ("entries", json!(["list", [entry]])),
    ]);
    let catalog_bytes = envelope::signing_bytes(&Term::from_carrier(&catalog).unwrap()).unwrap();
    let catalog_id = URL_SAFE_NO_PAD.encode(Sha256::digest(&catalog_bytes));
    let signed_catalog = record(vec![
        ("catalog", catalog),
        (
            "signature",
            json!([
                "bin",
                STANDARD.encode(signer.sign(&catalog_bytes).to_bytes())
            ]),
        ),
    ]);
    let body = json!([
        "tuple",
        [["atom", "post"], text("Rust → BEAM / TS: 雪\u{feff}")]
    ]);
    let payload = Term::List(vec![
        Term::Binary(b"lattice-op-v2".to_vec()),
        Term::Binary(space.as_bytes().to_vec()),
        Term::Binary(public.to_vec()),
        Term::List(vec![]),
        Term::Atom("command".into()),
        Term::from_carrier(&body).unwrap(),
        Term::Nil,
    ]);
    let payload = encode(&payload).unwrap();
    let frame = json!({"v":1,"id":URL_SAFE_NO_PAD.encode(Sha256::digest(&payload)),"replica":space,
        "author":STANDARD.encode(public),"deps":[],"kind":"command","body":body,"cap":["nil"],
        "sig":STANDARD.encode(signer.sign(&payload).to_bytes())});
    let delegation = json!(["delegation",{"id":id("delegation"),"replica":space,
        "issuer":STANDARD.encode(public),"audience":STANDARD.encode(service),"parent_id":null,
        "ops":["post","author_edit"],"roles":["moderator","admin"],"live":true,"sig":STANDARD.encode([0;64])}]);
    let mut leased = delegation.clone();
    leased[1]["expires_epoch"] = json!(7);
    let mut empty_text = delegation.clone();
    for key in ["id", "replica", "parent_id"] {
        empty_text[1][key] = json!("");
    }
    let terms = vec![
        json!(["nil"]),
        json!(["bool", true]),
        json!(["int", "18446744073709551615"]),
        text("Unicode:雪\u{feff}"),
        json!(["atom", "Unicode:雪"]),
        json!(["tuple", [["nil"], ["bool", false]]]),
        json!([
            "map",
            [
                [["atom", "kind"], ["int", 24]],
                [["bin", ""], ["int", 65536]]
            ]
        ]),
        json!(["mapset", [["int", 256], ["int", 0]]]),
        delegation,
        leased,
        empty_text,
    ];
    let terms: Vec<Value> = terms
        .into_iter()
        .map(|term| json!({"bytes":STANDARD.encode(bytes(&term)),"term":term}))
        .collect();
    json!({"version":1,"terms":terms,"frame":frame,"catalog_envelope_term":signed_catalog,
        "expected_catalog_key":STANDARD.encode(public),"catalog_bytes":STANDARD.encode(catalog_bytes),"catalog_id":catalog_id})
}

#[test]
fn fresh_beam_and_ts_producers_verify_in_native_and_rust_output_verifies_in_both_peers() {
    for runtime in ["beam", "ts"] {
        let produced = peer(runtime, "produce", None);
        let key = STANDARD
            .decode(produced["expected_catalog_key"].as_str().unwrap())
            .unwrap();
        let catalog = envelope::verify(
            &serde_json::to_vec(&produced["catalog_envelope_term"]).unwrap(),
            &key,
        )
        .unwrap();
        assert_eq!(catalog.id(), produced["catalog_id"].as_str().unwrap());
        assert_eq!(
            STANDARD.encode(catalog.signing_bytes()),
            produced["catalog_bytes"]
        );
        let frames = produced["frames"].as_array().unwrap();
        assert!(!frames.is_empty());
        for raw in frames {
            frame::verify(&serde_json::to_vec(raw).unwrap()).unwrap();
        }
    }
    let produced = rust_fixture();
    let path = root().join("clients/lattice-client/test/vectors/catalog/rust_codec.json");
    let rendered = serde_json::to_string_pretty(&produced).unwrap() + "\n";
    if std::env::var_os("UPDATE_NATIVE_CATALOG_VECTORS").is_some() {
        std::fs::write(&path, &rendered).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        rendered,
        "Rust vector must match fresh regeneration"
    );
    for runtime in ["beam", "ts"] {
        let result = peer(runtime, "consume", Some(&produced));
        assert_eq!(result["terms"], 11);
        assert_eq!(result["frame"], produced["frame"]["id"]);
        assert_eq!(result["catalog"], produced["catalog_id"]);
    }
}
