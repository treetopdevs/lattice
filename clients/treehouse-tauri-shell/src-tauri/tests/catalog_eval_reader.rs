use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use treehouse_tauri_shell::catalog_eval::{
    canonical::{encode, Term},
    frame,
    reader::ReadableFrame,
};
#[path = "support/catalog_peer.rs"]
mod catalog_peer;
fn signed(kind: &str, body: Value, cap: Value) -> Value {
    let key = SigningKey::from_bytes(&[112; 32]);
    let replica = "replica:treehouse:thread:reader";
    let payload = encode(&Term::List(vec![
        Term::Binary(b"lattice-op-v2".to_vec()),
        Term::Binary(replica.as_bytes().to_vec()),
        Term::Binary(key.verifying_key().as_bytes().to_vec()),
        Term::List(vec![]),
        Term::Atom(kind.into()),
        Term::from_carrier(&body).unwrap(),
        Term::from_carrier(&cap).unwrap(),
    ]))
    .unwrap();
    json!({"v":1,"id":URL_SAFE_NO_PAD.encode(Sha256::digest(&payload)),"replica":replica,"author":STANDARD.encode(key.verifying_key().as_bytes()),"deps":[],"kind":kind,"body":body,"cap":cap,"sig":STANDARD.encode(key.sign(&payload).to_bytes())})
}
#[test]
fn reader_matches_actual_ts_strict_contexts_without_claiming_semantic_honor() {
    let large = json!(["int", "9007199254740992"]);
    let safe = json!(["int", "9007199254740991"]);
    let atom = |name: &str| json!(["atom", name]);
    let map = |name: &str, value: Value| json!(["map", [[["atom", name], value]]]);
    let mut cases: Vec<(&str, Value, bool)> = vec![];
    let mut add = |name, kind, body, cap, want| cases.push((name, signed(kind, body, cap), want));
    add(
        "safe integer",
        "command",
        safe.clone(),
        json!(["nil"]),
        true,
    );
    add(
        "large strict integer",
        "command",
        large.clone(),
        json!(["nil"]),
        false,
    );
    add(
        "large cap",
        "authority",
        atom("beacon"),
        large.clone(),
        false,
    );
    add(
        "opaque binary",
        "command",
        json!(["bin", STANDARD.encode([255, 254, 239, 187, 191])]),
        json!(["nil"]),
        true,
    );
    add(
        "wire name beyond cutoff vocabulary",
        "command",
        atom("abort_election"),
        json!(["nil"]),
        true,
    );
    add(
        "unknown atom",
        "command",
        atom("unadopted_reader_atom"),
        json!(["nil"]),
        false,
    );
    for container in ["list", "tuple", "mapset"] {
        add(
            "nested strict integer",
            "command",
            json!([container, [large.clone()]]),
            json!(["nil"]),
            false,
        );
    }
    add(
        "legacy large beacon",
        "authority",
        json!(["tuple", [atom("beacon"), large.clone()]]),
        json!(["nil"]),
        true,
    );
    add(
        "witnessed large epoch",
        "authority",
        json!([
            "tuple",
            [
                atom("beacon"),
                large.clone(),
                map("claim", map("epoch", safe.clone()))
            ]
        ]),
        json!(["nil"]),
        false,
    );
    for (field, value, want) in [
        ("epoch", large.clone(), false),
        ("epoch", safe.clone(), true),
        ("max_epoch_step", large.clone(), true),
    ] {
        add(
            "certificate context",
            "authority",
            json!([
                "tuple",
                [
                    atom("beacon"),
                    safe.clone(),
                    map("claim", map(field, value))
                ]
            ]),
            json!(["nil"]),
            want,
        );
    }
    // Claim context is only activated by the direct certificate claim key.
    add(
        "nested metadata epoch",
        "authority",
        json!([
            "tuple",
            [
                atom("beacon"),
                safe.clone(),
                map("claim", map("profile_genesis", map("epoch", large.clone())))
            ]
        ]),
        json!(["nil"]),
        true,
    );
    for field in ["__beacon__", "other"] {
        // Use an adopted ordinary policy key for the strict comparison.
        let field = if field == "other" { "admin" } else { field };
        add(
            "genesis metadata context",
            "authority",
            json!([
                "tuple",
                [
                    atom("genesis"),
                    ["nil"],
                    map(field, map("epoch", large.clone()))
                ]
            ]),
            json!(["nil"]),
            field == "__beacon__",
        );
    }
    let base = json!({"id":"","replica":"","issuer":STANDARD.encode([1;32]),"audience":STANDARD.encode([1;32]),"parent_id":null,"ops":["post"],"roles":[],"live":false,"sig":STANDARD.encode([0;64])});
    for (expiry, want) in [
        (None, true),
        (Some(json!(1)), true),
        (Some(json!("1")), false),
        (Some(Value::Null), false),
        (Some(json!(9007199254740992u64)), false),
    ] {
        let mut delegation = base.clone();
        if let Some(value) = expiry {
            delegation["expires_epoch"] = value;
        }
        // A numeric unsafe expiry cannot pass canonical frame authentication;
        // test the remaining representable records through the reader.
        if Term::from_carrier(&json!(["delegation", delegation.clone()])).is_ok() {
            add(
                "delegation expiry shape",
                "command",
                json!(["delegation", delegation]),
                json!(["nil"]),
                want,
            );
        }
    }
    let vocabulary: Value = serde_json::from_slice(&catalog_peer::output(
        "ts",
        "reader-vocabulary",
        None,
        64 * 1024 * 1024,
    ))
    .unwrap();
    assert!(vocabulary["names"].as_array().unwrap().len() > 139);
    for name in vocabulary["names"].as_array().unwrap() {
        cases.push((
            "actual full wire vocabulary",
            signed("command", json!(["atom", name]), json!(["nil"])),
            true,
        ));
        let mut delegation = base.clone();
        delegation["ops"] = json!([name]);
        delegation["roles"] = json!([name]);
        cases.push((
            "actual delegation wire vocabulary",
            signed("command", json!(["delegation", delegation]), json!(["nil"])),
            true,
        ));
    }
    for runtime in ["beam", "ts"] {
        let fresh: Value = serde_json::from_slice(&catalog_peer::output(
            runtime,
            "produce",
            None,
            64 * 1024 * 1024,
        ))
        .unwrap();
        for history in fresh["histories"].as_array().unwrap() {
            for frame in history["frames"].as_array().unwrap() {
                assert!(
                    ReadableFrame::verify(&serde_json::to_vec(frame).unwrap()).is_ok(),
                    "fresh {runtime} product frame"
                );
                cases.push(("fresh product frame", frame.clone(), true));
            }
        }
    }
    for (name, frame, want) in &cases {
        let bytes = serde_json::to_vec(frame).unwrap();
        assert!(frame::verify(&bytes).is_ok(), "authentic {name}");
        assert_eq!(ReadableFrame::verify(&bytes).is_ok(), *want, "{name}");
    }
    let input = json!({"histories":cases.iter().map(|(_,frame,_)|json!({"replica":frame["replica"],"frames":[frame]})).collect::<Vec<_>>()});
    let output = catalog_peer::output("ts", "strict-portability", Some(&input), 64 * 1024 * 1024);
    let output: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(
        output["portable"],
        json!(cases.iter().map(|(_, _, want)| *want).collect::<Vec<_>>())
    );
}
