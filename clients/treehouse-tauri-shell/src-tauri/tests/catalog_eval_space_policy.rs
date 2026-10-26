use serde_json::{json, Value};
use std::collections::BTreeSet;
#[path = "support/catalog_peer.rs"]
mod catalog_peer;
use treehouse_tauri_shell::catalog_eval::{history::AuthenticDag, space_projection};
#[path = "support/catalog_author.rs"]
mod catalog_author;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use catalog_author::{delegation, signed, text};
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use treehouse_tauri_shell::catalog_eval::{
    canonical::{encode, Term},
    member_certificate::Claim,
};

fn map(fields: Vec<(&str, Value)>) -> Value {
    json!([
        "map",
        fields
            .into_iter()
            .map(|(key, value)| json!([["atom", key], value]))
            .collect::<Vec<_>>()
    ])
}
fn rust_histories() -> Vec<Value> {
    let root = SigningKey::from_bytes(&[103; 32]);
    let old = SigningKey::from_bytes(&[104; 32]);
    let new = SigningKey::from_bytes(&[105; 32]);
    let mut vouchers = [
        SigningKey::from_bytes(&[106; 32]),
        SigningKey::from_bytes(&[107; 32]),
    ];
    vouchers.sort_by_key(|key| key.verifying_key().to_bytes());
    let replica = format!(
        "replica:treehouse:space:{}#authority:bounded-continuation-v1#root:{}",
        URL_SAFE_NO_PAD.encode(Sha256::digest(b"rust-space-policy")),
        URL_SAFE_NO_PAD.encode(Sha256::digest(root.verifying_key().to_bytes()))
    );
    let mut ops = vec![
        "create_space",
        "create_thread",
        "issue_invitation",
        "revoke_invitation",
        "admit_member",
        "remove_member",
        "attest_member_key_v1",
    ];
    ops.sort();
    let cap = delegation(
        &root,
        &replica,
        &root.verifying_key().to_bytes(),
        None,
        &ops,
        true,
        &["admin", "moderator"],
    );
    let cap_id = cap[1]["id"].as_str().unwrap();
    let genesis = signed(
        &root,
        &replica,
        &[],
        "authority",
        json!(["tuple", [["atom", "genesis"], cap.clone(), ["map", []]]]),
        json!(["nil"]),
    );
    let command = |deps: Vec<String>, name: &str, args: Vec<Value>| {
        signed(
            &root,
            &replica,
            &deps,
            "command",
            json!(["tuple", [["atom", name], ["list", args]]]),
            text(cap_id),
        )
    };
    let id = |frame: &Value| frame["id"].as_str().unwrap().to_owned();
    let creation = command(
        vec![id(&genesis)],
        "create_space",
        vec![text("\u{FEFF}Rust Space")],
    );
    let mut frames = vec![genesis, creation];
    let mut admissions = Vec::new();
    for member in [&old, &vouchers[0], &vouchers[1]] {
        let recipient = STANDARD.encode(member.verifying_key().to_bytes());
        let invitation = command(
            vec![id(frames.last().unwrap())],
            "issue_invitation",
            vec![text(&recipient), json!(["list", []])],
        );
        let acceptance = encode(&Term::List(vec![
            Term::Binary(b"treehouse-invitation-acceptance-v1".to_vec()),
            Term::Binary(replica.as_bytes().to_vec()),
            Term::Binary(id(&invitation).into_bytes()),
            Term::Binary(recipient.as_bytes().to_vec()),
            Term::List(vec![]),
        ]))
        .unwrap();
        let admit = command(
            vec![id(&invitation)],
            "admit_member",
            vec![
                text(&id(&invitation)),
                text(&recipient),
                text("member"),
                text(&STANDARD.encode(member.sign(&acceptance).to_bytes())),
            ],
        );
        admissions.push(id(&admit));
        frames.extend([invitation, admit]);
    }
    let epoch = signed(
        &root,
        &replica,
        &[id(frames.last().unwrap())],
        "authority",
        json!(["tuple", [["atom", "beacon"], ["int", 0]]]),
        json!(["nil"]),
    );
    frames.push(epoch.clone());
    let claim = map(vec![
        ("version", json!(["int", 1])),
        ("product", json!(["atom", "treehouse"])),
        ("space", text(&replica)),
        (
            "old_pub",
            json!(["bin", STANDARD.encode(old.verifying_key().to_bytes())]),
        ),
        (
            "new_pub",
            json!(["bin", STANDARD.encode(new.verifying_key().to_bytes())]),
        ),
        ("old_admission", text(&admissions[0])),
        ("old_membership", json!(["atom", "active"])),
        ("nonce", json!(["bin", STANDARD.encode([108; 32])])),
        ("deps", json!(["list", [text(&id(&epoch))]])),
        ("epoch", json!(["int", 0])),
        ("epoch_basis", json!(["list", [text(&id(&epoch))]])),
        ("parents", json!(["list", []])),
        (
            "vouchers",
            json!([
                "list",
                vouchers
                    .iter()
                    .zip(&admissions[1..])
                    .map(|(key, admission)| map(vec![
                        (
                            "member",
                            json!(["bin", STANDARD.encode(key.verifying_key().to_bytes())])
                        ),
                        ("admission", text(admission))
                    ]))
                    .collect::<Vec<_>>()
            ]),
        ),
    ]);
    let term = Term::from_carrier(&claim).unwrap();
    let decoded = Claim::decode(&term).expect("native claim shape");
    let possession = new.sign(&decoded.possession_bytes().unwrap()).to_bytes();
    let vouch_bytes = decoded.vouch_bytes(&possession).unwrap();
    let vouches = json!([
        "list",
        vouchers
            .iter()
            .map(|key| map(vec![
                (
                    "member",
                    json!(["bin", STANDARD.encode(key.verifying_key().to_bytes())])
                ),
                (
                    "signature",
                    json!(["bin", STANDARD.encode(key.sign(&vouch_bytes).to_bytes())])
                )
            ]))
            .collect::<Vec<_>>()
    ]);
    let cert = command(
        vec![id(&epoch)],
        "attest_member_key_v1",
        vec![
            claim.clone(),
            json!(["bin", STANDARD.encode(possession)]),
            vouches.clone(),
        ],
    );
    // Correctly signed outer frame with a wrong-purpose detached possession.
    let wrong = new.sign(&decoded.claim_bytes().unwrap()).to_bytes();
    let bad = command(
        vec![id(&epoch)],
        "attest_member_key_v1",
        vec![claim, json!(["bin", STANDARD.encode(wrong)]), vouches],
    );
    let removal = command(
        vec![id(&epoch)],
        "remove_member",
        vec![text(
            &STANDARD.encode(vouchers[0].verifying_key().to_bytes()),
        )],
    );
    let old_recipient = STANDARD.encode(old.verifying_key().to_bytes());
    let remove_old = command(
        vec![id(&epoch)],
        "remove_member",
        vec![text(&old_recipient)],
    );
    let invite = command(
        vec![id(&epoch)],
        "issue_invitation",
        vec![text(&old_recipient), json!(["list", []])],
    );
    let acceptance = encode(&Term::List(vec![
        Term::Binary(b"treehouse-invitation-acceptance-v1".to_vec()),
        Term::Binary(replica.as_bytes().to_vec()),
        Term::Binary(id(&invite).into_bytes()),
        Term::Binary(old_recipient.as_bytes().to_vec()),
        Term::List(vec![]),
    ]))
    .unwrap();
    let readd = command(
        vec![id(&invite)],
        "admit_member",
        vec![
            text(&id(&invite)),
            text(&old_recipient),
            text("member"),
            text(&STANDARD.encode(old.sign(&acceptance).to_bytes())),
        ],
    );
    let thread = command(
        vec![id(&epoch)],
        "create_thread",
        vec![
            text("replica:treehouse:thread:rust-native"),
            text("\u{FEFF}Thread"),
        ],
    );
    let history = |name: &str, extra: Vec<Value>| {
        let mut values = frames.clone();
        values.extend(extra);
        json!({"name":name,"replica":replica,"frames":values})
    };
    vec![
        history("rust-certificate", vec![cert.clone()]),
        history("rust-wrong-purpose", vec![bad]),
        history("rust-stale-voucher", vec![cert, removal]),
        history(
            "rust-concurrent-readd",
            vec![remove_old, invite, readd, thread],
        ),
    ]
}
fn peer(runtime: &str, mode: &str, input: Option<&Value>) -> Value {
    let output = catalog_peer::output(runtime, mode, input, 64 * 1024 * 1024);
    serde_json::from_slice(&output).unwrap_or_else(|error| {
        panic!(
            "actual {runtime} {mode} peer JSON: {error}: {}",
            String::from_utf8_lossy(&output[..output.len().min(256)])
        )
    })
}
fn native(h: &Value) -> Value {
    let frames: Vec<_> = h["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| serde_json::to_vec(v).unwrap())
        .collect();
    let dag = AuthenticDag::authenticate(
        h["replica"].as_str().unwrap(),
        &frames.iter().map(Vec::as_slice).collect::<Vec<_>>(),
    )
    .unwrap();
    serde_json::to_value(space_projection::project(&dag).unwrap()).unwrap()
}
#[test]
fn complete_space_policy_matches_fresh_semantic_corpora_from_both_owners() {
    let mut input = peer("ts", "space-policy-cases", None);
    input["histories"].as_array_mut().unwrap().extend(
        peer("beam", "space-policy-cases", None)["histories"]
            .as_array()
            .unwrap()
            .iter()
            .cloned(),
    );
    for runtime in ["ts", "beam"] {
        input["histories"].as_array_mut().unwrap().extend(
            peer(runtime, "produce", None)["histories"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|h| {
                    h["replica"]
                        .as_str()
                        .unwrap()
                        .starts_with("replica:treehouse:space:")
                })
                .cloned(),
        );
    }
    let ts = peer("ts", "space-projection", Some(&input));
    let beam = peer("beam", "space-projection", Some(&input));
    let mut reasons = BTreeSet::new();
    let mut honored = 0;
    assert!(input["histories"].as_array().unwrap().len() > 30);
    for (i, h) in input["histories"].as_array().unwrap().iter().enumerate() {
        let actual = native(h);
        assert_eq!(actual, ts["results"][i], "TS {}", h["name"]);
        assert_eq!(actual, beam["results"][i], "BEAM {}", h["name"]);
        for value in actual["commandReasons"].as_object().unwrap().values() {
            if let Some(r) = value.as_str() {
                reasons.insert(r.to_owned());
            } else {
                honored += 1;
            }
        }
        let mut reverse = h.clone();
        reverse["frames"].as_array_mut().unwrap().reverse();
        assert_eq!(actual, native(&reverse), "delivery order {}", h["name"]);
    }
    for reason in [
        "application_continuity_invalid_certificate",
        "application_continuity_stale_context",
        "application_continuity_stale_voucher",
        "application_continuity_conflicting_target",
        "application_continuity_invalid_parent",
    ] {
        assert!(reasons.contains(reason), "unexercised {reason}");
    }
    assert!(honored > 30);
}

#[test]
fn unsigned_continuity_header_aliases_preserve_source_policy_decisions() {
    let corpus = peer("ts", "space-policy-cases", None);
    let mut aliases = Vec::new();
    for mode in ["duplicate", "reversed"] {
        let name = if mode == "duplicate" {
            "review_assembled"
        } else {
            "all_head_resolution"
        };
        let baseline = corpus["histories"]
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h["name"] == name)
            .unwrap();
        let mut h = baseline.clone();
        h["name"] = json!(format!("continuity-header-{mode}"));
        let frame = h["frames"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .rev()
            .find(|f| f["body"][1][0] == json!(["atom", "attest_member_key_v1"]))
            .unwrap();
        let deps = frame["deps"].as_array_mut().unwrap();
        assert!(!deps.is_empty());
        if mode == "duplicate" {
            deps.push(deps[0].clone());
        } else {
            assert!(
                deps.len() > 1,
                "order witness must actually change the header"
            );
            deps.reverse();
        }
        aliases.push(h);
    }
    let input = json!({"histories":aliases});
    let ts = peer("ts", "space-projection", Some(&input));
    let beam = peer("beam", "space-projection", Some(&input));
    for (i, h) in input["histories"].as_array().unwrap().iter().enumerate() {
        let actual = native(h);
        assert_eq!(
            beam["results"][i], ts["results"][i],
            "source contract {}",
            h["name"]
        );
        assert_eq!(actual, beam["results"][i]);
        assert_eq!(actual, ts["results"][i], "{}", h["name"]);
    }
}

#[test]
fn duplicate_creation_header_dependency_does_not_complete_initialization() {
    let mut history = rust_histories().remove(0);
    history["name"] = json!("rust-duplicate-creation-header");
    let frame = history["frames"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|frame| frame["body"][1][0] == json!(["atom", "create_space"]))
        .unwrap();
    let deps = frame["deps"].as_array_mut().unwrap();
    assert_eq!(deps.len(), 1);
    deps.push(deps[0].clone());
    let input = json!({"histories":[history]});
    let result = native(&input["histories"][0]);
    assert_eq!(result["initialization"], "incomplete");
    for runtime in ["ts", "beam"] {
        assert_eq!(
            result,
            peer(runtime, "space-projection", Some(&input))["results"][0],
            "{runtime}"
        );
    }
}

#[test]
fn fresh_rust_space_certificates_and_observed_remove_state_match_both_owners() {
    let input = json!({"histories":rust_histories()});
    let ts = peer("ts", "space-projection", Some(&input));
    let beam = peer("beam", "space-projection", Some(&input));
    for (index, history) in input["histories"].as_array().unwrap().iter().enumerate() {
        let result = native(history);
        assert_eq!(result, ts["results"][index], "TS {}", history["name"]);
        assert_eq!(result, beam["results"][index], "BEAM {}", history["name"]);
        let mut reverse = history.clone();
        reverse["frames"].as_array_mut().unwrap().reverse();
        assert_eq!(result, native(&reverse));
        let certificate = history["frames"]
            .as_array()
            .unwrap()
            .iter()
            .find(|frame| frame["body"][1][0] == json!(["atom", "attest_member_key_v1"]));
        if let Some(certificate) = certificate {
            let reason = &result["commandReasons"][certificate["id"].as_str().unwrap()];
            match history["name"].as_str().unwrap() {
                "rust-certificate" => assert!(reason.is_null(), "nonvacuous native certificate"),
                "rust-wrong-purpose" => {
                    assert_eq!(reason, "application_continuity_invalid_certificate")
                }
                "rust-stale-voucher" => assert_eq!(reason, "application_continuity_stale_voucher"),
                _ => unreachable!(),
            }
        } else {
            assert_eq!(
                result["state"]["members"].as_array().unwrap().len(),
                3,
                "concurrent admission survives observed removal"
            );
            assert_eq!(result["state"]["threads"].as_array().unwrap().len(), 1);
        }
        assert_eq!(result["initialization"], "ready");
    }
}
