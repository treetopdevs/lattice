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
fn union_authenticates_fragments_before_fetch_and_retains_first_signed_alias() {
    let replica = "replica:treehouse:thread:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA#authority:bounded-continuation-v1#root:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let signer = ed25519_dalek::SigningKey::from_bytes(&[73; 32]);
    let parent = catalog_author::signed(
        &signer,
        replica,
        &[],
        "command",
        json!([
            "tuple",
            [["atom", "post"], ["list", [catalog_author::text("parent")]]]
        ]),
        json!(["nil"]),
    );
    let id = parent["id"].as_str().unwrap().to_owned();
    let child = catalog_author::signed(
        &signer,
        replica,
        std::slice::from_ref(&id),
        "command",
        json!([
            "tuple",
            [["atom", "post"], ["list", [catalog_author::text("child")]]]
        ]),
        json!(["nil"]),
    );
    let saved = json!([{"replica":replica,"frames":[parent],"rejected":[]}]);
    let mut alias = child.clone();
    alias["deps"].as_array_mut().unwrap().push(json!(id));
    let incoming = json!([{"replica":replica,"frames":[alias],"rejected":[]}]);
    let observed = AuthenticatedHistories::authenticate_union(&saved, &incoming).unwrap();
    let kept = observed.get(replica).unwrap().raw()["frames"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == child["id"])
        .unwrap();
    assert_eq!(kept["deps"], json!([id.clone(), id.clone()]));
    // A later authentic alias coalesces by signed identity without replacing
    // the already retained raw representation.
    let reopened = json!([observed.get(replica).unwrap().raw()]);
    let canonical = json!([{"replica":replica,"frames":[child.clone()],"rejected":[]}]);
    assert_eq!(
        AuthenticatedHistories::authenticate_union(&reopened, &canonical)
            .unwrap()
            .get(replica)
            .unwrap()
            .raw(),
        observed.get(replica).unwrap().raw()
    );
    let missing = AuthenticatedHistories::authenticate_union(&json!([]), &canonical).unwrap_err();
    assert_eq!(missing.reason, "trust_pending");
    assert_eq!(missing.ids, vec![id]);
    let mut forged = canonical.clone();
    forged[0]["frames"][0]["sig"] = json!(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
    );
    assert_eq!(
        AuthenticatedHistories::authenticate_union(&json!([]), &forged)
            .unwrap_err()
            .reason,
        "invalid_verified_history"
    );
    let duplicate = json!([incoming[0].clone(), incoming[0].clone()]);
    assert_eq!(
        AuthenticatedHistories::authenticate_union(&saved, &duplicate)
            .unwrap_err()
            .reason,
        "invalid_verified_history"
    );
    let duplicates_in_origin =
        json!([{"replica":replica,"frames":[child.clone(),child],"rejected":[]}]);
    assert_eq!(
        AuthenticatedHistories::authenticate_union(&saved, &duplicates_in_origin)
            .unwrap_err()
            .reason,
        "invalid_verified_history"
    );
}

#[test]
fn rejected_union_detects_same_claimed_id_with_different_signed_content() {
    let replica = "replica:treehouse:thread:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA#authority:bounded-continuation-v1#root:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let signer = ed25519_dalek::SigningKey::from_bytes(&[74; 32]);
    let author = |message| {
        catalog_author::signed(
            &signer,
            replica,
            &[],
            "command",
            json!([
                "tuple",
                [["atom", "post"], ["list", [catalog_author::text(message)]]]
            ]),
            json!(["nil"]),
        )
    };
    let mut left = author("left");
    let mut right = author("right");
    // Both are valid bad-hash evidence under one diagnostic claimed id. Payload
    // and signature, rather than the unverified claimed id, must detect conflict.
    left["id"] = json!("diagnostic");
    right["id"] = left["id"].clone();
    let history = |frame| json!([{"replica":replica,"frames":[],"rejected":[{"frame":frame,"reason":"bad_signature"}]}]);
    let saved = history(left.clone());
    let before = saved.clone();
    let error = AuthenticatedHistories::authenticate_union(&saved, &history(right)).unwrap_err();
    assert_eq!(error.reason, "invalid_verified_history");
    assert_eq!(error.ids, vec!["diagnostic"]);
    assert_eq!(saved, before);
    assert_eq!(
        AuthenticatedHistories::authenticate_union(&saved, &history(left))
            .unwrap()
            .get(replica)
            .unwrap()
            .raw(),
        &saved[0]
    );
}
