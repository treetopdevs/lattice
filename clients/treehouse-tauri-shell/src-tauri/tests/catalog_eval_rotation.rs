use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use curve25519_dalek::scalar::Scalar;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256, Sha512};
use treehouse_tauri_shell::catalog_eval::{
    canonical::{Term, MAX_BYTES},
    rotation,
};
#[path = "support/catalog_author.rs"]
mod catalog_author;
#[path = "support/catalog_peer.rs"]
mod catalog_peer;
use catalog_author::text;
fn map(v: Vec<(&str, Value)>) -> Value {
    json!([
        "map",
        v.into_iter()
            .map(|(k, v)| json!([["atom", k], v]))
            .collect::<Vec<_>>()
    ])
}
fn id(label: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(label))
}
fn field<'a>(v: &'a mut Value, key: &str) -> &'a mut Value {
    &mut v[1]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|pair| pair[0] == json!(["atom", key]))
        .unwrap()[1]
}
fn peer(runtime: &str, mode: &str, input: Option<&Value>) -> Value {
    serde_json::from_slice(&catalog_peer::output(runtime, mode, input, 4 * 1024 * 1024)).unwrap()
}
fn native(case: &Value) -> Value {
    let Ok(term) = Term::from_carrier(&case["envelope"]) else {
        return json!({"shape":false,"valid":false});
    };
    let Some(e) = rotation::Envelope::decode(&term) else {
        return json!({"shape":false,"valid":false});
    };
    let key = STANDARD.decode(case["key"].as_str().unwrap()).unwrap();
    json!({"shape":true,"valid":e.verify(&key),"id":e.id().unwrap(),"rotationBytes":STANDARD.encode(e.rotation.signing_bytes().unwrap()),"possessionBytes":STANDARD.encode(e.rotation.possession_bytes().unwrap())})
}
fn rust_case(generation: u64, count: usize, same_key: bool) -> Value {
    let old = SigningKey::from_bytes(&[121; 32]);
    let next = if same_key {
        old.clone()
    } else {
        SigningKey::from_bytes(&[122; 32])
    };
    let mut cutoff_names = (0..count)
        .map(|i| format!("\u{feff}Rust rotation cutoff {i:02}"))
        .collect::<Vec<_>>();
    cutoff_names.sort();
    let cutoffs = cutoff_names
        .iter()
        .map(|replica| {
            map(vec![
                ("replica", text(replica)),
                ("frontier", json!(["list", []])),
                ("log_digest", text(&id(replica))),
            ])
        })
        .collect::<Vec<_>>();
    let record = map(vec![
        ("version", json!(["int", 1])),
        ("product", json!(["atom", "treehouse"])),
        ("space", text("\u{feff}Rust rotation Space")),
        ("bootstrap", text(&id("bootstrap"))),
        ("parent", text(&id("parent"))),
        ("prior_catalog", text(&id("prior catalog"))),
        ("generation", json!(["int", generation])),
        (
            "new_catalog_key",
            json!(["bin", STANDARD.encode(next.verifying_key().to_bytes())]),
        ),
        ("nonce", text(&id("nonce"))),
        ("inventory_digest", text(&id("inventory"))),
        ("cutoffs", json!(["list", cutoffs])),
    ]);
    let term = Term::from_carrier(&record).unwrap();
    let decoded = rotation::Rotation::decode(&term).unwrap();
    let envelope = map(vec![
        ("rotation", record.clone()),
        (
            "old_signature",
            json!([
                "bin",
                STANDARD.encode(old.sign(&decoded.signing_bytes().unwrap()).to_bytes())
            ]),
        ),
        (
            "new_signature",
            json!([
                "bin",
                STANDARD.encode(next.sign(&decoded.possession_bytes().unwrap()).to_bytes())
            ]),
        ),
    ]);
    json!({"envelope":envelope,"key":STANDARD.encode(old.verifying_key().to_bytes())})
}
// An identity R with S=k*a satisfies the uncofactored equation, but the
// strict profile must still refuse its small-order nonce point.
fn small_r_signature(seed: [u8; 32], message: &[u8]) -> [u8; 64] {
    let hash = Sha512::digest(seed);
    let mut secret: [u8; 32] = hash[..32].try_into().unwrap();
    secret[0] &= 248;
    secret[31] &= 63;
    secret[31] |= 64;
    let a = Scalar::from_bytes_mod_order(secret);
    let public = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
    let mut signature = [0; 64];
    signature[0] = 1;
    let mut challenge = Sha512::new();
    challenge.update(&signature[..32]);
    challenge.update(public);
    challenge.update(message);
    let k = Scalar::from_bytes_mod_order_wide(&challenge.finalize().into());
    signature[32..].copy_from_slice(&(k * a).to_bytes());
    SigningKey::from_bytes(&seed)
        .verifying_key()
        .verify(message, &Signature::from_bytes(&signature))
        .unwrap();
    signature
}

fn strict_slot_cases() -> Vec<Value> {
    use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;
    let baseline = rust_case(1, 1, false);
    let term = Term::from_carrier(&baseline["envelope"]).unwrap();
    let envelope = rotation::Envelope::decode(&term).unwrap();
    let mut old_r = baseline.clone();
    *field(&mut old_r["envelope"], "old_signature") = json!([
        "bin",
        STANDARD.encode(small_r_signature(
            [121; 32],
            &envelope.rotation.signing_bytes().unwrap()
        ))
    ]);
    let mut new_r = baseline.clone();
    *field(&mut new_r["envelope"], "new_signature") = json!([
        "bin",
        STANDARD.encode(small_r_signature(
            [122; 32],
            &envelope.rotation.possession_bytes().unwrap()
        ))
    ]);

    // For A=identity, R=37B and S=37 satisfy the equation for every message.
    // The other slot stays freshly and correctly signed for its actual purpose.
    let mut identity = [0; 32];
    identity[0] = 1;
    let scalar = Scalar::from(37u64);
    let mut universal = [0; 64];
    universal[..32].copy_from_slice(&(ED25519_BASEPOINT_POINT * scalar).compress().to_bytes());
    universal[32..].copy_from_slice(&scalar.to_bytes());
    VerifyingKey::from_bytes(&identity)
        .unwrap()
        .verify(
            &envelope.rotation.signing_bytes().unwrap(),
            &Signature::from_bytes(&universal),
        )
        .unwrap();
    let mut old_a = baseline.clone();
    old_a["key"] = json!(STANDARD.encode(identity));
    *field(&mut old_a["envelope"], "old_signature") = json!(["bin", STANDARD.encode(universal)]);
    let mut new_a = baseline;
    *field(field(&mut new_a["envelope"], "rotation"), "new_catalog_key") =
        json!(["bin", STANDARD.encode(identity)]);
    let term = Term::from_carrier(field(&mut new_a["envelope"], "rotation")).unwrap();
    let record = rotation::Rotation::decode(&term).unwrap();
    *field(&mut new_a["envelope"], "old_signature") = json!([
        "bin",
        STANDARD.encode(
            SigningKey::from_bytes(&[121; 32])
                .sign(&record.signing_bytes().unwrap())
                .to_bytes()
        )
    ]);
    VerifyingKey::from_bytes(&identity)
        .unwrap()
        .verify(
            &record.possession_bytes().unwrap(),
            &Signature::from_bytes(&universal),
        )
        .unwrap();
    *field(&mut new_a["envelope"], "new_signature") = json!(["bin", STANDARD.encode(universal)]);
    vec![old_r, new_r, old_a, new_a]
}

#[test]
fn fresh_rotation_records_bytes_ids_and_both_purposes_match_all_three_runtimes() {
    let mut cases = vec![
        peer("ts", "rotation-produce", None),
        peer("beam", "rotation-produce", None),
        rust_case(1, 1, false),
        rust_case(9_007_199_254_740_991, 13, false),
    ];
    let controls = cases.clone();
    cases.extend(strict_slot_cases());
    for base in controls {
        let mut old = base.clone();
        *field(&mut old["envelope"], "old_signature") = json!(["bin", STANDARD.encode([0; 64])]);
        cases.push(old);
        let mut new = base.clone();
        *field(&mut new["envelope"], "new_signature") = json!(["bin", STANDARD.encode([0; 64])]);
        cases.push(new);
        let mut changed = base.clone();
        *field(field(&mut changed["envelope"], "rotation"), "nonce") = text(&id("changed nonce"));
        cases.push(changed);
        let mut wrong = base.clone();
        wrong["key"] = json!(STANDARD.encode(
            SigningKey::from_bytes(&[123; 32])
                .verifying_key()
                .to_bytes()
        ));
        cases.push(wrong);
        let mut malformed = base.clone();
        *field(field(&mut malformed["envelope"], "rotation"), "cutoffs") = json!(["list", []]);
        cases.push(malformed);
        let mut malformed = base.clone();
        *field(field(&mut malformed["envelope"], "rotation"), "generation") = json!(["int", 0]);
        cases.push(malformed);
        let mut malformed = base.clone();
        *field(field(&mut malformed["envelope"], "rotation"), "generation") =
            json!(["int", "9007199254740992"]);
        cases.push(malformed);
        let mut malformed = base.clone();
        *field(&mut malformed["envelope"], "new_signature") =
            json!(["bin", STANDARD.encode([0; 63])]);
        cases.push(malformed);
        for frontier in [
            vec![text(&id("duplicate head")), text(&id("duplicate head"))],
            {
                let mut ids = vec![id("head A"), id("head B")];
                ids.sort();
                ids.reverse();
                ids.iter().map(|id| text(id)).collect()
            },
        ] {
            let mut malformed = base.clone();
            let cutoffs = field(field(&mut malformed["envelope"], "rotation"), "cutoffs");
            *field(&mut cutoffs[1][0], "frontier") = json!(["list", frontier]);
            cases.push(malformed);
        }
        let mut malformed = base.clone();
        let cutoffs = field(field(&mut malformed["envelope"], "rotation"), "cutoffs");
        let duplicate = cutoffs[1][0].clone();
        cutoffs[1].as_array_mut().unwrap().push(duplicate);
        cases.push(malformed);
        for name in ["generation", "version"] {
            let mut malformed = base.clone();
            let term = field(field(&mut malformed["envelope"], "rotation"), name);
            let number = term[1].clone();
            *term = json!(["int", format!("{}\n", number.as_u64().unwrap())]);
            cases.push(malformed);
        }
        let mut reversed = base.clone();
        let cutoffs = field(field(&mut reversed["envelope"], "rotation"), "cutoffs");
        let entries = cutoffs[1].as_array_mut().unwrap();
        if entries.len() > 1 {
            entries.reverse();
            cases.push(reversed);
        }
    }
    let mut over = rust_case(1, 13, false);
    let cutoffs = field(field(&mut over["envelope"], "rotation"), "cutoffs");
    let mut extra = cutoffs[1][12].clone();
    *field(&mut extra, "replica") = text("\u{feff}Rust rotation cutoff 99");
    cutoffs[1].as_array_mut().unwrap().push(extra);
    cases.push(over);
    cases.push(rust_case(1, 1, true));
    let mut purpose = rust_case(1, 1, false);
    let record = field(&mut purpose["envelope"], "rotation").clone();
    let term = Term::from_carrier(&record).unwrap();
    let record = rotation::Rotation::decode(&term).unwrap();
    *field(&mut purpose["envelope"], "new_signature") = json!([
        "bin",
        STANDARD.encode(
            SigningKey::from_bytes(&[122; 32])
                .sign(&record.signing_bytes().unwrap())
                .to_bytes()
        )
    ]);
    cases.push(purpose);
    let input = json!({"cases":cases});
    let ts = peer("ts", "rotation-consume", Some(&input));
    let beam = peer("beam", "rotation-consume", Some(&input));
    for (i, case) in input["cases"].as_array().unwrap().iter().enumerate() {
        let result = native(case);
        assert_eq!(result, ts["results"][i], "TS rotation case {i}");
        assert_eq!(result, beam["results"][i], "BEAM rotation case {i}");
        assert_eq!(
            result["valid"],
            json!(i < 4),
            "absolute honored/refused control {i}"
        );
        let key = STANDARD.decode(case["key"].as_str().unwrap()).unwrap();
        let verified = rotation::verify(&serde_json::to_vec(&case["envelope"]).unwrap(), &key);
        assert_eq!(verified.is_ok(), i < 4, "artifact verifier {i}");
        if let Ok(v) = verified {
            assert_eq!(v.id(), result["id"].as_str().unwrap());
        }
    }
    // The binding identity must retain signatures even when the altered signature refuses.
    assert_ne!(
        native(&input["cases"][0])["id"],
        native(&input["cases"][4])["id"]
    );
}
#[test]
fn rotation_artifact_retains_exact_existing_json_byte_limit() {
    let case = rust_case(1, 1, false);
    let key = STANDARD.decode(case["key"].as_str().unwrap()).unwrap();
    let mut bytes = serde_json::to_vec(&case["envelope"]).unwrap();
    bytes.resize(MAX_BYTES, b' ');
    assert!(rotation::verify(&bytes, &key).is_ok());
    bytes.push(b' ');
    assert!(rotation::verify(&bytes, &key).is_err());
}

#[test]
fn artifact_json_numbers_retain_the_existing_unsigned_integer_lexical_profile() {
    for bytes in [b"0".as_slice(), b"1".as_slice()] {
        assert!(treehouse_tauri_shell::catalog_eval::json::parse(bytes).is_ok());
    }
    for bytes in [b"-0".as_slice(), b"1.0".as_slice(), b"1e0".as_slice()] {
        assert!(treehouse_tauri_shell::catalog_eval::json::parse(bytes).is_err());
    }
}

#[test]
fn raw_rotation_verifier_refuses_small_text_integer_aliases_before_normalization() {
    let case = rust_case(1, 1, false);
    let key = STANDARD.decode(case["key"].as_str().unwrap()).unwrap();
    assert!(rotation::verify(&serde_json::to_vec(&case["envelope"]).unwrap(), &key).is_ok());
    for name in ["version", "generation"] {
        let mut alias = case["envelope"].clone();
        *field(field(&mut alias, "rotation"), name) = json!(["int", "1"]);
        let bytes = serde_json::to_vec(&alias).unwrap();
        assert!(treehouse_tauri_shell::catalog_eval::artifact::parse(&bytes).is_err());
        assert!(
            rotation::verify(&bytes, &key).is_err(),
            "raw {name} alias must refuse"
        );
    }
}
