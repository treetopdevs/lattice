use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use treehouse_tauri_shell::catalog_eval::{
    canonical::{decode, encode, Term, MAX_DEPTH},
    frame,
    json::parse,
};

fn wrap(kind: &str, term: Term, carrier: Value) -> (Term, Value) {
    match kind {
        "list" => (Term::List(vec![term]), json!(["list", [carrier]])),
        "tuple" => (Term::Tuple(vec![term]), json!(["tuple", [carrier]])),
        "mapset" => (Term::Set(vec![term]), json!(["mapset", [carrier]])),
        "map" => (
            Term::Map(vec![(Term::Nil, term)]),
            json!(["map", [[["nil"], carrier]]]),
        ),
        _ => unreachable!(),
    }
}
fn wrap_bytes(kind: &str, inner: Vec<u8>) -> Vec<u8> {
    let prefix = match kind {
        "list" => vec![0x81],
        "tuple" => vec![0xd9, 0xea, 0x61, 0x81],
        "mapset" => vec![0xd9, 0xea, 0x62, 0x81],
        "map" => vec![0xa1, 0xf6],
        _ => unreachable!(),
    };
    [prefix, inner].concat()
}
fn delegation() -> (Term, Value) {
    let wire = json!(["delegation", {"id":"depth", "replica":"replica:depth", "issuer":STANDARD.encode([1;32]),
        "audience":STANDARD.encode([2;32]), "parent_id":null, "ops":["post"], "roles":["member"], "live":true,
        "sig":STANDARD.encode([3;64]), "expires_epoch":7}]);
    (Term::from_carrier(&wire).unwrap(), wire)
}
fn signed(term: &Term, body: &Value) -> Value {
    let key = SigningKey::from_bytes(&[42; 32]);
    let fields = vec![
        Term::Binary(b"lattice-op-v2".to_vec()),
        Term::Binary(b"replica:depth".to_vec()),
        Term::Binary(key.verifying_key().to_bytes().to_vec()),
        Term::List(vec![]),
        Term::Atom("command".into()),
        term.clone(),
        Term::Nil,
    ];
    let mut payload = vec![0x87];
    for field in fields {
        payload.extend(encode(&field).unwrap());
    }
    json!({"v":1,"id":URL_SAFE_NO_PAD.encode(Sha256::digest(&payload)),"replica":"replica:depth",
        "author":STANDARD.encode(key.verifying_key().to_bytes()),"deps":[],"kind":"command","body":body,"cap":["nil"],
        "sig":STANDARD.encode(key.sign(&payload).to_bytes())})
}

#[test]
fn empty_composites_consume_the_last_domain_level_in_all_native_readers() {
    for kind in ["list", "tuple", "mapset", "map"] {
        let (mut term, mut carrier, mut bytes) = match kind {
            "list" => (Term::List(vec![]), json!(["list", []]), vec![0x80]),
            "tuple" => (
                Term::Tuple(vec![]),
                json!(["tuple", []]),
                vec![0xd9, 0xea, 0x61, 0x80],
            ),
            "mapset" => (
                Term::Set(vec![]),
                json!(["mapset", []]),
                vec![0xd9, 0xea, 0x62, 0x80],
            ),
            _ => (Term::Map(vec![]), json!(["map", []]), vec![0xa0]),
        };
        for _ in 1..MAX_DEPTH {
            (term, carrier) = wrap(kind, term, carrier);
            bytes = wrap_bytes(kind, bytes);
        }
        assert_eq!(encode(&term).unwrap(), bytes);
        assert!(decode(&bytes).is_ok(), "{kind}");
        assert!(
            Term::from_carrier(&parse(&serde_json::to_vec(&carrier).unwrap()).unwrap()).is_ok(),
            "{kind}"
        );
        let (over, raw) = wrap(kind, term, carrier);
        assert!(encode(&over).is_err(), "{kind}");
        assert!(Term::from_carrier(&raw).is_err(), "{kind}");
        assert!(decode(&wrap_bytes(kind, bytes)).is_err(), "{kind}");
    }
}

#[test]
fn map_wrappers_and_flat_delegation_metadata_preserve_the_actual_sixty_four_level_boundary() {
    for kind in ["list", "tuple", "mapset", "map"] {
        for leaf in [(Term::Nil, json!(["nil"])), delegation()] {
            let (mut term, mut carrier) = leaf;
            for _ in 0..MAX_DEPTH {
                (term, carrier) = wrap(kind, term, carrier);
            }
            let raw = serde_json::to_vec(&carrier).unwrap();
            assert!(Term::from_carrier(&parse(&raw).unwrap()).is_ok(), "{kind}");
            let bytes = encode(&term).unwrap();
            assert!(decode(&bytes).is_ok(), "{kind}");
            let frame = signed(&term, &carrier);
            assert!(
                frame::verify(&serde_json::to_vec(&frame).unwrap()).is_ok(),
                "{kind}"
            );
        }
    }
}

#[test]
fn authentic_unknown_names_are_not_wire_admission_and_well_formed_forgery_is_invalid() {
    let term = Term::Atom("native_unadmitted_probe".into());
    let mut raw = signed(&term, &json!(["atom", "native_unadmitted_probe"]));
    assert!(frame::verify(&serde_json::to_vec(&raw).unwrap()).is_ok());
    raw["sig"] = json!(STANDARD.encode([0; 64]));
    assert!(frame::verify(&serde_json::to_vec(&raw).unwrap()).is_err());
}

#[path = "support/catalog_codec_peer.rs"]
mod codec_peer;

#[test]
fn actual_beam_and_ts_peers_judge_depth_empty_containers_and_authenticity_separately() {
    let mut terms = Vec::new();
    let mut frames = Vec::new();
    for kind in ["list", "tuple", "mapset", "map"] {
        let (empty, raw, bytes) = match kind {
            "list" => (Term::List(vec![]), json!(["list", []]), vec![0x80]),
            "tuple" => (
                Term::Tuple(vec![]),
                json!(["tuple", []]),
                vec![0xd9, 0xea, 0x61, 0x80],
            ),
            "mapset" => (
                Term::Set(vec![]),
                json!(["mapset", []]),
                vec![0xd9, 0xea, 0x62, 0x80],
            ),
            _ => (Term::Map(vec![]), json!(["map", []]), vec![0xa0]),
        };
        let (mut term, mut carrier, mut encoded) = (empty, raw, bytes);
        for _ in 1..MAX_DEPTH {
            (term, carrier) = wrap(kind, term, carrier);
            encoded = wrap_bytes(kind, encoded);
        }
        terms.push(json!({"term":carrier,"bytes":STANDARD.encode(&encoded),"accepted":true}));
        let (_, over) = wrap(kind, term, carrier);
        terms.push(
            json!({"term":over,"bytes":STANDARD.encode(wrap_bytes(kind,encoded)),"accepted":false}),
        );
        let (mut term, mut carrier) = delegation();
        for _ in 0..MAX_DEPTH {
            (term, carrier) = wrap(kind, term, carrier);
        }
        terms.push(
            json!({"term":carrier,"bytes":STANDARD.encode(encode(&term).unwrap()),"accepted":true}),
        );
        frames.push(json!({"frame":signed(&term,&carrier),"admitted":true,"authentic":true}));
    }
    let unknown = signed(
        &Term::Atom("native_unadmitted_probe".into()),
        &json!(["atom", "native_unadmitted_probe"]),
    );
    frames.push(json!({"frame":unknown,"admitted":false,"authentic":true}));
    let mut forged = unknown;
    forged["sig"] = json!(STANDARD.encode([0; 64]));
    frames.push(json!({"frame":forged,"admitted":false,"authentic":false}));
    let input = json!({"terms":terms,"frames":frames});
    for runtime in ["beam", "ts"] {
        let result = codec_peer::peer(runtime, "boundaries", Some(&input));
        assert_eq!(
            result["terms"].as_array().unwrap().len(),
            input["terms"].as_array().unwrap().len()
        );
        assert_eq!(
            result["frames"].as_array().unwrap().len(),
            input["frames"].as_array().unwrap().len()
        );
        for (expected, actual) in input["terms"]
            .as_array()
            .unwrap()
            .iter()
            .zip(result["terms"].as_array().unwrap())
        {
            assert_eq!(
                actual["accepted"], expected["accepted"],
                "{runtime} term boundary"
            );
            if expected["accepted"] == true {
                assert_eq!(
                    actual["bytes"], expected["bytes"],
                    "{runtime} canonical bytes"
                );
            }
        }
        for (expected, actual) in input["frames"]
            .as_array()
            .unwrap()
            .iter()
            .zip(result["frames"].as_array().unwrap())
        {
            assert_eq!(
                actual["admitted"], expected["admitted"],
                "{runtime} admission"
            );
            assert_eq!(
                actual["authentic"], expected["authentic"],
                "{runtime} authenticity"
            );
        }
    }
}

#[test]
fn json_wrapper_budget_has_an_exact_finite_boundary() {
    use treehouse_tauri_shell::catalog_eval::canonical::MAX_JSON_DEPTH;
    let at = format!(
        "{}0{}",
        "[".repeat(MAX_JSON_DEPTH),
        "]".repeat(MAX_JSON_DEPTH)
    );
    assert!(parse(at.as_bytes()).is_ok());
    let over = format!("[{at}]");
    assert!(parse(over.as_bytes()).is_err());
}
