use ed25519_dalek::SigningKey;
use serde::Deserialize;
use serde_json::{json, Value};
use treehouse_tauri_shell::catalog_eval::{artifact, entries, histories::AuthenticatedHistories};
#[path = "support/catalog_author.rs"]
mod catalog_author;
#[path = "support/catalog_peer.rs"]
mod catalog_peer;

fn peer(runtime: &str, mode: &str, input: Option<&Value>) -> Value {
    let bytes = catalog_peer::output(runtime, mode, input, 8 * 1024 * 1024);
    let mut decoder = serde_json::Deserializer::from_slice(&bytes);
    decoder.disable_recursion_limit();
    let value = Value::deserialize(&mut decoder).unwrap();
    decoder.end().unwrap();
    value
}

fn carrier_map(fields: Vec<(&str, Value)>) -> Value {
    json!([
        "map",
        fields
            .into_iter()
            .map(|(key, value)| json!([["atom", key], value]))
            .collect::<Vec<_>>()
    ])
}

fn expected_missing(name: &str) -> Vec<String> {
    match name {
        "authentic-missing" | "unreadable-and-missing" | "empty-rejected-id-pending" => {
            vec!["A".repeat(43), "B".repeat(43)]
        }
        "unreadable-and-other-pending" => vec!["C".repeat(43)],
        _ => Vec::new(),
    }
}

#[test]
fn raw_history_authentication_missing_and_product_readability_match_both_public_owners() {
    let source = peer("ts", "entries-produce", None);
    let complete = &source["cases"][0];
    let histories: Vec<Value> = complete["histories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["raw"].clone())
        .collect();
    let space = histories
        .iter()
        .find(|h| h["replica"] == source["review"]["space"])
        .unwrap()
        .clone();
    let threads: Vec<usize> = histories
        .iter()
        .enumerate()
        .filter(|(_, h)| h["replica"] != source["review"]["space"])
        .map(|(i, _)| i)
        .collect();
    assert_eq!(threads.len(), 2);
    let thread = threads[0];
    let other = threads[1];
    let mut cases = Vec::new();
    let key = SigningKey::from_bytes(&[151; 32]);
    let frame = |body, cap, deps: Vec<String>| {
        catalog_author::signed(
            &key,
            histories[thread]["replica"].as_str().unwrap(),
            &deps,
            "command",
            body,
            cap,
        )
    };
    let mut add = |name: &str, histories: Vec<Value>, reason: Option<&str>| {
        cases.push(json!({"name":name,"review":source["review"],"catalogJson":complete["catalogJson"],"histories":histories,"expected":reason}))
    };
    add("complete", histories.clone(), None);
    let mut unreadable = None;
    for (name, body, cap, reason) in [
        (
            "opaque-binary-control",
            catalog_author::text("9007199254740992"),
            json!(["nil"]),
            None,
        ),
        (
            "safe-strict-integer",
            json!(["int", 9007199254740991u64]),
            json!(["nil"]),
            None,
        ),
        (
            "unsafe-strict-integer",
            json!(["int", "9007199254740992"]),
            json!(["nil"]),
            Some("unsupported_cutoff"),
        ),
        (
            "maximum-uint64-body",
            json!(["int", "18446744073709551615"]),
            json!(["nil"]),
            Some("unsupported_cutoff"),
        ),
        (
            "unsafe-capability",
            json!(["nil"]),
            json!(["int", "9007199254740992"]),
            Some("unsupported_cutoff"),
        ),
    ] {
        let mut hs = histories.clone();
        hs[thread]["frames"]
            .as_array_mut()
            .unwrap()
            .push(frame(body, cap, vec![]));
        if name == "unsafe-strict-integer" {
            unreadable = Some(hs.clone());
        }
        add(name, hs, reason);
    }
    let mut pending = histories.clone();
    pending[thread]["frames"]
        .as_array_mut()
        .unwrap()
        .push(frame(
            json!(["nil"]),
            json!(["nil"]),
            vec!["A".repeat(43), "B".repeat(43)],
        ));
    add("authentic-missing", pending.clone(), Some("trust_pending"));
    let mut empty_id = frame(json!(["nil"]), json!(["nil"]), vec![]);
    empty_id["id"] = json!("");
    empty_id["sig"] = json!(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
    );
    for (name, mut hs, reason) in [
        ("empty-rejected-id-complete", histories.clone(), None),
        (
            "empty-rejected-id-pending",
            pending.clone(),
            Some("trust_pending"),
        ),
    ] {
        hs[thread]["rejected"] = json!([{"frame":empty_id.clone(),"reason":"bad_signature"}]);
        add(name, hs, reason);
    }
    let mut rejected_unknown = frame(
        json!(["atom", "unsupported_reader_v1"]),
        json!(["nil"]),
        vec![],
    );
    rejected_unknown["sig"] = json!(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
    );
    let mut pending_rejected = pending.clone();
    pending_rejected[thread]["rejected"] =
        json!([{"frame":rejected_unknown,"reason":"bad_signature"}]);
    add(
        "unsupported-rejected-before-pending",
        pending_rejected.clone(),
        Some("unsupported_cutoff"),
    );
    pending_rejected[other]["frames"][0]["sig"] = json!(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
    );
    add(
        "unsupported-rejected-before-forgery",
        pending_rejected,
        Some("invalid_verified_history"),
    );
    let mut same_history = pending.clone();
    same_history[thread]["frames"].as_array_mut().unwrap().push(
        unreadable.as_ref().unwrap()[thread]["frames"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .clone(),
    );
    add(
        "unreadable-and-missing",
        same_history,
        Some("trust_pending"),
    );
    let mut mixed = unreadable.as_ref().unwrap().clone();
    let pending_frame = catalog_author::signed(
        &key,
        histories[other]["replica"].as_str().unwrap(),
        &["C".repeat(43)],
        "command",
        json!(["nil"]),
        json!(["nil"]),
    );
    mixed[other]["frames"]
        .as_array_mut()
        .unwrap()
        .push(pending_frame);
    add("unreadable-and-other-pending", mixed, Some("trust_pending"));
    let neutral = catalog_author::delegation(
        &key,
        histories[thread]["replica"].as_str().unwrap(),
        &key.verifying_key().to_bytes(),
        None,
        &[],
        false,
        &[],
    );
    let beacon_settings = json!([
        "map",
        [[["atom", "max_epoch_step"], ["int", "9007199254740992"]]]
    ]);
    let policies = json!(["map", [[["atom", "__beacon__"], beacon_settings]]]);
    for (name, body) in [
        (
            "permitted-high-beacon",
            json!(["tuple", [["atom", "beacon"], ["int", "9007199254740992"]]]),
        ),
        (
            "permitted-high-policy",
            json!(["tuple", [["atom", "genesis"], neutral, policies]]),
        ),
    ] {
        let mut hs = histories.clone();
        let op = catalog_author::signed(
            &key,
            histories[thread]["replica"].as_str().unwrap(),
            &[],
            "authority",
            body,
            json!(["nil"]),
        );
        hs[thread]["frames"].as_array_mut().unwrap().push(op);
        add(name, hs, None);
    }
    let metadata = carrier_map(vec![(
        "claim",
        carrier_map(vec![
            ("epoch", json!(["int", 0])),
            ("max_epoch_step", json!(["int", "9007199254740992"])),
        ]),
    )]);
    let high_claim = carrier_map(vec![(
        "claim",
        carrier_map(vec![("epoch", json!(["int", "9007199254740992"]))]),
    )]);
    for (name, epoch, certificate, reason) in [
        (
            "permitted-certificate-metadata",
            json!(["int", 0]),
            metadata.clone(),
            None,
        ),
        (
            "strict-certificate-epoch",
            json!(["int", 0]),
            high_claim,
            Some("unsupported_cutoff"),
        ),
        (
            "strict-certificate-outer-epoch",
            json!(["int", "9007199254740992"]),
            metadata,
            Some("unsupported_cutoff"),
        ),
    ] {
        let mut hs = histories.clone();
        let op = catalog_author::signed(
            &key,
            histories[thread]["replica"].as_str().unwrap(),
            &[],
            "authority",
            json!(["tuple", [["atom", "beacon"], epoch, certificate]]),
            json!(["nil"]),
        );
        hs[thread]["frames"].as_array_mut().unwrap().push(op);
        add(name, hs, reason);
    }
    let mut forged = histories[other].clone();
    forged["frames"][0]["sig"] = json!(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
    );
    for (name, mut hs) in [
        ("pending-before-forgery", pending),
        ("unreadable-before-forgery", unreadable.clone().unwrap()),
    ] {
        hs[other] = forged.clone();
        add(name, hs, Some("invalid_verified_history"));
    }
    let mut rejected = unreadable.unwrap()[thread]["frames"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    rejected["sig"] = json!(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
    );
    let mut hs = histories.clone();
    hs[thread]["rejected"] = json!([{"frame":rejected,"reason":"bad_signature"}]);
    add("unreadable-rejected-record", hs, None);
    assert_eq!(cases.len(), 21);
    let mut both_orders = Vec::new();
    for case in cases {
        let mut reverse = case.clone();
        reverse["histories"].as_array_mut().unwrap().reverse();
        for h in reverse["histories"].as_array_mut().unwrap() {
            h["frames"].as_array_mut().unwrap().reverse();
        }
        both_orders.extend([case, reverse]);
    }
    let input = json!({"review":source["review"],"baselineHistory":space,"cases":both_orders});
    let beam = peer("beam", "raw-incoming-consume", Some(&input));
    let ts = peer("ts", "entries-consume", Some(&input));
    // Check the actual public owners first; fixture setup failures cannot count as native RED.
    for (i, case) in input["cases"].as_array().unwrap().iter().enumerate() {
        assert_eq!(
            beam["results"][i]["reason"], case["expected"],
            "BEAM {}",
            case["name"]
        );
        assert_eq!(
            ts["results"][i]["reason"], case["expected"],
            "TS {}",
            case["name"]
        );
        let kind = if case["expected"].is_null() {
            "propose"
        } else {
            "reject"
        };
        assert_eq!(beam["results"][i]["kind"], kind);
        assert_eq!(ts["results"][i]["kind"], kind);
        if kind == "propose" {
            assert_eq!(beam["results"][i]["route_count"], 3);
            assert_eq!(ts["results"][i]["routes"].as_array().unwrap().len(), 3);
        }
        if case["expected"] == "trust_pending" {
            let ids = json!(expected_missing(case["name"].as_str().unwrap()));
            assert_eq!(beam["results"][i]["ids"], ids);
            assert_eq!(ts["results"][i]["detail"]["ids"], ids);
        }
    }
    let mut native_cases: Vec<_> = input["cases"].as_array().unwrap().iter().collect();
    native_cases.sort_by_key(|case| case["name"] != "authentic-missing");
    for case in native_cases {
        let raw: Vec<_> = case["histories"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| {
                (
                    h["replica"].as_str().unwrap(),
                    serde_json::to_vec(h).unwrap(),
                )
            })
            .collect();
        let refs: Vec<_> = raw.iter().map(|(n, b)| (*n, b.as_slice())).collect();
        let observed = entries::observe(
            &artifact::parse(case["catalogJson"].as_str().unwrap().as_bytes()).unwrap(),
            &refs,
        );
        let reason = observed.as_ref().err().copied();
        eprintln!(
            "{} native={reason:?} source={}",
            case["name"], case["expected"]
        );
        assert_eq!(reason, case["expected"].as_str(), "{}", case["name"]);
        let owned = AuthenticatedHistories::authenticate(&refs);
        assert_eq!(
            owned.as_ref().err().map(|error| error.reason),
            case["expected"].as_str(),
            "owned {}",
            case["name"]
        );
        if case["expected"] == "trust_pending" {
            let error = owned.unwrap_err();
            assert_eq!(error.ids, expected_missing(case["name"].as_str().unwrap()));
        }
    }
}
