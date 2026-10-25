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
