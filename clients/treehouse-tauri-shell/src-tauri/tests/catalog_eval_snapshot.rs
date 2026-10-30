use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use treehouse_tauri_shell::catalog_eval::snapshot::UnverifiedSnapshot;
#[path = "support/catalog_peer.rs"]
mod catalog_peer;
fn parsed(value: &Value) -> Result<UnverifiedSnapshot, &'static str> {
    UnverifiedSnapshot::parse(&serde_json::to_vec(value).unwrap())
}
fn id(label: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(label.as_ref()))
}
fn corpus() -> Value {
    let output = catalog_peer::output("ts", "snapshot-shapes", None, 4 * 1024 * 1024);
    let mut decoder = serde_json::Deserializer::from_slice(&output);
    decoder.disable_recursion_limit();
    let table = Value::deserialize(&mut decoder).unwrap();
    decoder.end().unwrap();
    table
}
fn base() -> Value {
    corpus()["states"][1].clone()
}
#[test]
fn source_decimal_values_are_preserved_exactly() {
    let table = corpus();
    for state in table["states"].as_array().unwrap() {
        assert!(parsed(state).is_ok());
    }
    for case in table["numerics"].as_array().unwrap() {
        let actual = UnverifiedSnapshot::parse(case["json"].as_str().unwrap().as_bytes()).unwrap();
        assert_eq!(
            actual.raw()["accepted"]["generation"].as_f64(),
            case["value"].as_f64(),
            "{}",
            case["lexeme"]
        );
    }
}
#[test]
fn source_container_depth_is_preserved_exactly() {
    let table = corpus();
    for case in table["depthCases"].as_array().unwrap() {
        assert_eq!(
            UnverifiedSnapshot::parse(case["json"].as_str().unwrap().as_bytes()).is_ok(),
            case["withinSourceBounds"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn actual_public_snapshot_shape_is_owned_but_never_confused_with_verified_state() {
    let mut state = base();
    let saved = state.clone();
    let mut bytes = serde_json::to_vec(&state).unwrap();
    let owned = UnverifiedSnapshot::parse(&bytes).unwrap();
    bytes.fill(b'!');
    state["accepted"] = Value::Null;
    assert_eq!(owned.raw(), &saved);
    // Structural ownership intentionally does not certify these valid-shaped
    // false claims. The original-only graph/authentication pass must reject them.
    let mut forged = saved.clone();
    forged["histories"][0]["frames"][0]["sig"] = json!("forged");
    forged["accepted"]["catalog"] = json!(id("absent catalog"));
    assert!(parsed(&forged).is_ok());
    // Non-null blocks and populated witness/trigger metadata are structurally
    // expressible even when their claims cannot survive original-state replay.
    let bootstrap = saved["review"]["bootstrapId"].clone();
    forged["blocked"] = json!({"reason":"authority_changed","bindings":[],"catalogs":[],"bootstrapIds":[],"opIds":[bootstrap],"pendingProofIds":[],
        "triggers":[{"kind":"catalog","id":id("trigger"),"digest":id("digest"),"bytes":1}],
        "authorityWitnesses":[{"replica":saved["review"]["space"],"frontier":[bootstrap],"opIds":[bootstrap]}]});
    assert!(parsed(&forged).is_ok());
    let mut shared_id = saved.clone();
    shared_id["rotations"] = json!([shared_id["catalogs"][0]]);
    assert!(parsed(&shared_id).is_ok());
    let mut exponent = saved.clone();
    exponent["version"] = json!(1.0);
    exponent["accepted"]["generation"] = json!(0.0);
    assert!(parsed(&exponent).is_ok());
}
#[test]
fn foreign_missing_noncanonical_and_unsafe_saved_metadata_require_recovery() {
    let state = base();
    let mut cases = Vec::new();
    let mut changed = state.clone();
    changed["foreign"] = Value::Null;
    cases.push(changed);
    let mut changed = state.clone();
    changed["review"]["foreign"] = Value::Null;
    cases.push(changed);
    let mut changed = state.clone();
    changed.as_object_mut().unwrap().remove("blocked");
    cases.push(changed);
    let mut changed = state.clone();
    changed["review"]["disposition"] = json!("trust_latest");
    cases.push(changed);
    let mut changed = state.clone();
    changed["review"]["spaceRoot"] = json!("A".repeat(44));
    cases.push(changed);
    let mut changed = state.clone();
    changed["review"]["space"] = json!("replica:treehouse:space:legacy");
    cases.push(changed);
    let mut changed = state.clone();
    changed["review"]["bootstrapId"] = json!("x".repeat(43));
    cases.push(changed);
    let mut changed = state.clone();
    changed["review"]["observedBootstrapIds"] = json!([
        state["review"]["bootstrapId"],
        state["review"]["bootstrapId"]
    ]);
    cases.push(changed);
    let mut changed = state.clone();
    changed["catalogs"]
        .as_array_mut()
        .unwrap()
        .push(state["catalogs"][0].clone());
    cases.push(changed);
    let mut changed = state.clone();
    changed["catalogs"][0]["foreign"] = Value::Null;
    cases.push(changed);
    let mut changed = state.clone();
    changed["accepted"]["generation"] = json!(9_007_199_254_740_992u64);
    cases.push(changed);
    let mut changed = state.clone();
    changed["accepted"]["revision"] = json!("0");
    cases.push(changed);
    let mut changed = state.clone();
    changed["accepted"]["revision"] = json!(1.5);
    cases.push(changed);
    let mut changed = state.clone();
    changed["review"]["observedBootstrapIds"] = json!([id("absent-bootstrap")]);
    cases.push(changed);
    let mut changed = state.clone();
    let mut reversed = vec![
        id("other-observed"),
        state["review"]["bootstrapId"].as_str().unwrap().to_owned(),
    ];
    reversed.sort();
    reversed.reverse();
    changed["review"]["observedBootstrapIds"] = json!(reversed);
    cases.push(changed);
    let mut changed = state.clone();
    changed["histories"][0]["rejected"] = json!([{"frame":{},"reason":"repaired"}]);
    cases.push(changed);
    let block = json!({"reason":"authority_changed","bindings":[],"catalogs":[],"bootstrapIds":[],"opIds":[],"pendingProofIds":[],"triggers":[],"authorityWitnesses":[]});
    let mut changed = state.clone();
    changed["blocked"] = block.clone();
    changed["blocked"]["authorityWitnesses"] =
        json!([{"replica":"space","frontier":[],"opIds":[],"foreign":0}]);
    cases.push(changed);
    let mut changed = state.clone();
    changed["blocked"] = block;
    changed["blocked"]["triggers"] =
        json!([{"kind":"catalog","id":id("trigger"),"digest":id("digest"),"bytes":-1}]);
    cases.push(changed);
    for (index, changed) in cases.iter().enumerate() {
        assert_eq!(
            parsed(changed).unwrap_err(),
            "trust_recovery_required",
            "case {index}"
        );
    }
    let original = serde_json::to_string(&state).unwrap();
    assert_eq!(
        UnverifiedSnapshot::parse(format!("{original} trailing").as_bytes()).unwrap_err(),
        "trust_recovery_required"
    );
    let duplicate = format!("{{\"version\":1,{}", &original[1..]);
    assert_eq!(
        UnverifiedSnapshot::parse(duplicate.as_bytes()).unwrap_err(),
        "trust_recovery_required"
    );
}
#[test]
fn retained_storage_and_artifact_budgets_are_exact_before_graph_replay() {
    let state = base();
    let mut exact = serde_json::to_vec(&state).unwrap();
    exact.resize(32 * 1024 * 1024, b' ');
    assert!(UnverifiedSnapshot::parse(&exact).is_ok());
    exact.push(b' ');
    assert_eq!(
        UnverifiedSnapshot::parse(&exact).unwrap_err(),
        "trust_recovery_required"
    );
    drop(exact);
    let mut count = state.clone();
    count["rotations"] = json!([]);
    count["catalogs"] = Value::Array(
        (0u32..1024)
            .map(|n| json!({"id":id(n.to_be_bytes()),"json":""}))
            .collect(),
    );
    assert!(parsed(&count).is_ok());
    count["catalogs"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":id("extra"),"json":""}));
    assert_eq!(parsed(&count).unwrap_err(), "trust_recovery_required");
    let mut bytes = state;
    bytes["rotations"] = json!([]);
    bytes["catalogs"][0]["json"] = json!(" ".repeat(16 * 1024 * 1024));
    assert!(parsed(&bytes).is_ok());
    bytes["catalogs"][0]["json"] = json!(" ".repeat(16 * 1024 * 1024 + 1));
    assert_eq!(parsed(&bytes).unwrap_err(), "trust_recovery_required");
}
