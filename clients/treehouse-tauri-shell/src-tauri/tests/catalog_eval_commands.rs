use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};
use treehouse_tauri_shell::catalog_eval::{
    canonical::{encode, Term},
    commands::{CommandPreflight, PrePolicyDecision},
    history::AuthenticDag,
};
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}
fn peer(runtime: &str, mode: &str, input: Option<&Value>) -> Value {
    let mut command = if runtime == "beam" {
        let shim = PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".asdf/shims/mix");
        let mut cmd = Command::new(if shim.is_file() { shim } else { "mix".into() });
        cmd.current_dir(root()).env("MIX_ENV", "test").args([
            "run",
            "--no-compile",
            "--no-start",
            "scripts/treehouse_native_catalog_history_peer.exs",
            mode,
        ]);
        cmd
    } else {
        let mut cmd = Command::new("node");
        cmd.current_dir(root().join("clients/lattice-client"))
            .args([
                "--import",
                "tsx",
                "test/support/native_catalog_history_peer.ts",
                mode,
            ]);
        cmd
    };
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("prepare real Node and BEAM prerequisites");
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
    assert!(
        output.stdout.len() <= 64 * 1024 * 1024,
        "bounded test corpus"
    );
    serde_json::from_slice(&output.stdout).expect("actual runtime JSON")
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
