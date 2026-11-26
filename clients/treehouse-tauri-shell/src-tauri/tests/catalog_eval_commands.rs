use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[path = "support/catalog_peer.rs"]
mod catalog_peer;
use treehouse_tauri_shell::catalog_eval::{
    canonical::{encode, Term},
    commands::{CommandPreflight, PrePolicyDecision},
    history::AuthenticDag,
};
fn peer(runtime: &str, mode: &str, input: Option<&Value>) -> Value {
    let output = catalog_peer::output(runtime, mode, input, 64 * 1024 * 1024);
    serde_json::from_slice(&output).expect("actual runtime JSON")
}

fn checked(replica: &str, frames: &[Value]) -> AuthenticDag {
    let bytes: Vec<_> = frames
        .iter()
        .map(|v| serde_json::to_vec(v).unwrap())
        .collect();
    AuthenticDag::authenticate(
        replica,
        &bytes.iter().map(Vec::as_slice).collect::<Vec<_>>(),
    )
    .unwrap()
}
fn summary(dag: &AuthenticDag) -> Value {
    let preflight = CommandPreflight::analyze(dag).unwrap();
    let map:serde_json::Map<_,_>=preflight.decisions().iter().map(|(id,decision)|{
        let reason=match decision{PrePolicyDecision::Refused(reason)=>Some(*reason),PrePolicyDecision::ApplicationPolicyRequired=>None};
        let command=preflight.command(id);
        (id.clone(),json!({"reason":reason,"fields":command.map(|c|c.fields()),"roles":command.map(|c|c.roles())}))
    }).collect();
    Value::Object(map)
}
fn rust_command() -> Value {
    let signer = SigningKey::from_bytes(&[91; 32]);
    let author = signer.verifying_key().to_bytes();
    let replica = format!(
        "replica:treehouse:thread:{}#authority:bounded-continuation-v1#root:{}",
        URL_SAFE_NO_PAD.encode(Sha256::digest(b"native-command")),
        URL_SAFE_NO_PAD.encode(Sha256::digest(author))
    );
    let body = Term::Tuple(vec![
        Term::Atom("post".into()),
        Term::List(vec![Term::Binary(
            b"native unsigned capability refusal".to_vec(),
        )]),
    ]);
    let payload = encode(&Term::List(vec![
        Term::Binary(b"lattice-op-v2".to_vec()),
        Term::Binary(replica.as_bytes().to_vec()),
        Term::Binary(author.to_vec()),
        Term::List(vec![]),
        Term::Atom("command".into()),
        body,
        Term::Nil,
    ]))
    .unwrap();
    json!({"name":"rust-no-capability","replica":replica,"frames":[{"v":1,"id":URL_SAFE_NO_PAD.encode(Sha256::digest(&payload)),"replica":replica,"author":STANDARD.encode(author),"deps":[],"kind":"command","body":["tuple",[["atom","post"],["list",[["bin",STANDARD.encode(b"native unsigned capability refusal")]]]]],"cap":["nil"],"sig":STANDARD.encode(signer.sign(&payload).to_bytes())}]})
}
#[test]
fn native_command_preflight_matches_actual_capability_and_role_owners() {
    let mut input = peer("ts", "command-cases", None);
    let histories = input["histories"].as_array_mut().unwrap();
    assert!(histories.len() >= 40);
    let produced = peer("beam", "produce", None);
    for (i, history) in produced["histories"].as_array().unwrap().iter().enumerate() {
        let mut history = history.clone();
        history["name"] = json!(format!("fresh-beam-history-{i}"));
        histories.push(history);
    }
    histories.push(rust_command());
    let ts = peer("ts", "command-gates", Some(&input));
    let beam = peer("beam", "command-gates", Some(&input));
    let mut reasons = std::collections::BTreeSet::new();
    let mut deferred = 0;
    for (i, h) in input["histories"].as_array().unwrap().iter().enumerate() {
        let replica = h["replica"].as_str().unwrap();
        let frames = h["frames"].as_array().unwrap();
        let dag = checked(replica, frames);
        let native = summary(&dag);
        assert_eq!(native, ts["results"][i], "TS pre-policy case {}", h["name"]);
        assert_eq!(
            native, beam["results"][i],
            "BEAM pre-policy case {}",
            h["name"]
        );
        for v in native.as_object().unwrap().values() {
            if let Some(r) = v["reason"].as_str() {
                reasons.insert(r.to_string());
            } else {
                deferred += 1;
            }
        }
        let mut reverse = frames.clone();
        reverse.reverse();
        assert_eq!(native, summary(&checked(replica, &reverse)));
        let preflight = CommandPreflight::analyze(&dag).unwrap();
        assert!(preflight.command("unknown").is_none());
        assert!(!preflight.decisions().contains_key("unknown"));
    }
    for reason in [
        "no_capability",
        "invalid_capability",
        "wrong_replica",
        "capability_wrong_audience",
        "operation_not_granted",
        "capability_not_visible",
        "role_not_granted",
        "revoked_capability",
        "lease_expired",
        "not_holder",
        "stale_holder",
        "unknown_command",
        "bad_command_arity",
        "malformed_command",
    ] {
        assert!(reasons.contains(reason), "actually exercise {reason}");
    }
    assert!(
        deferred > 0,
        "passing gates still require application policy"
    );
}

/// Plan 316 PR 1 (D-375): BEAM and TS admit `replace_catalog_v1` to Stage A, but the
/// native table has no entry until plan 316 PR 5 (row 319). Native must fail closed
/// as `unknown_command` before Space policy or projection, and must not panic. A
/// future command-table edit that adds the command without a `space_policy` Stage A
/// check and a `space_projection` arm fails this test.
#[test]
fn native_refuses_replace_catalog_v1_as_unknown_command_without_panicking() {
    use treehouse_tauri_shell::catalog_eval::{space_policy::SpacePolicy, space_projection};
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../lattice-client/test/vectors/catalog/replacement_v1.json"
    )))
    .unwrap();
    let replica = fixture["replica"].as_str().unwrap();
    let base = fixture["frames"].as_array().unwrap().clone();
    let is_replace = |f: &Value| f["body"][1][0][1].as_str() == Some("replace_catalog_v1");
    let mut histories = vec![("valid-claim".to_string(), base.clone())];
    for case in fixture["stage_a"].as_array().unwrap() {
        let mut frames: Vec<Value> = base.iter().filter(|f| !is_replace(f)).cloned().collect();
        frames.extend(case["prefix"].as_array().unwrap().iter().cloned());
        frames.push(case["frame"].clone());
        histories.push((case["name"].as_str().unwrap().to_string(), frames));
    }
    assert_eq!(histories.len(), 17);
    for (name, frames) in histories {
        let dag = checked(replica, &frames);
        let ids: Vec<String> = frames.iter().filter(|f| is_replace(f)).map(id_of).collect();
        assert!(
            !ids.is_empty(),
            "{name}: carries a replace_catalog_v1 frame"
        );
        let preflight = CommandPreflight::analyze(&dag).unwrap();
        let policy = SpacePolicy::analyze(&dag).unwrap();
        let projection = std::panic::catch_unwind(|| space_projection::project(&dag))
            .unwrap_or_else(|_| panic!("{name}: native projection panicked"))
            .unwrap();
        for id in ids {
            assert!(
                matches!(
                    preflight.decisions().get(&id),
                    Some(PrePolicyDecision::Refused("unknown_command"))
                ),
                "{name}: native preflight refuses replace_catalog_v1 as unknown_command"
            );
            assert!(preflight.command(&id).is_none(), "{name}");
            assert_eq!(
                policy.command_reasons().get(&id),
                Some(&Some("unknown_command")),
                "{name}"
            );
            assert_eq!(
                projection.command_reasons.get(&id),
                Some(&Some("unknown_command")),
                "{name}"
            );
        }
    }
}
fn id_of(frame: &Value) -> String {
    frame["id"].as_str().unwrap().to_string()
}
