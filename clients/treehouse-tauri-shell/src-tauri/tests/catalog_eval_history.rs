use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signer, SigningKey};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};
use treehouse_tauri_shell::catalog_eval::{
    canonical::{encode, Term},
    history::AuthenticDag,
};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}
fn signer() -> SigningKey {
    SigningKey::from_bytes(&[61; 32])
}
fn replica() -> String {
    format!(
        "replica:treehouse:thread:{}#authority:bounded-continuation-v1#root:{}",
        URL_SAFE_NO_PAD.encode(Sha256::digest(b"native-history")),
        URL_SAFE_NO_PAD.encode(Sha256::digest(signer().verifying_key().as_bytes()))
    )
}
fn signed(replica: &str, deps: &[String], message: &str) -> Value {
    let key = signer();
    let body = Term::Tuple(vec![
        Term::Atom("post".into()),
        Term::List(vec![Term::Binary(message.as_bytes().to_vec())]),
    ]);
    let deps: Vec<_> = deps
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let payload = encode(&Term::List(vec![
        Term::Binary(b"lattice-op-v2".to_vec()),
        Term::Binary(replica.as_bytes().to_vec()),
        Term::Binary(key.verifying_key().as_bytes().to_vec()),
        Term::List(
            deps.iter()
                .map(|id| Term::Binary(id.as_bytes().to_vec()))
                .collect(),
        ),
        Term::Atom("command".into()),
        body,
        Term::Nil,
    ]))
    .unwrap();
    json!({"v":1, "id":URL_SAFE_NO_PAD.encode(Sha256::digest(&payload)), "replica":replica,
        "author":STANDARD.encode(key.verifying_key().as_bytes()), "deps":deps, "kind":"command",
        "body":["tuple", [["atom", "post"], ["list", [["bin", STANDARD.encode(message.as_bytes())]]]]],
        "cap":["nil"], "sig":STANDARD.encode(key.sign(&payload).to_bytes())})
}
fn id(frame: &Value) -> String {
    frame["id"].as_str().unwrap().to_owned()
}
fn checked(
    replica: &str,
    frames: &[Value],
) -> Result<AuthenticDag, treehouse_tauri_shell::catalog_eval::history::HistoryError> {
    let encoded: Vec<_> = frames
        .iter()
        .map(|frame| serde_json::to_vec(frame).unwrap())
        .collect();
    AuthenticDag::authenticate(
        replica,
        &encoded.iter().map(Vec::as_slice).collect::<Vec<_>>(),
    )
}
fn fixture() -> Vec<Value> {
    let replica = replica();
    let root = signed(&replica, &[], "root");
    let left = signed(&replica, &[id(&root)], "left");
    let right = signed(&replica, &[id(&root)], "right");
    let join = signed(&replica, &[id(&left), id(&right)], "join");
    vec![root, left, right, join]
}

#[test]
fn authentic_dag_order_frontier_and_causality_ignore_delivery_order() {
    let frames = fixture();
    let dag = checked(&replica(), &frames).unwrap();
    let mut branches = vec![id(&frames[1]), id(&frames[2])];
    branches.sort();
    assert_eq!(
        dag.order(),
        &[vec![id(&frames[0])], branches, vec![id(&frames[3])]].concat()
    );
    assert_eq!(dag.frontier(), &[id(&frames[3])]);
    assert_eq!(dag.ancestors(&id(&frames[3])).unwrap().len(), 3);
    assert!(!dag
        .ancestors(&id(&frames[2]))
        .unwrap()
        .contains(id(&frames[1]).as_str()));
    assert!(!dag
        .ancestors(&id(&frames[1]))
        .unwrap()
        .contains(id(&frames[2]).as_str()));
    assert!(dag
        .ancestors(&id(&frames[3]))
        .unwrap()
        .contains(id(&frames[0]).as_str()));
    assert_eq!(dag.ancestors("unknown"), None);
    let verified = dag.frame(&id(&frames[1])).unwrap();
    assert_eq!(verified.author(), signer().verifying_key().as_bytes());
    assert_eq!(verified.kind(), "command");
    assert_eq!(verified.deps(), &[id(&frames[0])]);
    for permutation in [vec![3, 2, 1, 0], vec![2, 0, 3, 1], vec![1, 3, 0, 2]] {
        let shuffled = permutation
            .into_iter()
            .map(|index| frames[index].clone())
            .collect::<Vec<_>>();
        let other = checked(&replica(), &shuffled).unwrap();
        assert_eq!(dag.order(), other.order());
        assert_eq!(dag.frontier(), other.frontier());
    }
}
#[test]
fn normalized_dependencies_are_read_from_the_verified_payload() {
    let mut frames = fixture();
    let original = checked(&replica(), &frames).unwrap();
    let deps = frames[3]["deps"].as_array().unwrap().clone();
    frames[3]["deps"] = json!([deps[1], deps[0], deps[0]]);
    let aliased = checked(&replica(), &frames).unwrap();
    assert_eq!(aliased.order(), original.order());
    assert_eq!(aliased.frontier(), original.frontier());
    assert_eq!(
        aliased.frame(&id(&frames[3])).unwrap().deps(),
        original.frame(&id(&frames[3])).unwrap().deps()
    );
}
#[test]
fn forged_partial_evidence_is_invalid_before_missing_dependency_is_reported() {
    let frames = fixture();
    let partial = vec![frames[3].clone()];
    let missing = checked(&replica(), &partial).unwrap_err();
    let mut expected = vec![id(&frames[1]), id(&frames[2])];
    expected.sort();
    assert_eq!(missing.reason, "trust_pending");
    assert_eq!(missing.ids, expected);
    let mut forged = frames[0].clone();
    forged["sig"] = json!(STANDARD.encode([0; 64]));
    let error = checked(&replica(), &[frames[3].clone(), forged]).unwrap_err();
    assert_eq!(error.reason, "invalid_verified_history");
    assert!(error.ids.is_empty());
}
#[test]
fn duplicates_replica_mismatch_and_malformed_raw_input_refuse() {
    let frames = fixture();
    assert_eq!(
        checked(&replica(), &[frames[0].clone(), frames[0].clone()])
            .unwrap_err()
            .reason,
        "invalid_verified_history"
    );
    let other = signed("different-replica", &[], "valid other signature");
    assert_eq!(
        checked(&replica(), &[other]).unwrap_err().reason,
        "invalid_verified_history"
    );
    for raw in [&b"{"[..], &b""[..], &b"null"[..], &b"{}"[..]] {
        assert_eq!(
            AuthenticDag::authenticate(&replica(), &[raw])
                .unwrap_err()
                .reason,
            "invalid_verified_history"
        );
    }
    assert!(AuthenticDag::authenticate("", &[]).is_err());
    assert!(AuthenticDag::authenticate(&"x".repeat(64_001), &[]).is_err());
}
#[test]
fn long_authentic_chain_preserves_its_causal_past_without_recursive_stack_growth() {
    let mut frames = Vec::new();
    let mut previous = Vec::new();
    for index in 0..4096 {
        let frame = signed(&replica(), &previous, &index.to_string());
        previous = vec![id(&frame)];
        frames.push(frame);
    }
    let dag = checked(&replica(), &frames).unwrap();
    assert_eq!(dag.order().len(), 4096);
    assert_eq!(dag.frontier(), previous);
    assert_eq!(dag.ancestors(&previous[0]).unwrap().len(), 4095);
}
fn peer(runtime: &str, mode: &str, input: Option<&Value>) -> Value {
    static PEER_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = PEER_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let mut command = if runtime == "beam" {
        let shim = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".asdf/shims/mix");
        let mut command = Command::new(if shim.is_file() { shim } else { "mix".into() });
        command.current_dir(root()).env("MIX_ENV", "test").args([
            "run",
            "--no-compile",
            "--no-start",
            "scripts/treehouse_native_catalog_history_peer.exs",
            mode,
        ]);
        command
    } else {
        let mut command = Command::new("node");
        command
            .current_dir(root().join("clients/lattice-client"))
            .args([
                "--import",
                "tsx",
                "test/support/native_catalog_history_peer.ts",
                mode,
            ]);
        command
    };
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("prepare actual Node and BEAM peers before native reciprocal tests");
    if let Some(input) = input {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(input).unwrap())
            .unwrap();
    }
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{runtime} {mode}: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    // Test-only corpus contains deliberate depth-65 terms plus a case wrapper,
    // beyond serde's generic depth128. Production entry points retain their
    // separate seeded depth/node bounds; this local peer output is byte bounded.
    assert!(
        output.stdout.len() <= 256 * 1024 * 1024,
        "peer corpus budget"
    );
    let mut decoder = serde_json::Deserializer::from_slice(&output.stdout);
    decoder.disable_recursion_limit();
    let value = Value::deserialize(&mut decoder).unwrap_or_else(|error| {
        panic!(
            "actual {runtime} {mode} peer JSON: {error}: {}",
            String::from_utf8_lossy(&output.stdout[..output.stdout.len().min(192)])
        )
    });
    decoder.end().unwrap();
    value
}
#[test]
fn fresh_beam_and_ts_histories_are_authenticated_in_rust_and_both_consume_rust_graphs() {
    for runtime in ["beam", "ts"] {
        let produced = peer(runtime, "produce", None);
        for history in produced["histories"].as_array().unwrap() {
            let frames = history["frames"].as_array().unwrap();
            let dag = checked(history["replica"].as_str().unwrap(), frames).unwrap();
            assert_eq!(json!(dag.order()), history["order"], "{runtime}");
            assert_eq!(json!(dag.frontier()), history["frontier"], "{runtime}");
        }
    }
    let frames = fixture();
    let dag = checked(&replica(), &frames).unwrap();
    let produced = json!({"histories":[{"replica":dag.replica(), "frames":frames,
        "order":dag.order(), "frontier":dag.frontier()}]});
    for runtime in ["beam", "ts"] {
        assert_eq!(peer(runtime, "consume", Some(&produced))["histories"], 1);
    }
}

#[test]
fn native_codec_preserves_empty_delegation_text_fields_without_authorizing_them() {
    for runtime in ["beam", "ts"] {
        let produced = peer(runtime, "produce", None);
        for item in produced["terms"].as_array().unwrap() {
            let term = Term::from_carrier(&item["term"]).unwrap();
            assert_eq!(
                STANDARD.encode(encode(&term).unwrap()),
                item["bytes"],
                "{runtime}"
            );
        }
    }
}

fn observe_cutoff(input: &Value) -> Value {
    use treehouse_tauri_shell::catalog_eval::cutoff;
    match cutoff::derive(&serde_json::to_vec(input).unwrap()) {
        Ok(observed) => json!({"ok":true, "cutoff":{"replica":observed.replica(),
            "frontier":observed.frontier(), "logDigest":observed.log_digest()},
            "canonicalBytes":STANDARD.encode(observed.canonical_bytes())}),
        Err(error) => json!({"ok":false, "reason":error.reason}),
    }
}
fn compare_cutoff(input: &Value, expected: &Value, label: &str) {
    let observed = observe_cutoff(input);
    assert_eq!(observed["ok"], expected["ok"], "{label}: {observed}");
    if expected["ok"] == true {
        assert_eq!(observed["cutoff"], expected["cutoff"], "{label}");
        assert!(
            observed["canonicalBytes"] == expected["canonicalBytes"],
            "{label}: exact canonical bytes mismatch"
        );
    } else {
        assert_eq!(observed["reason"], expected["reason"], "{label}");
    }
}
#[test]
fn committed_cutoff_vectors_preserve_exact_accepted_and_structural_rejection_bytes() {
    let vectors: Value = serde_json::from_slice(
        &std::fs::read(root().join(
            "clients/lattice-client/test/vectors/catalog/cutoff_default_pre_member_continuity.json",
        ))
        .unwrap(),
    )
    .unwrap();
    for case in vectors["vectors"].as_array().unwrap() {
        let input = json!({"replica":case["replica"], "frames":case["frames"], "rejected":case["rejected"]});
        compare_cutoff(&input, &case["result"], case["name"].as_str().unwrap());
    }
}
#[test]
fn fresh_cutoff_producers_cover_portability_authentication_and_exact_push_boundaries() {
    let mut names = std::collections::BTreeSet::new();
    for runtime in ["beam", "ts"] {
        let produced = peer(runtime, "cutoffs", None);
        for case in produced["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            names.insert(name.to_owned());
            compare_cutoff(&case["input"], &case["result"], name);
            let mut reverse = case["input"].clone();
            reverse["frames"].as_array_mut().unwrap().reverse();
            reverse["rejected"].as_array_mut().unwrap().reverse();
            compare_cutoff(&reverse, &case["result"], &format!("{name} reversed"));
            if name == "ts-depth64" {
                let bytes = serde_json::to_vec(&case["input"]["frames"][0]).unwrap();
                assert!(treehouse_tauri_shell::catalog_eval::frame::verify(&bytes).is_ok());
            }
            if name == "ts-cutoff-larger-than-an-artifact" || name == "beam-large-observation" {
                let bytes = STANDARD
                    .decode(case["result"]["canonicalBytes"].as_str().unwrap())
                    .unwrap();
                assert!(bytes.len() > 128 * 1024);
                assert!(
                    treehouse_tauri_shell::catalog_eval::canonical::decode(&bytes).is_err(),
                    "aggregate observation must not widen the artifact reader"
                );
            }
        }
    }
    for name in [
        "ts-exact-push-limit",
        "ts-one-push-byte-over",
        "ts-forged-oversize-still-invalid",
        "ts-depth64",
        "ts-depth65-unsupported",
        "ts-all-139-portable-atoms",
        "beam-rejected-same-id-arbitrary-header",
    ] {
        assert!(names.contains(name), "actual producer must exercise {name}");
    }
    let frames = fixture();
    let mut rejected = frames[3].clone();
    rejected["sig"] = json!(STANDARD.encode([0; 64]));
    let input = json!({"replica":replica(), "frames":frames,
        "rejected":[{"frame":rejected, "reason":"bad_signature"}]});
    let result = observe_cutoff(&input);
    assert_eq!(result["ok"], true);
    let produced = json!({"cases":[{"input":input, "result":result}]});
    for runtime in ["beam", "ts"] {
        assert_eq!(
            peer(runtime, "consume-cutoffs", Some(&produced))["cases"],
            1
        );
    }
}
#[test]
fn cutoff_json_is_closed_and_the_complete_source_bound_does_not_become_an_artifact_bound() {
    use treehouse_tauri_shell::catalog_eval::cutoff;
    let empty = json!({"replica":replica(), "frames":[], "rejected":[]});
    let bytes = serde_json::to_vec(&empty).unwrap();
    let baseline = cutoff::derive(&bytes).unwrap();
    let mut full = bytes.clone();
    full.resize(64 * 1024 * 1024, b' ');
    let exact = cutoff::derive(&full).unwrap();
    assert_eq!(exact.canonical_bytes(), baseline.canonical_bytes());
    full.push(b' ');
    assert_eq!(
        cutoff::derive(&full).unwrap_err().reason,
        "unsupported_cutoff"
    );
    assert!(treehouse_tauri_shell::catalog_eval::json::parse(&full).is_err());
    assert!(treehouse_tauri_shell::catalog_eval::canonical::base64("", Some(usize::MAX)).is_err());
    let duplicate = format!(
        "{{\"replica\":\"wrong\",{}",
        String::from_utf8(bytes).unwrap().strip_prefix('{').unwrap()
    );
    assert_eq!(
        cutoff::derive(duplicate.as_bytes()).unwrap_err().reason,
        "invalid_verified_history"
    );
    let mut unknown = empty.clone();
    unknown["installed"] = json!(true);
    assert_eq!(
        observe_cutoff(&unknown)["reason"],
        "invalid_verified_history"
    );
}

fn term_wire(term: &Term) -> Value {
    match term {
        Term::Nil => json!(["nil"]),
        Term::Bool(v) => json!(["bool", v]),
        Term::Integer(v) => json!(["int", v.to_string()]),
        Term::Binary(v) => json!(["bin", STANDARD.encode(v)]),
        Term::Atom(v) => json!(["atom", v]),
        Term::List(v) | Term::Tuple(v) => json!([
            if matches!(term, Term::List(_)) {
                "list"
            } else {
                "tuple"
            },
            v.iter().map(term_wire).collect::<Vec<_>>()
        ]),
        Term::Map(v) => json!([
            "map",
            v.iter()
                .map(|(k, v)| json!([term_wire(k), term_wire(v)]))
                .collect::<Vec<_>>()
        ]),
        Term::Delegation(v) => {
            let mut d = json!({"id":String::from_utf8(v[0].clone().into_binary()).unwrap(),
                "replica":String::from_utf8(v[1].clone().into_binary()).unwrap(),
                "issuer":STANDARD.encode(v[2].clone().into_binary()), "audience":STANDARD.encode(v[3].clone().into_binary()),
                "parent_id": if v[4] == Term::Nil {Value::Null} else {json!(String::from_utf8(v[4].clone().into_binary()).unwrap())},
                "ops":v[5].clone().into_names(), "roles":v[6].clone().into_names(),
                "live":v[7] == Term::Bool(true), "sig":STANDARD.encode(v[8].clone().into_binary())});
            if let Some(Term::Integer(n)) = v.get(9) {
                d["expires_epoch"] = json!(n);
            }
            json!(["delegation", d])
        }
        _ => panic!("unsupported test term"),
    }
}
trait TestTerm {
    fn into_binary(self) -> Vec<u8>;
    fn into_names(self) -> Vec<String>;
}
impl TestTerm for Term {
    fn into_binary(self) -> Vec<u8> {
        let Term::Binary(b) = self else {
            panic!("binary")
        };
        b
    }
    fn into_names(self) -> Vec<String> {
        let Term::List(v) = self else { panic!("list") };
        v.into_iter()
            .map(|v| {
                let Term::Atom(n) = v else { panic!("atom") };
                n
            })
            .collect()
    }
}
fn authority_frame(key: &SigningKey, replica: &str, deps: &[String], body: Term) -> Value {
    term_frame(key, replica, deps, "authority", body, Term::Nil)
}
fn term_frame(
    key: &SigningKey,
    replica: &str,
    deps: &[String],
    kind: &str,
    body: Term,
    cap: Term,
) -> Value {
    let author = key.verifying_key().as_bytes().to_vec();
    let payload = encode(&Term::List(vec![
        Term::Binary(b"lattice-op-v2".to_vec()),
        Term::Binary(replica.as_bytes().to_vec()),
        Term::Binary(author.clone()),
        Term::List(
            deps.iter()
                .map(|id| Term::Binary(id.as_bytes().to_vec()))
                .collect(),
        ),
        Term::Atom(kind.into()),
        body.clone(),
        cap.clone(),
    ]))
    .unwrap();
    json!({"v":1,"id":URL_SAFE_NO_PAD.encode(Sha256::digest(&payload)),"replica":replica,"author":STANDARD.encode(author),"deps":deps,"kind":kind,
        "body":term_wire(&body),"cap":term_wire(&cap),"sig":STANDARD.encode(key.sign(&payload).to_bytes())})
}
fn delegation_term(
    key: &SigningKey,
    audience: &SigningKey,
    replica: &str,
    parent: Option<&str>,
    ops: &[&str],
    lease: Option<u64>,
) -> Term {
    let mut fields = vec![
        Term::Binary(b"lattice-delegation-v2".to_vec()),
        Term::Binary(replica.as_bytes().to_vec()),
        Term::Binary(key.verifying_key().as_bytes().to_vec()),
        Term::Binary(audience.verifying_key().as_bytes().to_vec()),
        parent
            .map(|id| Term::Binary(id.as_bytes().to_vec()))
            .unwrap_or(Term::Nil),
        Term::List(ops.iter().map(|s| Term::Atom(s.to_string())).collect()),
        Term::List(vec![]),
        Term::Bool(false),
    ];
    if let Some(epoch) = lease {
        fields[0] = Term::Binary(b"lattice-delegation-v3".to_vec());
        fields.push(Term::Integer(epoch));
    }
    let bytes = encode(&Term::List(fields.clone())).unwrap();
    let epoch = if lease.is_some() { fields.pop() } else { None };
    fields[0] = Term::Binary(URL_SAFE_NO_PAD.encode(Sha256::digest(&bytes)).into_bytes());
    fields.push(Term::Binary(key.sign(&bytes).to_bytes().to_vec()));
    if let Some(epoch) = epoch {
        fields.push(epoch);
    }
    Term::Delegation(fields)
}
fn delegation_id(d: &Term) -> String {
    let Term::Delegation(v) = d else {
        panic!("delegation")
    };
    String::from_utf8(v[0].clone().into_binary()).unwrap()
}
fn authority_body(name: &str, d: Term) -> Term {
    Term::Tuple(vec![Term::Atom(name.into()), d])
}
fn genesis_body(d: Term) -> Term {
    Term::Tuple(vec![Term::Atom("genesis".into()), d, Term::Map(vec![])])
}

fn static_summary(dag: &AuthenticDag, queries: &[(String, String)]) -> Value {
    use treehouse_tauri_shell::catalog_eval::delegations::{StaticDelegations, Validation};
    let analysis = StaticDelegations::analyze(dag).unwrap();
    let records: serde_json::Map<_,_> = analysis.records().iter().map(|(id,r)| {
        let validation = match r.validation() { Validation::Valid => json!({"valid":true}),
            Validation::Refused(reason) => json!({"valid":false,"reason":reason}),
            Validation::SuccessionCandidate(root) => json!({"valid":false,"reason":"succession_candidate","successionRootId":root}) };
        (id.clone(),json!({"validation":validation,"introductions":r.introductions(),"invalidIntroductions":r.invalid_introductions()}))
    }).collect();
    json!({"root":analysis.root().map(|key| STANDARD.encode(key)),"records":records,
        "active":analysis.records().iter().map(|(id,r)| (id.clone(),json!(r.validation() == &Validation::Valid))).collect::<serde_json::Map<_,_>>(),
        "reasons":analysis.reasons(), "revokes":analysis.revokes(),"revoked":queries.iter().map(|(op,d)| analysis.revoked_as_of(op,d).unwrap()).collect::<Vec<_>>()})
}
#[test]
fn native_static_delegations_match_real_beam_and_ts_with_causal_revocation() {
    // Real producers are checked too: the native prefix must see both the
    // ordinary root and the distinct empty profile pin without conflating them.
    for runtime in ["beam", "ts"] {
        for history in peer(runtime, "produce", None)["histories"]
            .as_array()
            .unwrap()
        {
            let dag = checked(
                history["replica"].as_str().unwrap(),
                history["frames"].as_array().unwrap(),
            )
            .unwrap();
            let native = static_summary(&dag, &[]);
            let mut input = history.clone();
            input["queries"] = json!([]);
            input["reasonIds"] = json!(native["reasons"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>());
            input["delegationIds"] = json!(native["records"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>());
            let ts = peer("ts", "delegations", Some(&input));
            assert_eq!(native, ts);
            let beam = peer("beam", "delegations", Some(&input));
            assert_eq!(native["root"], beam["root"]);
            assert_eq!(native["active"], beam["active"]);
            assert_eq!(native["reasons"], beam["reasons"]);
        }
    }
    let root = signer();
    let member = SigningKey::from_bytes(&[62; 32]);
    let stranger = SigningKey::from_bytes(&[63; 32]);
    let replica = replica();
    let d = delegation_term(&root, &root, &replica, None, &["post"], Some(10));
    let genesis = authority_frame(&root, &replica, &[], genesis_body(d.clone()));
    let child = delegation_term(
        &root,
        &member,
        &replica,
        Some(&delegation_id(&d)),
        &["post"],
        Some(9),
    );
    let grant = authority_frame(
        &root,
        &replica,
        &[id(&genesis)],
        authority_body("grant", child.clone()),
    );
    let early = signed(&replica, &[id(&grant)], "before revoke");
    let revoke = authority_frame(
        &root,
        &replica,
        &[id(&early)],
        authority_body("revoke", Term::Binary(delegation_id(&d).into_bytes())),
    );
    let concurrent = signed(&replica, &[id(&grant)], "concurrent");
    let after = signed(&replica, &[id(&revoke)], "after revoke");
    let wrong = authority_frame(
        &stranger,
        &replica,
        &[id(&grant)],
        authority_body("revoke", Term::Binary(delegation_id(&child).into_bytes())),
    );
    let mut bad = child.clone();
    if let Term::Delegation(v) = &mut bad {
        v[8] = Term::Binary(vec![0; 64]);
    }
    let forgery = authority_frame(
        &root,
        &replica,
        &[id(&genesis)],
        authority_body("grant", bad),
    );
    let unleased = delegation_term(
        &root,
        &member,
        &replica,
        Some(&delegation_id(&d)),
        &["post"],
        None,
    );
    let escalation = delegation_term(
        &root,
        &member,
        &replica,
        Some(&delegation_id(&d)),
        &["archive_thread", "post"],
        Some(9),
    );
    let mut frames = vec![
        genesis,
        grant,
        early.clone(),
        revoke,
        concurrent.clone(),
        after.clone(),
        wrong,
        forgery,
    ];
    for invalid in [unleased, escalation] {
        frames.push(authority_frame(
            &root,
            &replica,
            &[],
            authority_body("grant", invalid),
        ));
    }
    // Missing/invalid parents, foreign embedded scope, conditional succession
    // and a child-shaped genesis all remain authentic signed evidence.
    let missing = delegation_term(
        &root,
        &member,
        &replica,
        Some("withheld-delegation"),
        &["post"],
        Some(8),
    );
    let foreign = delegation_term(&root, &root, "foreign-replica", None, &["post"], None);
    let unrooted = delegation_term(&member, &member, &replica, None, &["post"], None);
    let nongenesis = delegation_term(&member, &root, &replica, None, &["post"], None);
    let candidate = delegation_term(&stranger, &stranger, &replica, None, &["post"], None);
    let candidate_child = delegation_term(
        &stranger,
        &member,
        &replica,
        Some(&delegation_id(&candidate)),
        &["post"],
        None,
    );
    let invalid_parent = delegation_term(
        &member,
        &stranger,
        &replica,
        Some(&delegation_id(&unrooted)),
        &["post"],
        None,
    );
    for term in [
        missing,
        foreign,
        unrooted,
        nongenesis,
        candidate_child,
        invalid_parent,
    ] {
        frames.push(authority_frame(
            &root,
            &replica,
            &[],
            authority_body("grant", term),
        ));
    }
    frames.push(authority_frame(
        &root,
        &replica,
        &[],
        Term::Tuple(vec![
            Term::Atom("succeed".into()),
            Term::Atom("moderator".into()),
            candidate,
            Term::Integer(1),
        ]),
    ));
    frames.push(authority_frame(
        &root,
        &replica,
        &[id(&frames[1])],
        genesis_body(child.clone()),
    ));
    // Same-id bad introduction both before and after the genuine grant.
    let mut forgery_after = frames[7].clone();
    let bad_term = Term::from_carrier(&forgery_after["body"]).unwrap();
    forgery_after = authority_frame(&root, &replica, &[id(&after)], bad_term);
    frames.push(forgery_after);
    let queries = vec![
        (id(&early), delegation_id(&child)),
        (id(&concurrent), delegation_id(&child)),
        (id(&after), delegation_id(&child)),
    ];
    let dag = checked(&replica, &frames).unwrap();
    let native = static_summary(&dag, &queries);
    assert_eq!(native["revoked"], json!([false, true, true]));
    let input = json!({"replica":replica,"frames":frames,"queries":queries.iter().map(|(op,d)| json!({"op":op,"delegation":d})).collect::<Vec<_>>(),
        "reasonIds":native["reasons"].as_object().unwrap().keys().collect::<Vec<_>>(),
        "delegationIds":native["records"].as_object().unwrap().keys().collect::<Vec<_>>()});
    assert_eq!(native, peer("ts", "delegations", Some(&input)));
    let beam = peer("beam", "delegations", Some(&input));
    assert_eq!(native["root"], beam["root"]);
    assert_eq!(native["active"], beam["active"]);
    assert_eq!(native["reasons"], beam["reasons"]);
    let mut reversed = frames.clone();
    reversed.reverse();
    assert_eq!(
        native,
        static_summary(&checked(&replica, &reversed).unwrap(), &queries)
    );
    use treehouse_tauri_shell::catalog_eval::delegations::StaticDelegations;
    let a = StaticDelegations::analyze(&dag).unwrap();
    assert_eq!(a.revoked_as_of("absent", &delegation_id(&child)), None);
    assert_eq!(a.revoked_as_of(&id(&early), "absent"), None);
    assert!(a
        .reasons()
        .values()
        .any(|reason| *reason == "invalid_genesis"));
    assert!(a
        .reasons()
        .values()
        .any(|reason| *reason == "unauthorized_revoke"));
}

#[test]
fn authentic_semantic_malformations_do_not_erase_static_evidence() {
    use treehouse_tauri_shell::catalog_eval::delegations::StaticDelegations;
    let replica = replica();
    let root = signer();
    let d = delegation_term(&root, &root, &replica, None, &["post"], None);
    let genesis = authority_frame(&root, &replica, &[], genesis_body(d.clone()));
    let bad_grant = authority_frame(
        &root,
        &replica,
        &[id(&genesis)],
        authority_body("grant", Term::Nil),
    );
    let bad_revoke = authority_frame(
        &root,
        &replica,
        &[id(&bad_grant)],
        authority_body("revoke", Term::Atom("post".into())),
    );
    let frames = vec![genesis, bad_grant, bad_revoke.clone()];
    let dag = checked(&replica, &frames).unwrap();
    let analysis = StaticDelegations::analyze(&dag).unwrap();
    assert_eq!(analysis.records().len(), 1);
    assert_eq!(
        analysis.root(),
        Some(root.verifying_key().as_bytes().as_slice())
    );
    assert_eq!(
        analysis.reasons().get(&id(&bad_revoke)),
        Some(&"unauthorized_revoke")
    );
    let native = static_summary(&dag, &[]);
    let input = json!({"replica":replica,"frames":frames,"queries":[],"delegationIds":[delegation_id(&d)],"reasonIds":[id(&bad_revoke)]});
    let beam = peer("beam", "delegations", Some(&input));
    assert_eq!(native["root"], beam["root"]);
    assert_eq!(native["active"], beam["active"]);
    assert_eq!(native["reasons"], beam["reasons"]);
    // The existing TS semantic decoder is a later stage, with its own malformed
    // operation reasons. Compare preserved root/collection, not a final verdict.
    let ts = peer("ts", "delegations", Some(&input));
    assert_eq!(native["root"], ts["root"]);
    assert_eq!(native["records"], ts["records"]);
}

fn authority_summary(dag: &AuthenticDag) -> Result<Value, &'static str> {
    use treehouse_tauri_shell::catalog_eval::authority::AuthorityEvidence;
    let a = AuthorityEvidence::analyze(dag)?;
    let acquires:serde_json::Map<_,_>=a.timelines().iter().map(|(r,t)|(r.clone(),json!(t.acquires().iter().map(|v|json!({"opId":v.op_id(),"holder":STANDARD.encode(v.holder()),"tick":v.at_tick().to_string()})).collect::<Vec<_>>()))).collect();
    let epochs: serde_json::Map<_, _> = a
        .timelines()
        .iter()
        .map(|(r, t)| (r.clone(), json!(t.acquires().last().map(|v| v.op_id()))))
        .collect();
    let holders: serde_json::Map<_, _> = a
        .timelines()
        .iter()
        .map(|(r, t)| {
            (
                r.clone(),
                json!(t.acquires().last().map(|v| STANDARD.encode(v.holder()))),
            )
        })
        .collect();
    let mut beacons: Vec<_> = a
        .beacons()
        .iter()
        .map(|(id, epoch)| (id, epoch.to_string()))
        .collect();
    beacons.sort();
    Ok(
        json!({"reasons":a.reasons(),"epochs":epochs,"holders":holders,"acquires":acquires,"beacons":beacons}),
    )
}
#[test]
fn native_bounded_roles_and_continuation_match_actual_runtime_corpora() {
    let mut histories = Vec::new();
    for runtime in ["beam", "ts"] {
        let produced = peer(runtime, "authority-cases", None);
        for history in produced["histories"].as_array().unwrap() {
            let replica = history["replica"].as_str().unwrap();
            let dag = checked(replica, history["frames"].as_array().unwrap()).unwrap();
            let native = authority_summary(&dag);
            if replica.starts_with("replica:legacy:")
                || replica.contains("bad-nonce")
                || replica.contains("bad\nnonce")
                || replica.contains("bad\u{2028}nonce")
                || replica.contains("bounded-continuation-v2")
            {
                assert_eq!(native.unwrap_err(), "unsupported_authority_profile");
            } else {
                native.unwrap();
                histories.push(history.clone());
            }
        }
    }
    assert!(
        histories.len() >= 50,
        "exercise complete current bounded continuation corpus"
    );
    let authored = peer("ts", "authority-cases", None);
    for base in authored["histories"].as_array().unwrap() {
        for mutation in [
            "valid-new-lease",
            "wrong-epoch",
            "wrong-predecessor",
            "surplus-signature",
            "reverse-signatures",
        ] {
            histories.push(rust_continuation_case(base, mutation));
        }
    }
    histories.push(rust_beacon_history());
    let input = json!({"histories":histories});
    let beam = peer("beam", "authority", Some(&input));
    let ts = peer("ts", "authority", Some(&input));
    for (i, history) in histories.iter().enumerate() {
        let dag = checked(
            history["replica"].as_str().unwrap(),
            history["frames"].as_array().unwrap(),
        )
        .unwrap();
        let native = authority_summary(&dag).unwrap();
        assert_eq!(native, ts["results"][i], "TS case {}", history["name"]);
        let mut common = native.clone();
        common.as_object_mut().unwrap().remove("acquires");
        assert_eq!(common, beam["results"][i], "BEAM case {}", history["name"]);
        let mut reversed = history["frames"].as_array().unwrap().clone();
        reversed.reverse();
        assert_eq!(
            native,
            authority_summary(&checked(dag.replica(), &reversed).unwrap()).unwrap()
        );
    }
}

fn atom_map(values: Vec<(&str, Term)>) -> Term {
    Term::Map(
        values
            .into_iter()
            .map(|(k, v)| (Term::Atom(k.into()), v))
            .collect(),
    )
}
fn set_field(t: &mut Term, name: &str, value: Term) {
    let Term::Map(m) = t else { panic!("map") };
    m.iter_mut()
        .find(|(k, _)| *k == Term::Atom(name.into()))
        .unwrap()
        .1 = value;
}
fn witness_certificate(claim: Term, witnesses: &[SigningKey], domain: &str) -> Term {
    let bytes = encode(&Term::List(vec![
        Term::Binary(domain.as_bytes().to_vec()),
        claim.clone(),
    ]))
    .unwrap();
    let mut signatures: Vec<_> = witnesses
        .iter()
        .map(|w| {
            (
                w.verifying_key().as_bytes().to_vec(),
                w.sign(&bytes).to_bytes().to_vec(),
            )
        })
        .collect();
    signatures.sort();
    atom_map(vec![
        ("claim", claim),
        (
            "signatures",
            Term::List(
                signatures
                    .into_iter()
                    .map(|(w, s)| {
                        atom_map(vec![
                            ("witness", Term::Binary(w)),
                            ("signature", Term::Binary(s)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
}
fn rust_continuation_case(base: &Value, mutation: &str) -> Value {
    let replica = base["replica"].as_str().unwrap();
    let mut frames = base["frames"].as_array().unwrap().clone();
    let last = frames.pop().unwrap();
    let Term::Tuple(mut body) = Term::from_carrier(&last["body"]).unwrap() else {
        panic!("tuple")
    };
    let key = SigningKey::from_bytes(&[if base["kind"] == "space" { 2 } else { 3 }; 32]);
    let Term::Delegation(v) = &mut body[2] else {
        panic!("delegation")
    };
    v[9] = Term::Integer(10);
    let mut signing = vec![Term::Binary(b"lattice-delegation-v3".to_vec())];
    signing.extend_from_slice(&v[1..8]);
    signing.push(v[9].clone());
    let bytes = encode(&Term::List(signing)).unwrap();
    v[0] = Term::Binary(URL_SAFE_NO_PAD.encode(Sha256::digest(&bytes)).into_bytes());
    v[8] = Term::Binary(key.sign(&bytes).to_bytes().to_vec());
    let new_id = v[0].clone();
    let Term::Tuple(proof) = &body[3] else {
        panic!("proof")
    };
    let Term::Map(cert) = &proof[1] else {
        panic!("certificate")
    };
    let mut claim = cert
        .iter()
        .find(|(k, _)| *k == Term::Atom("claim".into()))
        .unwrap()
        .1
        .clone();
    set_field(&mut claim, "delegation_id", new_id);
    if mutation == "wrong-epoch" {
        set_field(&mut claim, "epoch", Term::Integer(6));
    }
    if mutation == "wrong-predecessor" {
        set_field(
            &mut claim,
            "holder_epoch",
            Term::Binary(
                URL_SAFE_NO_PAD
                    .encode(Sha256::digest(b"wrong-predecessor"))
                    .into_bytes(),
            ),
        );
    }
    let witnesses = [
        SigningKey::from_bytes(&[4; 32]),
        SigningKey::from_bytes(&[5; 32]),
    ];
    let mut cert = witness_certificate(claim, &witnesses, "lattice-continuation-witness-v1");
    if mutation == "surplus-signature" || mutation == "reverse-signatures" {
        let Term::Map(fields) = &mut cert else {
            panic!("cert")
        };
        let (_, Term::List(sigs)) = fields
            .iter_mut()
            .find(|(k, _)| *k == Term::Atom("signatures".into()))
            .unwrap()
        else {
            panic!("signatures")
        };
        if mutation == "reverse-signatures" {
            sigs.reverse();
        } else {
            sigs.push(atom_map(vec![
                (
                    "witness",
                    Term::Binary(
                        SigningKey::from_bytes(&[66; 32])
                            .verifying_key()
                            .as_bytes()
                            .to_vec(),
                    ),
                ),
                ("signature", Term::Binary(vec![0; 64])),
            ]));
        }
    }
    body[3] = Term::Tuple(vec![Term::Atom("continuation_v1".into()), cert]);
    let deps: Vec<_> = last["deps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect();
    let frame = authority_frame(&key, replica, &deps, Term::Tuple(body));
    let final_id = id(&frame);
    frames.push(frame);
    let history = json!({"name":format!("rust-{}-{mutation}",base["kind"]),"replica":replica,"frames":frames});
    let native =
        authority_summary(&checked(replica, history["frames"].as_array().unwrap()).unwrap())
            .unwrap();
    let expected = match mutation {
        "valid-new-lease" => None,
        "wrong-epoch" => Some("invalid_continuation_epoch"),
        _ => Some("invalid_continuation_certificate"),
    };
    assert_eq!(
        native["reasons"][&final_id],
        json!(expected),
        "new Rust continuation case {mutation}"
    );
    history
}
fn rust_beacon_history() -> Value {
    let replica = replica();
    let root = signer();
    let witnesses = [
        SigningKey::from_bytes(&[64; 32]),
        SigningKey::from_bytes(&[65; 32]),
    ];
    let mut pubkeys: Vec<_> = witnesses
        .iter()
        .map(|w| Term::Binary(w.verifying_key().as_bytes().to_vec()))
        .collect();
    pubkeys.sort_by_key(|t| t.clone().into_binary());
    let policy = atom_map(vec![
        ("mode", Term::Atom("witnessed".into())),
        ("version", Term::Integer(1)),
        ("witnesses", Term::List(pubkeys)),
        ("threshold", Term::Integer(2)),
        ("max_epoch_step", Term::Integer(10)),
    ]);
    let d = delegation_term(&root, &root, &replica, None, &["post"], Some(10));
    let genesis = authority_frame(
        &root,
        &replica,
        &[],
        Term::Tuple(vec![
            Term::Atom("genesis".into()),
            d.clone(),
            atom_map(vec![("__beacon__", policy)]),
        ]),
    );
    let child = delegation_term(
        &root,
        &root,
        &replica,
        Some(&delegation_id(&d)),
        &["post"],
        Some(2),
    );
    let grant = authority_frame(
        &root,
        &replica,
        &[id(&genesis)],
        authority_body("grant", child.clone()),
    );
    let post = |deps: &[String], message: &str| {
        term_frame(
            &root,
            &replica,
            deps,
            "command",
            Term::Tuple(vec![
                Term::Atom("post".into()),
                Term::List(vec![Term::Binary(message.as_bytes().to_vec())]),
            ]),
            Term::Binary(delegation_id(&child).into_bytes()),
        )
    };
    let beacon = |deps: &[String], epoch: u64| {
        let author = &witnesses[0];
        let claim = atom_map(vec![
            ("version", Term::Integer(1)),
            ("replica", Term::Binary(replica.as_bytes().to_vec())),
            ("epoch", Term::Integer(epoch)),
            (
                "author",
                Term::Binary(author.verifying_key().as_bytes().to_vec()),
            ),
            (
                "deps",
                Term::List(
                    deps.iter()
                        .map(|s| Term::Binary(s.as_bytes().to_vec()))
                        .collect(),
                ),
            ),
        ]);
        authority_frame(
            author,
            &replica,
            deps,
            Term::Tuple(vec![
                Term::Atom("beacon".into()),
                Term::Integer(epoch),
                witness_certificate(claim, &witnesses, "lattice-beacon-witness-v1"),
            ]),
        )
    };
    let early = post(&[id(&grant)], "early");
    let boundary = beacon(&[id(&early)], 2);
    let equality = post(&[id(&boundary)], "equality");
    let lapse = beacon(&[id(&equality)], 3);
    let concurrent = post(&[id(&grant)], "concurrent");
    let late = post(&[id(&lapse)], "late");
    let stale = beacon(&[id(&late)], 3);
    let jump = beacon(&[id(&late)], 14);
    let malformed = beacon(&[id(&late)], u64::MAX);
    let mut frames = vec![
        genesis,
        grant,
        early.clone(),
        boundary,
        equality.clone(),
        lapse,
        concurrent.clone(),
        late.clone(),
        stale.clone(),
        jump.clone(),
    ];
    let mut deps = vec![id(&late), id(&concurrent), id(&stale), id(&jump)];
    deps.sort();
    frames.push(authority_frame(
        &root,
        &replica,
        &deps,
        authority_body("beacon", Term::Integer(u64::MAX)),
    ));
    let dag = checked(&replica, &frames).unwrap();
    let a =
        treehouse_tauri_shell::catalog_eval::authority::AuthorityEvidence::analyze(&dag).unwrap();
    for (op, expected) in [
        (&early, false),
        (&equality, false),
        (&concurrent, true),
        (&late, true),
    ] {
        assert_eq!(
            a.expired_as_of(&id(op), &delegation_id(&child)),
            Some(expected)
        );
    }
    assert_eq!(a.expired_as_of("missing", &delegation_id(&child)), None);
    assert_eq!(a.expired_as_of(&id(&early), "missing"), None);
    assert_eq!(a.reasons().get(&id(&stale)), Some(&"stale_beacon"));
    assert_eq!(a.reasons().get(&id(&jump)), Some(&"unauthorized_beacon"));
    let mut raw_frames = frames.clone();
    raw_frames.push(malformed.clone());
    let raw_dag = checked(&replica, &raw_frames).unwrap();
    let raw = authority_summary(&raw_dag).unwrap();
    assert_eq!(raw["reasons"][id(&malformed)], json!("malformed_term"));
    // The raw BEAM authority component classifies this retained witnessed
    // uint64 input. TS's later strict carrier reader refuses its precision;
    // do not misrepresent it as a portable catalog history.
    let actual = peer(
        "beam",
        "authority",
        Some(&json!({"histories":[{"replica":replica,"frames":raw_frames}]})),
    );
    let mut common = raw;
    common.as_object_mut().unwrap().remove("acquires");
    assert_eq!(common, actual["results"][0]);
    assert_eq!(
        peer(
            "ts",
            "strict-portability",
            Some(&json!({"histories":[
                {"frames":raw_frames},{"frames":frames}
            ]}))
        )["portable"],
        json!([false, true])
    );
    json!({"name":"rust-witnessed-beacon-and-causal-expiry","replica":replica,"frames":frames,
        "expiryQueries":[[id(&early),false],[id(&equality),false],[id(&concurrent),true],[id(&late),true]],"delegationId":delegation_id(&child)})
}
