use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
#[path = "support/catalog_peer.rs"]
mod catalog_peer;
use treehouse_tauri_shell::catalog_eval::{
    canonical::{encode, Term},
    history::AuthenticDag,
    thread_policy,
};

fn text(value: &str) -> Value {
    json!(["bin", STANDARD.encode(value)])
}
fn signed(
    key: &SigningKey,
    replica: &str,
    deps: &[String],
    kind: &str,
    body: Value,
    cap: Value,
) -> Value {
    let fields = vec![
        Term::Binary(b"lattice-op-v2".to_vec()),
        Term::Binary(replica.as_bytes().to_vec()),
        Term::Binary(key.verifying_key().to_bytes().to_vec()),
        Term::List(
            deps.iter()
                .map(|id| Term::Binary(id.as_bytes().to_vec()))
                .collect(),
        ),
        Term::Atom(kind.into()),
        Term::from_carrier(&body).unwrap(),
        Term::from_carrier(&cap).unwrap(),
    ];
    let mut payload = vec![0x87];
    for field in fields {
        payload.extend(encode(&field).unwrap());
    }
    json!({"v":1,"id":URL_SAFE_NO_PAD.encode(Sha256::digest(&payload)),"replica":replica,
        "author":STANDARD.encode(key.verifying_key().to_bytes()),"deps":deps,"kind":kind,
        "body":body,"cap":cap,"sig":STANDARD.encode(key.sign(&payload).to_bytes())})
}
fn rust_histories() -> Vec<Value> {
    let key = SigningKey::from_bytes(&[89; 32]);
    let public = key.verifying_key().to_bytes();
    let replica = format!(
        "replica:treehouse:thread:{}#authority:bounded-continuation-v1#root:{}",
        URL_SAFE_NO_PAD.encode(Sha256::digest(b"rust-thread-policy")),
        URL_SAFE_NO_PAD.encode(Sha256::digest(public))
    );
    let mut ops = vec![
        "post",
        "author_edit",
        "author_tombstone",
        "moderator_tombstone",
        "archive_thread",
        "create_thread",
    ];
    ops.sort();
    let delegation_bytes = encode(&Term::List(vec![
        Term::Binary(b"lattice-delegation-v2".to_vec()),
        Term::Binary(replica.as_bytes().to_vec()),
        Term::Binary(public.to_vec()),
        Term::Binary(public.to_vec()),
        Term::Nil,
        Term::List(ops.iter().map(|s| Term::Atom((*s).into())).collect()),
        Term::List(vec![Term::Atom("moderator".into())]),
        Term::Bool(true),
    ]))
    .unwrap();
    let cap_id = URL_SAFE_NO_PAD.encode(Sha256::digest(&delegation_bytes));
    let delegation = json!(["delegation",{"id":cap_id,"replica":replica,"issuer":STANDARD.encode(public),
        "audience":STANDARD.encode(public),"parent_id":null,"ops":ops,"roles":["moderator"],"live":true,
        "sig":STANDARD.encode(key.sign(&delegation_bytes).to_bytes())}]);
    let genesis = signed(
        &key,
        &replica,
        &[],
        "authority",
        json!(["tuple", [["atom", "genesis"], delegation, ["map", []]]]),
        json!(["nil"]),
    );
    let command = |prior: &Value, name: &str, args: Vec<Value>| {
        signed(
            &key,
            &replica,
            &[prior["id"].as_str().unwrap().into()],
            "command",
            json!(["tuple", [["atom", name], ["list", args]]]),
            text(&cap_id),
        )
    };
    let creation = command(&genesis, "create_thread", vec![text("Rust thread")]);
    let post = command(&creation, "post", vec![text("\u{FEFF}original")]);
    let post_id = post["id"].as_str().unwrap();
    let malformed = command(
        &post,
        "author_edit",
        vec![text(post_id), text("absent"), json!(["int", 7])],
    );
    let refused = command(
        &malformed,
        "author_edit",
        vec![
            text(post_id),
            text(malformed["id"].as_str().unwrap()),
            text("cannot launder"),
        ],
    );
    let edit = command(
        &post,
        "author_edit",
        vec![text(post_id), text(post_id), text("valid replacement")],
    );
    let fork = command(
        &post,
        "author_edit",
        vec![text(post_id), text(post_id), text("concurrent replacement")],
    );
    let archive = command(&edit, "archive_thread", vec![]);
    let archived_post = command(&archive, "post", vec![text("refused after archive")]);
    let concurrent_post = command(&creation, "post", vec![text("concurrent second post")]);
    let concurrent_title = command(
        &genesis,
        "create_thread",
        vec![text("Concurrent Rust title")],
    );
    let deeper_title = command(
        &archived_post,
        "create_thread",
        vec![text("Deeper Rust title")],
    );
    let base = json!({"name":"rust-authored-policy-and-fork","replica":replica,
        "frames":[genesis,creation,post,malformed,refused,edit,fork,archive,archived_post,concurrent_post]});
    let mut title_fork = base.clone();
    title_fork["name"] = json!("rust-concurrent-title");
    title_fork["frames"]
        .as_array_mut()
        .unwrap()
        .push(concurrent_title);
    let mut deeper = title_fork.clone();
    deeper["name"] = json!("rust-depth-wins-title");
    deeper["frames"].as_array_mut().unwrap().push(deeper_title);
    vec![base, title_fork, deeper]
}

fn peer(runtime: &str, mode: &str, input: Option<&Value>) -> Value {
    serde_json::from_slice(&catalog_peer::output(
        runtime,
        mode,
        input,
        64 * 1024 * 1024,
    ))
    .expect("actual runtime result")
}
fn checked(history: &Value) -> AuthenticDag {
    let frames: Vec<_> = history["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| serde_json::to_vec(v).unwrap())
        .collect();
    AuthenticDag::authenticate(
        history["replica"].as_str().unwrap(),
        &frames.iter().map(Vec::as_slice).collect::<Vec<_>>(),
    )
    .unwrap()
}
fn native(history: &Value) -> Value {
    json!(thread_policy::analyze(&checked(history)).unwrap())
}

#[test]
fn causal_thread_policy_and_projection_match_both_actual_owners() {
    let mut input = peer("ts", "thread-policy-cases", None);
    let produced = peer("beam", "produce", None);
    input["histories"].as_array_mut().unwrap().extend(
        produced["histories"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|h| {
                h["replica"]
                    .as_str()
                    .unwrap()
                    .starts_with("replica:treehouse:thread:")
            })
            .cloned(),
    );
    input["histories"]
        .as_array_mut()
        .unwrap()
        .extend(rust_histories());
    let ts = peer("ts", "thread-policy", Some(&input));
    let beam = peer("beam", "thread-policy", Some(&input));
    let ts_projection = peer("ts", "thread-projection", Some(&input));
    let beam_projection = peer("beam", "thread-projection", Some(&input));
    let mut reasons = BTreeSet::new();
    let mut honored = 0;
    let mut lifecycle_checked = 0;
    assert!(input["histories"].as_array().unwrap().len() >= 15);
    for (i, history) in input["histories"].as_array().unwrap().iter().enumerate() {
        let actual = native(history);
        assert_eq!(actual, ts["results"][i], "TS {}", history["name"]);
        assert_eq!(actual, beam["results"][i], "BEAM {}", history["name"]);
        if let Some(reasons) = history.get("reasons") {
            let dag = checked(history);
            let authority =
                treehouse_tauri_shell::catalog_eval::authority::AuthorityEvidence::analyze(&dag)
                    .unwrap();
            for frame in history["frames"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|f| f["kind"] == "tombstone")
            {
                let id = frame["id"].as_str().unwrap();
                assert_eq!(
                    json!(authority.reasons().get(id)),
                    reasons[id],
                    "native lifecycle {}",
                    history["name"]
                );
                lifecycle_checked += 1;
            }
        }
        let projection = json!(thread_policy::project(&checked(history)).unwrap());
        if history["name"] == "rust-depth-wins-title" {
            assert_eq!(projection["title"], "Deeper Rust title");
            assert_eq!(projection["posts"].as_array().unwrap().len(), 2);
            assert_eq!(projection["archived"], true);
        }
        assert_eq!(
            projection, ts_projection["results"][i],
            "TS projection {}",
            history["name"]
        );
        assert_eq!(
            projection, beam_projection["results"][i],
            "BEAM projection {}",
            history["name"]
        );
        for reason in actual.as_object().unwrap().values() {
            if let Some(reason) = reason.as_str() {
                reasons.insert(reason.to_owned());
            } else {
                honored += 1;
            }
        }
        let mut reversed = history.clone();
        reversed["frames"].as_array_mut().unwrap().reverse();
        assert_eq!(
            actual,
            native(&reversed),
            "delivery order {}",
            history["name"]
        );
        assert_eq!(
            projection,
            json!(thread_policy::project(&checked(&reversed)).unwrap()),
            "projection delivery order {}",
            history["name"]
        );
    }
    for reason in [
        "application_target_not_visible",
        "application_target_quarantined",
        "application_wrong_target",
        "application_wrong_author",
        "application_already_tombstoned",
        "application_archived_thread",
    ] {
        assert!(reasons.contains(reason), "unexercised refusal {reason}");
    }
    assert!(honored > 20, "positive controls must actually be honored");
    assert!(
        lifecycle_checked >= 8,
        "root/nonroot/no-root lifecycle controls must execute"
    );
}
