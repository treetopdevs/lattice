use serde_json::{json, Value};
use treehouse_tauri_shell::catalog_eval::histories::AuthenticatedHistories;
#[path = "support/catalog_author.rs"]
mod catalog_author;
#[path = "support/catalog_peer.rs"]
mod catalog_peer;

#[test]
fn owned_histories_keep_raw_transport_separate_from_normalized_authenticated_frames() {
    let bytes = catalog_peer::output("ts", "artifact-profile-produce", None, 4 * 1024 * 1024);
    let table: Value = serde_json::from_slice(&bytes).unwrap();
    let mut raw = table["bundle"]["histories"][0].clone();
    let replica = raw["replica"].as_str().unwrap().to_owned();
    // Add an independently signed join with two distinct dependencies so raw
    // reordering is observable even when the source fixture is linear.
    let mut parents: Vec<_> = raw["frames"]
        .as_array()
        .unwrap()
        .iter()
        .take(2)
        .map(|frame| frame["id"].as_str().unwrap().to_owned())
        .collect();
    parents.sort();
    assert_eq!(parents.len(), 2);
    assert_ne!(parents[0], parents[1]);
    let mut joined = catalog_author::signed(
        &ed25519_dalek::SigningKey::from_bytes(&[66; 32]),
        &replica,
        &parents,
        "command",
        json!([
            "tuple",
            [
                ["atom", "post"],
                ["list", [catalog_author::text("raw join")]]
            ]
        ]),
        json!(["nil"]),
    );
    let frame = &mut joined;
    let id = frame["id"].as_str().unwrap().to_owned();
    let deps = frame["deps"].as_array_mut().unwrap();
    let original_order = deps.clone();
    deps.reverse();
    assert_ne!(deps, &original_order);
    deps.push(deps[0].clone());
    let mut rejected = frame.clone();
    rejected["sig"] = json!(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
    );
    raw["frames"].as_array_mut().unwrap().push(joined);
    raw["rejected"] = json!([{"frame": rejected, "reason":"bad_signature"}]);
    let expected = raw.clone();
    let mut encoded = serde_json::to_vec(&raw).unwrap();
    let histories = AuthenticatedHistories::authenticate(&[(&replica, &encoded)]).unwrap();
    // The constructor owns its data, even after the caller overwrites the exact
    // transport buffer supplied at construction.
    encoded.fill(b'!');
    let history = histories.get(&replica).unwrap();
    assert_eq!(history.raw(), &expected);
    let actual = history.dag().frame(&id).unwrap();
    let wanted: std::collections::BTreeSet<_> = expected["frames"]
        .as_array()
        .unwrap()
        .iter()
        .find(|frame| frame["id"] == id)
        .unwrap()["deps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(actual.deps(), &wanted.into_iter().collect::<Vec<_>>());
    assert_eq!(
        histories.iter().map(|(name, _)| name).collect::<Vec<_>>(),
        [&replica]
    );
    assert_eq!(history.raw()["rejected"].as_array().unwrap().len(), 1);
    assert_eq!(
        history.dag().order().len(),
        expected["frames"].as_array().unwrap().len()
    );
}

#[test]
fn empty_history_replica_is_invalid_not_pending() {
    // A correctly signed partial history under an empty replica name must be
    // refused as malformed, as the BEAM owner's history_shape? does, rather than
    // reported as waiting for its missing dependency.
    let key = ed25519_dalek::SigningKey::from_bytes(&[67; 32]);
    let missing = "A".repeat(43);
    let frame = catalog_author::signed(
        &key,
        "",
        &[missing.clone()],
        "command",
        json!(["nil"]),
        json!(["nil"]),
    );
    let raw = json!({"replica": "", "frames": [frame], "rejected": []});
    let encoded = serde_json::to_vec(&raw).unwrap();
    let error = AuthenticatedHistories::authenticate(&[("", &encoded)])
        .err()
        .expect("empty replica must be refused");
    assert_eq!(error.reason, "invalid_verified_history");
    assert!(error.ids.is_empty());

    // Control: the same partial shape under a real replica name stays pending.
    let named = catalog_author::signed(
        &key,
        "r",
        &[missing.clone()],
        "command",
        json!(["nil"]),
        json!(["nil"]),
    );
    let raw = json!({"replica": "r", "frames": [named], "rejected": []});
    let encoded = serde_json::to_vec(&raw).unwrap();
    let error = AuthenticatedHistories::authenticate(&[("r", &encoded)])
        .err()
        .expect("partial history is pending");
    assert_eq!(error.reason, "trust_pending");
    assert_eq!(error.ids, vec![missing]);
}
