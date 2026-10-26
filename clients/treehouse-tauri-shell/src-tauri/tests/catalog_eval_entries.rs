use treehouse_tauri_shell::catalog_eval::{artifact, entries};
#[path = "support/catalog_peer.rs"]
mod catalog_peer;

#[test]
fn fresh_source_catalog_requires_actual_histories_before_entry_facts() {
    let output = catalog_peer::output("ts", "artifact-profile-produce", None, 4 * 1024 * 1024);
    let table = decode_peer(&output);
    let bundle = &table["bundle"];
    let artifact = artifact::parse(bundle["catalogJson"].as_str().unwrap().as_bytes()).unwrap();
    let histories: Vec<(String, Vec<u8>)> = bundle["histories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|raw| {
            (
                raw["replica"].as_str().unwrap().into(),
                serde_json::to_vec(raw).unwrap(),
            )
        })
        .collect();
    let refs: Vec<_> = histories
        .iter()
        .map(|(name, bytes)| (name.as_str(), bytes.as_slice()))
        .collect();
    let mut malformed: serde_json::Value =
        serde_json::from_str(bundle["catalogJson"].as_str().unwrap()).unwrap();
    let catalog = malformed[1]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|pair| pair[0] == serde_json::json!(["atom", "catalog"]))
        .unwrap();
    catalog[1][1]
        .as_array_mut()
        .unwrap()
        .retain(|pair| pair[0] != serde_json::json!(["atom", "entries"]));
    let malformed = artifact::parse(serde_json::to_string(&malformed).unwrap().as_bytes()).unwrap();
    assert_eq!(
        entries::observe(&malformed, &[]).unwrap_err(),
        "malformed_catalog"
    );
    let observed = entries::observe(&artifact, &refs).unwrap();
    assert_eq!(
        observed.bootstrap_id(),
        bundle["review"]["bootstrapId"].as_str().unwrap()
    );
    assert_eq!(
        observed.entries(),
        artifact
            .term()
            .atom_field("catalog")
            .unwrap()
            .atom_field("entries")
            .unwrap()
    );
    let mut reversed = refs.clone();
    reversed.reverse();
    let reordered = entries::observe(&artifact, &reversed).unwrap();
    assert_eq!(reordered.entries(), observed.entries());
    assert_eq!(reordered.bootstrap(), observed.bootstrap());
    let missing: Vec<_> = refs
        .iter()
        .copied()
        .filter(|(name, _)| !name.starts_with("replica:treehouse:thread:"))
        .collect();
    assert_eq!(
        entries::observe(&artifact, &missing).unwrap_err(),
        "trust_pending"
    );
    let thread = refs
        .iter()
        .find(|(name, _)| name.starts_with("replica:treehouse:thread:"))
        .unwrap();
    let mut corrupt: serde_json::Value = serde_json::from_slice(thread.1).unwrap();
    corrupt["frames"][0]["sig"] = serde_json::json!(
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
    );
    let corrupt = serde_json::to_vec(&corrupt).unwrap();
    let mut forged = missing;
    forged.push((thread.0, &corrupt));
    assert_eq!(
        entries::observe(&artifact, &forged).unwrap_err(),
        "invalid_verified_history"
    );
}

#[test]
fn fresh_source_entry_observations_match_complete_native_facts_and_refusals() {
    use treehouse_tauri_shell::catalog_eval::canonical::Term;
    for runtime in ["beam", "ts"] {
        let output = catalog_peer::output(runtime, "entries-produce", None, 4 * 1024 * 1024);
        let table = decode_peer(&output);
        let cases = table["cases"].as_array().unwrap();
        assert_eq!(cases.len(), if runtime == "beam" { 19 } else { 13 });
        for case in cases {
            let artifact =
                artifact::parse(case["catalogJson"].as_str().unwrap().as_bytes()).unwrap();
            let histories: Vec<_> = case["histories"]
                .as_array()
                .unwrap()
                .iter()
                .map(|history| {
                    (
                        history["name"].as_str().unwrap(),
                        serde_json::to_vec(&history["raw"]).unwrap(),
                    )
                })
                .collect();
            let refs: Vec<_> = histories
                .iter()
                .map(|(name, bytes)| (*name, bytes.as_slice()))
                .collect();
            for reverse in [false, true] {
                let mut refs = refs.clone();
                if reverse {
                    refs.reverse();
                }
                let result = entries::observe(&artifact, &refs);
                let expected = &case["result"];
                let name = case["name"].as_str().unwrap();
                let absolute_reason = match name {
                    "complete" => None,
                    "missing-child" | "missing-genesis" | "missing-creation"
                    | "missing-reference" => Some("trust_pending"),
                    "unrelated-unsupported" | "signed-depth65-unsupported" => {
                        Some("unsupported_cutoff")
                    }
                    "missing-plus-unrelated-forgery"
                    | "unsupported-plus-forgery"
                    | "same-frame-unsupported-forgery"
                    | "forged-depth65-invalid" => Some("invalid_verified_history"),
                    "genesis-refused-command"
                    | "creation-refused-authority"
                    | "wrong-root"
                    | "genesis-is-creation"
                    | "creation-is-genesis"
                    | "wrong-reference"
                    | "pending-cannot-hide-invalid-entry"
                    | "refused-reference"
                    | "refused-creation"
                    | "unrelated-genesis"
                    | "wrong-genesis-author" => Some("invalid_catalog_transition"),
                    _ => panic!("unregistered entry case {name}"),
                };
                assert_eq!(expected["reason"].as_str(), absolute_reason, "{name}");
                if expected["ok"] == true {
                    let observation = result.unwrap();
                    assert_eq!(
                        treehouse_tauri_shell::catalog_eval::canonical::encode(
                            observation.entries()
                        )
                        .unwrap(),
                        treehouse_tauri_shell::catalog_eval::canonical::encode(
                            &Term::from_carrier(&expected["entries"]).unwrap()
                        )
                        .unwrap()
                    );
                    assert_eq!(
                        treehouse_tauri_shell::catalog_eval::canonical::encode(
                            observation.bootstrap()
                        )
                        .unwrap(),
                        treehouse_tauri_shell::catalog_eval::canonical::encode(
                            &Term::from_carrier(&expected["bootstrap"]).unwrap()
                        )
                        .unwrap()
                    );
                    assert_eq!(
                        observation.bootstrap_id(),
                        expected["bootstrapId"].as_str().unwrap()
                    );
                } else {
                    assert_eq!(
                        result.unwrap_err(),
                        expected["reason"].as_str().unwrap(),
                        "{} reverse={reverse}",
                        case["name"]
                    );
                }
            }
        }
    }
}

#[path = "support/catalog_author.rs"]
mod catalog_author;

fn carrier_field_mut<'a>(
    record: &'a mut serde_json::Value,
    name: &str,
) -> &'a mut serde_json::Value {
    &mut record[1]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|pair| pair[0] == serde_json::json!(["atom", name]))
        .unwrap()[1]
}

#[test]
fn rust_signed_child_creation_reference_and_catalog_are_consumed_by_both_real_owners() {
    use base64::{
        engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
        Engine,
    };
    use catalog_author::{delegation, signed, text};
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use treehouse_tauri_shell::catalog_eval::{canonical::Term, envelope};
    let source = decode_peer(&catalog_peer::output(
        "ts",
        "entries-produce",
        None,
        4 * 1024 * 1024,
    ));
    let case = &source["cases"][0];
    let mut catalog: Value = serde_json::from_str(case["catalogJson"].as_str().unwrap()).unwrap();
    let mut catalog = carrier_field_mut(&mut catalog, "catalog").clone();
    let mut histories: Vec<Value> = case["histories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["raw"].clone())
        .collect();
    let root = SigningKey::from_bytes(&[141; 32]);
    let replica = format!(
        "replica:treehouse:thread:{}#authority:bounded-continuation-v1#root:{}",
        URL_SAFE_NO_PAD.encode(Sha256::digest(b"fresh-rust-entry")),
        URL_SAFE_NO_PAD.encode(Sha256::digest(root.verifying_key().to_bytes()))
    );
    let grant = delegation(
        &root,
        &replica,
        &root.verifying_key().to_bytes(),
        None,
        &["create_thread", "post"],
        true,
        &["moderator"],
    );
    let genesis = signed(
        &root,
        &replica,
        &[],
        "authority",
        json!(["tuple", [["atom", "genesis"], grant.clone(), ["map", []]]]),
        json!(["nil"]),
    );
    let creation = signed(
        &root,
        &replica,
        &[genesis["id"].as_str().unwrap().into()],
        "command",
        json!([
            "tuple",
            [
                ["atom", "create_thread"],
                ["list", [text("Fresh Rust Thread")]]
            ]
        ]),
        text(grant[1]["id"].as_str().unwrap()),
    );
    let space = histories
        .iter_mut()
        .find(|h| {
            h["replica"]
                .as_str()
                .unwrap()
                .starts_with("replica:treehouse:space:")
        })
        .unwrap();
    let space_key = SigningKey::from_bytes(&Sha256::digest(b"r11a-trust-ts:space-root").into());
    let space_frames = space["frames"].as_array_mut().unwrap();
    assert_eq!(
        space_frames[0]["author"],
        STANDARD.encode(space_key.verifying_key().to_bytes())
    );
    let cap = space_frames
        .iter()
        .find(|frame| {
            frame["kind"] == "command" && frame["body"][1][0] == json!(["atom", "create_space"])
        })
        .unwrap()["cap"]
        .clone();
    let mut deps = space_frames
        .iter()
        .map(|frame| frame["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    deps.sort();
    let space_replica = source["review"]["space"].as_str().unwrap();
    let reference = signed(
        &space_key,
        space_replica,
        &deps,
        "command",
        json!([
            "tuple",
            [
                ["atom", "create_thread"],
                ["list", [text(&replica), text("Fresh Rust listing")]]
            ]
        ]),
        cap,
    );
    space_frames.push(reference.clone());
    let entry_values = carrier_field_mut(&mut catalog, "entries")[1]
        .as_array_mut()
        .unwrap();
    let entry = entry_values
        .iter_mut()
        .find(|entry| {
            Term::from_carrier(entry).unwrap().atom_field("kind")
                == Some(&Term::Atom("thread".into()))
        })
        .unwrap();
    let old_replica = Term::from_carrier(entry)
        .unwrap()
        .atom_field("replica")
        .unwrap()
        .clone();
    for (name, value) in [
        ("replica", text(&replica)),
        (
            "root",
            json!(["bin", STANDARD.encode(root.verifying_key().to_bytes())]),
        ),
        ("genesis", text(genesis["id"].as_str().unwrap())),
        ("creation", text(creation["id"].as_str().unwrap())),
        ("reference", text(reference["id"].as_str().unwrap())),
    ] {
        *carrier_field_mut(entry, name) = value;
    }
    entry_values.sort_by_key(|entry| {
        match Term::from_carrier(entry)
            .unwrap()
            .atom_field("replica")
            .unwrap()
        {
            Term::Binary(value) => value.clone(),
            _ => unreachable!(),
        }
    });
    histories.retain(|raw| {
        old_replica != Term::Binary(raw["replica"].as_str().unwrap().as_bytes().to_vec())
    });
    histories.push(json!({"replica":replica,"frames":[genesis,creation],"rejected":[]}));
    let signer = SigningKey::from_bytes(&Sha256::digest(b"r11a-trust-ts:catalog").into());
    let bytes = envelope::signing_bytes(&Term::from_carrier(&catalog).unwrap()).unwrap();
    let catalog_json = json!([
        "map",
        [
            [["atom", "catalog"], catalog],
            [
                ["atom", "signature"],
                ["bin", STANDARD.encode(signer.sign(&bytes).to_bytes())]
            ]
        ]
    ])
    .to_string();
    let artifact = artifact::parse(catalog_json.as_bytes()).unwrap();
    let raw_histories: Vec<_> = histories
        .iter()
        .map(|h| {
            (
                h["replica"].as_str().unwrap(),
                serde_json::to_vec(h).unwrap(),
            )
        })
        .collect();
    let refs = raw_histories
        .iter()
        .map(|(name, raw)| (*name, raw.as_slice()))
        .collect::<Vec<_>>();
    let native = entries::observe(&artifact, &refs).unwrap();
    let input = json!({"cases":[{"review":source["review"],"catalogJson":catalog_json,"histories":histories}]});
    let beam: Value = serde_json::from_slice(&catalog_peer::output(
        "beam",
        "entries-consume",
        Some(&input),
        4 * 1024 * 1024,
    ))
    .unwrap();
    assert_eq!(beam["results"][0]["ok"], true);
    assert_eq!(
        treehouse_tauri_shell::catalog_eval::canonical::encode(native.entries()).unwrap(),
        treehouse_tauri_shell::catalog_eval::canonical::encode(
            &Term::from_carrier(&beam["results"][0]["entries"]).unwrap()
        )
        .unwrap()
    );
    assert_eq!(
        treehouse_tauri_shell::catalog_eval::canonical::encode(native.bootstrap()).unwrap(),
        treehouse_tauri_shell::catalog_eval::canonical::encode(
            &Term::from_carrier(&beam["results"][0]["bootstrap"]).unwrap()
        )
        .unwrap()
    );
    assert_eq!(
        native.bootstrap_id(),
        beam["results"][0]["bootstrapId"].as_str().unwrap()
    );
    let ts: Value = serde_json::from_slice(&catalog_peer::output(
        "ts",
        "entries-consume",
        Some(&input),
        4 * 1024 * 1024,
    ))
    .unwrap();
    assert_eq!(ts["results"][0]["kind"], "propose");
    assert_eq!(ts["results"][0]["reason"], Value::Null);
    assert_eq!(ts["results"][0]["routes"].as_array().unwrap().len(), 3);
}

fn decode_peer(bytes: &[u8]) -> serde_json::Value {
    use serde::Deserialize;
    assert!(bytes.len() <= 4 * 1024 * 1024);
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    // The bounded producer corpus carries depth65 observation wrappers, beyond
    // serde's generic128-container default. Production admission has its own bounds.
    decoder.disable_recursion_limit();
    let value = serde_json::Value::deserialize(&mut decoder).unwrap();
    decoder.end().unwrap();
    value
}

#[test]
fn high_lease_metadata_obeys_the_public_raw_profile_not_the_broader_typed_log_helper() {
    let input = decode_peer(&catalog_peer::output(
        "beam",
        "entry-high-lease-profile",
        None,
        4 * 1024 * 1024,
    ));
    assert_eq!(input["typedReason"], "unsupported_cutoff");
    assert_eq!(input["public"]["kind"], "reject");
    assert_eq!(input["public"]["reason"], "invalid_verified_history");
    let case = &input["case"];
    let artifact = artifact::parse(case["catalogJson"].as_str().unwrap().as_bytes()).unwrap();
    let histories: Vec<_> = case["histories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|raw| {
            (
                raw["replica"].as_str().unwrap(),
                serde_json::to_vec(raw).unwrap(),
            )
        })
        .collect();
    let refs: Vec<_> = histories
        .iter()
        .map(|(name, bytes)| (*name, bytes.as_slice()))
        .collect();
    assert_eq!(
        entries::observe(&artifact, &refs).unwrap_err(),
        "invalid_verified_history"
    );
    let result = decode_peer(&catalog_peer::output(
        "ts",
        "entries-consume",
        Some(&serde_json::json!({"cases":[case]})),
        4 * 1024 * 1024,
    ));
    assert_eq!(result["results"][0]["kind"], "reject");
    assert_eq!(result["results"][0]["reason"], "invalid_verified_history");
}

#[test]
fn space_reference_binding_is_checked_before_missing_histories() {
    use serde_json::{json, Value};
    use treehouse_tauri_shell::catalog_eval::canonical::Term;
    let table = decode_peer(&catalog_peer::output(
        "ts",
        "entries-produce",
        None,
        4 * 1024 * 1024,
    ));
    let mut envelope: Value =
        serde_json::from_str(table["cases"][0]["catalogJson"].as_str().unwrap()).unwrap();
    let original = artifact::parse(&serde_json::to_vec(&envelope).unwrap()).unwrap();
    assert_eq!(
        entries::observe(&original, &[]).unwrap_err(),
        "trust_pending"
    );
    let catalog = carrier_field_mut(&mut envelope, "catalog");
    let entries = carrier_field_mut(catalog, "entries")[1]
        .as_array_mut()
        .unwrap();
    let space = entries
        .iter_mut()
        .find(|e| {
            Term::from_carrier(e).unwrap().atom_field("kind") == Some(&Term::Atom("space".into()))
        })
        .unwrap();
    *carrier_field_mut(space, "reference") = json!([
        "bin",
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, "A".repeat(43))
    ]);
    let altered = artifact::parse(&serde_json::to_vec(&envelope).unwrap()).unwrap();
    assert_eq!(
        entries::observe(&altered, &[]).unwrap_err(),
        "malformed_catalog"
    );
}

#[test]
fn bootstrap_graph_survives_incomplete_inventory_and_facts_keep_refusals_separate() {
    use std::collections::BTreeSet;
    use treehouse_tauri_shell::catalog_eval::{chains, histories::AuthenticatedHistories};
    for runtime in ["beam", "ts"] {
        let table = decode_peer(&catalog_peer::output(
            runtime,
            "entries-produce",
            None,
            4 * 1024 * 1024,
        ));
        let mut checked = 0;
        let mut saw_pending = false;
        let mut saw_invalid = false;
        let mut saw_refused = false;
        for case in table["cases"].as_array().unwrap() {
            let artifact =
                artifact::parse(case["catalogJson"].as_str().unwrap().as_bytes()).unwrap();
            let raw = case["histories"]
                .as_array()
                .unwrap()
                .iter()
                .map(|h| {
                    (
                        h["name"].as_str().unwrap(),
                        serde_json::to_vec(&h["raw"]).unwrap(),
                    )
                })
                .collect::<Vec<_>>();
            let refs = raw
                .iter()
                .map(|(name, bytes)| (*name, bytes.as_slice()))
                .collect::<Vec<_>>();
            let Ok(histories) = AuthenticatedHistories::authenticate(&refs) else {
                continue;
            };
            let catalog = artifact.term().atom_field("catalog").unwrap();
            let get_text = |name| match catalog.atom_field(name).unwrap() {
                treehouse_tauri_shell::catalog_eval::canonical::Term::Binary(bytes) => {
                    std::str::from_utf8(bytes).unwrap()
                }
                _ => panic!("catalog identifier"),
            };
            let bootstrap = entries::BootstrapObservation::observe(
                &histories,
                get_text("space"),
                get_text("bootstrap"),
            )
            .unwrap();
            assert_eq!(bootstrap.source().id(), bootstrap.id());
            assert_eq!(bootstrap.source().replica(), get_text("space"));
            assert!(entries::BootstrapObservation::observe(
                &histories,
                get_text("space"),
                "absent"
            )
            .is_err());
            let graph = chains::observe_bootstrap(&bootstrap, &[], &[]).unwrap();
            assert_eq!(
                serde_json::to_value(&graph).unwrap()["binding_heads"],
                serde_json::json!([bootstrap.id()])
            );
            let facts = bootstrap.entry_facts(&artifact).unwrap();
            let structural = if facts.iter().any(|f| f.invalid()) {
                "invalid"
            } else if facts.iter().any(|f| !f.pending().is_empty()) {
                "pending"
            } else {
                "complete"
            };
            let first_invalid = facts
                .iter()
                .find(|f| f.invalid() || !f.refused().is_empty());
            if runtime == "beam" {
                assert_eq!(
                    structural,
                    case["structureStatus"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
                if let Some(fact) = first_invalid {
                    assert_eq!(
                        serde_json::to_value(fact.refused()).unwrap(),
                        case["result"]["refused"],
                        "{}",
                        case["name"]
                    );
                }
            }
            for fact in &facts {
                assert_eq!(
                    fact.pending()
                        .iter()
                        .collect::<BTreeSet<_>>()
                        .into_iter()
                        .cloned()
                        .collect::<Vec<_>>(),
                    fact.pending()
                );
                assert_eq!(
                    fact.refused()
                        .iter()
                        .collect::<BTreeSet<_>>()
                        .into_iter()
                        .cloned()
                        .collect::<Vec<_>>(),
                    fact.refused()
                );
            }
            if case["name"] == "missing-child" {
                saw_pending = true;
                assert_eq!(structural, "pending");
                assert!(first_invalid.is_none());
                assert_eq!(
                    entries::observe(&artifact, &refs).unwrap_err(),
                    "trust_pending"
                );
                // Graph topology can be constructed without inventing complete
                // entry approval. The graph supplies no eligible routes.
                assert!(chains::observe_bootstrap(
                    &bootstrap,
                    &[artifact::parse(artifact.bytes()).unwrap()],
                    &[]
                )
                .is_ok());
            }
            if case["name"] == "pending-cannot-hide-invalid-entry" {
                saw_invalid = true;
                assert!(facts.iter().any(|f| !f.pending().is_empty()));
                assert!(facts.iter().any(|f| f.invalid()));
            }
            if case["name"] == "refused-creation" || case["name"] == "refused-reference" {
                saw_refused = true;
                assert_eq!(structural, "complete");
                assert!(first_invalid.is_some_and(|f| !f.invalid() && !f.refused().is_empty()));
            }
            checked += 1;
        }
        assert!(checked >= 9);
        assert!(saw_pending && saw_invalid);
        if runtime == "beam" {
            assert!(saw_refused);
        }
    }
}

#[test]
fn rich_entry_facts_match_actual_priority_decisions_and_first_refusal_ids() {
    use treehouse_tauri_shell::catalog_eval::{
        canonical::Term, chains, envelope, histories::AuthenticatedHistories,
    };
    for (mode, expected_count) in [("entry-priority", 18), ("entry-priority-multi", 8)] {
        let table = decode_peer(&catalog_peer::output("ts", mode, None, 32 * 1024 * 1024));
        let cases = table["bundle"]["cases"].as_array().unwrap();
        assert_eq!(cases.len(), expected_count);
        for (index, case) in cases.iter().enumerate() {
            let artifact =
                artifact::parse(case["catalogJson"].as_str().unwrap().as_bytes()).unwrap();
            for reverse in [false, true] {
                let raw = case["histories"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|h| {
                        let mut h = h.clone();
                        if reverse {
                            h["frames"].as_array_mut().unwrap().reverse();
                        }
                        (
                            h["replica"].as_str().unwrap().to_owned(),
                            serde_json::to_vec(&h).unwrap(),
                        )
                    })
                    .collect::<Vec<_>>();
                let mut refs = raw
                    .iter()
                    .map(|(name, bytes)| (name.as_str(), bytes.as_slice()))
                    .collect::<Vec<_>>();
                if reverse {
                    refs.reverse();
                }
                let expected = &table["results"][index]["orders"][usize::from(reverse)]["decision"];
                let histories = match AuthenticatedHistories::authenticate(&refs) {
                    Ok(h) => h,
                    Err(e) => {
                        assert_eq!(Some(e.reason), expected["reason"].as_str());
                        continue;
                    }
                };
                let bootstrap = entries::BootstrapObservation::observe(
                    &histories,
                    table["bundle"]["review"]["space"].as_str().unwrap(),
                    table["bundle"]["review"]["bootstrapId"].as_str().unwrap(),
                )
                .unwrap();
                let facts = bootstrap.entry_facts(&artifact).unwrap();
                let Term::List(inventory) = artifact
                    .term()
                    .atom_field("catalog")
                    .unwrap()
                    .atom_field("entries")
                    .unwrap()
                else {
                    panic!("inventory")
                };
                let target_index = inventory
                    .iter()
                    .position(|entry| {
                        entry.atom_field("kind") == Some(&Term::Atom("thread".into()))
                    })
                    .unwrap();
                let target = &inventory[target_index];
                let fields: &[&str] = match case["name"].as_str().unwrap() {
                    "missing_genesis"
                    | "root_missing_genesis"
                    | "creation_kind_missing_genesis"
                    | "reference_kind_missing_genesis"
                    | "refused_creation_missing_genesis"
                    | "malformed_creation_missing_genesis" => &["genesis"],
                    "missing_creation"
                    | "root_missing_creation"
                    | "genesis_kind_missing_creation"
                    | "reference_kind_missing_creation"
                    | "refused_reference_missing_creation" => &["creation"],
                    "missing_reference" => &["reference"],
                    "missing_child"
                    | "missing_child_wrong_root"
                    | "missing_child_wrong_reference"
                    | "empty_child" => &["genesis", "creation", "reference"],
                    _ => &[],
                };
                if !fields.is_empty() {
                    let mut missing = fields
                        .iter()
                        .map(|name| match target.atom_field(name).unwrap() {
                            Term::Binary(bytes) => String::from_utf8(bytes.clone()).unwrap(),
                            _ => panic!("entry ID"),
                        })
                        .collect::<Vec<_>>();
                    missing.sort();
                    missing.dedup();
                    assert_eq!(
                        facts[target_index].pending(),
                        missing,
                        "{} reverse={reverse}",
                        case["name"]
                    );
                }
                if case["name"] == "complete" {
                    let complete = entries::observe(&artifact, &refs).unwrap();
                    let catalogs = [artifact::parse(artifact.bytes()).unwrap()];
                    assert_eq!(
                        serde_json::to_value(chains::observe(&complete, &catalogs, &[]).unwrap())
                            .unwrap(),
                        serde_json::to_value(
                            chains::observe_bootstrap(&bootstrap, &catalogs, &[]).unwrap()
                        )
                        .unwrap()
                    );
                    let space_creation = inventory
                        .iter()
                        .find(|entry| entry.atom_field("kind") == Some(&Term::Atom("space".into())))
                        .unwrap()
                        .atom_field("creation")
                        .unwrap();
                    let Term::Binary(id) = space_creation else {
                        panic!("creation ID")
                    };
                    assert!(entries::BootstrapObservation::observe(
                        &histories,
                        table["bundle"]["review"]["space"].as_str().unwrap(),
                        std::str::from_utf8(id).unwrap()
                    )
                    .is_err());
                }
                if let Some(first) = facts
                    .iter()
                    .find(|f| f.invalid() || !f.refused().is_empty())
                {
                    assert_eq!(
                        expected["reason"], "invalid_catalog_transition",
                        "{} reverse={reverse}",
                        case["name"]
                    );
                    let Term::Binary(key) = bootstrap.record().atom_field("catalog_key").unwrap()
                    else {
                        panic!("catalog key")
                    };
                    let catalog = envelope::verify(artifact.bytes(), key).unwrap();
                    let mut ids = vec![catalog.id().to_owned()];
                    ids.extend(first.refused().iter().cloned());
                    ids.sort();
                    ids.dedup();
                    assert_eq!(
                        serde_json::to_value(ids).unwrap(),
                        expected["detail"]["ids"],
                        "{} reverse={reverse}",
                        case["name"]
                    );
                } else if facts.iter().any(|f| !f.pending().is_empty()) {
                    assert_eq!(expected["reason"], "trust_pending", "{}", case["name"]);
                    assert!(expected["next"]["accepted"].is_null());
                } else {
                    assert!(expected["reason"].is_null(), "{}", case["name"]);
                    assert!(!expected["next"]["accepted"].is_null());
                }
            }
        }
    }
}

#[test]
fn authentic_but_refused_bootstrap_is_diagnostic_and_cannot_issue_complete_entries() {
    use ed25519_dalek::SigningKey;
    use treehouse_tauri_shell::catalog_eval::{chains, histories::AuthenticatedHistories};
    let table = decode_peer(&catalog_peer::output(
        "ts",
        "artifact-profile-produce",
        None,
        4 * 1024 * 1024,
    ));
    let bundle = &table["bundle"];
    let space = bundle["review"]["space"].as_str().unwrap();
    let bootstrap_id = bundle["review"]["bootstrapId"].as_str().unwrap();
    let mut histories = bundle["histories"].as_array().unwrap().clone();
    let history = histories
        .iter_mut()
        .find(|h| h["replica"] == space)
        .unwrap();
    let original = history["frames"]
        .as_array()
        .unwrap()
        .iter()
        .find(|op| op["id"] == bootstrap_id)
        .unwrap()
        .clone();
    let deps = original["deps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let refused = catalog_author::signed(
        &SigningKey::from_bytes(&[217; 32]),
        space,
        &deps,
        "command",
        original["body"].clone(),
        original["cap"].clone(),
    );
    let refused_id = refused["id"].as_str().unwrap().to_owned();
    history["frames"].as_array_mut().unwrap().push(refused);
    let raw = histories
        .iter()
        .map(|h| {
            (
                h["replica"].as_str().unwrap(),
                serde_json::to_vec(h).unwrap(),
            )
        })
        .collect::<Vec<_>>();
    let refs = raw
        .iter()
        .map(|(name, bytes)| (*name, bytes.as_slice()))
        .collect::<Vec<_>>();
    let authenticated = AuthenticatedHistories::authenticate(&refs).unwrap();
    let bootstrap =
        entries::BootstrapObservation::observe(&authenticated, space, &refused_id).unwrap();
    assert!(bootstrap.current_refusal().is_some());
    assert_eq!(bootstrap.source().id(), refused_id);
    assert!(chains::observe_bootstrap(&bootstrap, &[], &[]).is_ok());
    let mut catalog: serde_json::Value =
        serde_json::from_str(bundle["catalogJson"].as_str().unwrap()).unwrap();
    let record = carrier_field_mut(&mut catalog, "catalog");
    *carrier_field_mut(record, "bootstrap") = catalog_author::text(&refused_id);
    for entry in carrier_field_mut(record, "entries")[1]
        .as_array_mut()
        .unwrap()
    {
        if carrier_field_mut(entry, "kind") == &serde_json::json!(["atom", "space"]) {
            *carrier_field_mut(entry, "reference") = catalog_author::text(&refused_id);
        }
    }
    let json = serde_json::to_string(&catalog).unwrap();
    let artifact = artifact::parse(json.as_bytes()).unwrap();
    assert_eq!(
        entries::observe(&artifact, &refs).unwrap_err(),
        "invalid_catalog_transition"
    );
    // The actual BEAM complete-entry owner independently refuses this signed
    // operation. Neither entry owner selects or verifies the catalog signer.
    let public = decode_peer(&catalog_peer::output(
        "beam",
        "entries-consume",
        Some(&serde_json::json!({"cases":[{"catalogJson":json,"histories":histories}]})),
        4 * 1024 * 1024,
    ));
    assert_eq!(public["results"][0]["reason"], "invalid_catalog_transition");
}
