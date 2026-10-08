use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use lattice_mobile_core::{CarrierKeySeedStore, InMemoryCarrierKeySeedStore, ProductDatabase};
use serde_json::{json, Value};
use std::sync::Arc;
use treehouse_tauri_shell::preview::PreviewStore;
fn intent() -> Value {
    json!({"version":2,"product":"treehouse","revision":1,"publicKey":null,"profiles":[],"active":null,
 "intent":{"kind":"space","name":"Canopy","nonce":"a".repeat(43)},"clearedDrafts":{},"relay":null})
}
fn commit(store: &mut PreviewStore, old: u64, value: &Value) -> bool {
    store.commit(old, &value.to_string()).unwrap()
}
fn initialized(store: &mut PreviewStore) -> Value {
    let mut r = intent();
    assert!(commit(store, 0, &r));
    let key = store.initialize().unwrap();
    r["publicKey"] = json!(key);
    r["revision"] = json!(2);
    assert!(commit(store, 1, &r));
    r
}
fn with_space(mut r: Value) -> Value {
    let replica = format!(
        "replica:treehouse:space:{}#root:{}",
        "a".repeat(43),
        "b".repeat(43)
    );
    let id = "c".repeat(43);
    r["profiles"] = json!([{"product":"Treehouse.Space","replica":replica,"frames":[{"v":1,"id":id,"replica":replica,"author":r["publicKey"],"deps":[],"kind":"authority","body":["nil"],"cap":["nil"],"sig":"native-retention-layer-sentinel"}],"outbox":[id],"acked":[]}]);
    r["active"] = json!(replica);
    r["intent"] = Value::Null;
    r["revision"] = json!(3);
    r
}
#[test]
fn command_boundary_cannot_drop_or_mutate_acknowledged_history() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(InMemoryCarrierKeySeedStore::default());
    let mut store = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    assert!(store.open().unwrap().public_key.is_none());
    assert!(store.initialize().is_err());
    let initial = initialized(&mut store);
    let saved = with_space(initial);
    assert!(commit(&mut store, 2, &saved));
    let mut lost = intent();
    lost["revision"] = json!(4);
    lost["publicKey"] = saved["publicKey"].clone();
    assert!(
        store.commit(3, &lost.to_string()).is_err(),
        "a current-revision writer must not erase retained profiles"
    );
    let mut altered = saved.clone();
    altered["revision"] = json!(4);
    altered["profiles"][0]["frames"][0]["sig"] = json!("changed");
    assert!(store.commit(3, &altered.to_string()).is_err());
    assert_eq!(
        store.open().unwrap().record.as_deref(),
        Some(saved.to_string().as_str())
    );
    let mut next = saved.clone();
    next["revision"] = json!(4);
    assert!(commit(&mut store, 3, &next));
    let mut second = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    assert!(!second.commit(3, &next.to_string()).unwrap());
    keys.save_seed("device-carrier-v1", [17; 32]).unwrap();
    assert_eq!(second.open().unwrap().key_status, "mismatch");
    next["revision"] = json!(5);
    assert!(second.commit(4, &next.to_string()).is_err());
    assert!(second.sign("YWJj").is_err());
    assert!(second.initialize().is_err());
}
#[test]
fn interrupted_creation_reuses_key_but_missing_history_never_creates_another() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(InMemoryCarrierKeySeedStore::default());
    let mut first = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    assert!(commit(&mut first, 0, &intent()));
    let key = first.initialize().unwrap();
    drop(first);
    let mut reopened = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    assert_eq!(reopened.initialize().unwrap(), key);
    let empty = tempfile::tempdir().unwrap();
    let mut no_history = PreviewStore::at_directory(empty.path(), keys).unwrap();
    assert!(no_history.open().is_err());
    assert!(no_history.initialize().is_err());
}

#[test]
fn small_draft_cas_and_post_watermark_do_not_erase_a_later_draft() {
    draft_round_trip(&"d".repeat(43), &"b".repeat(43), false);
}
#[test]
fn public_replica_tokens_containing_seed_allow_drafts_and_post_watermarks() {
    let secret_shaped_public_token = format!("Seed{}", "d".repeat(39));
    draft_round_trip(&secret_shaped_public_token, &"b".repeat(43), false);
    draft_round_trip(&"d".repeat(43), &secret_shaped_public_token, false);
}
fn thread_record(store: &mut PreviewStore, nonce: &str, root: &str) -> (Value, String) {
    let initial = initialized(store);
    let mut record = with_space(initial);
    assert!(commit(store, 2, &record));
    record["revision"] = json!(4);
    record["intent"] = json!({"kind":"thread","name":"Notes","nonce":nonce});
    assert!(commit(store, 3, &record));
    let thread = format!("replica:treehouse:thread:{}#root:{}", nonce, root);
    let mut profile = record["profiles"][0].clone();
    profile["product"] = json!("Treehouse.Thread");
    profile["replica"] = json!(thread);
    profile["frames"][0]["replica"] = json!(thread);
    profile["frames"][0]["id"] = json!("e".repeat(43));
    profile["outbox"] = json!(["e".repeat(43)]);
    record["profiles"].as_array_mut().unwrap().push(profile);
    record["intent"] = Value::Null;
    record["active"] = json!(thread);
    record["revision"] = json!(5);
    assert!(commit(store, 4, &record));
    (record, thread)
}
#[test]
fn retained_legacy_draft_keeps_its_revision_and_post_watermark() {
    draft_round_trip(&"d".repeat(43), &"b".repeat(43), true);
}
fn draft_round_trip(nonce: &str, root: &str, legacy: bool) {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(InMemoryCarrierKeySeedStore::default());
    let mut store = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    let (record, thread) = thread_record(&mut store, nonce, root);
    let initial_revision = if legacy { 7 } else { 0 };
    if legacy {
        let preceding =
            ProductDatabase::open_path("treehouse", &dir.path().join("treehouse-v1.sqlite3"))
                .unwrap();
        preceding
            .kv_set(
                &format!("treehouse:preview:draft:{thread}"),
                &json!({"version":1,"revision":initial_revision,"text":"Retained legacy draft"})
                    .to_string(),
            )
            .unwrap();
        let restored = store.load_draft(&thread).unwrap().unwrap();
        assert_eq!(restored.revision, initial_revision);
        assert_eq!(restored.text, "Retained legacy draft");
    }
    let before = store.open().unwrap().record;
    assert_eq!(
        store
            .save_draft(&thread, initial_revision, "A draft")
            .unwrap()
            .unwrap()
            .revision,
        initial_revision + 1
    );
    assert_eq!(
        store.open().unwrap().record,
        before,
        "typing does not rewrite retained history"
    );
    let mut other = PreviewStore::at_directory(dir.path(), keys).unwrap();
    assert!(other
        .save_draft(&thread, initial_revision, "Stale draft")
        .unwrap()
        .is_none());
    let mut posted = record.clone();
    posted["revision"] = json!(6);
    let mut frame = posted["profiles"][1]["frames"][0].clone();
    frame["id"] = json!("f".repeat(43));
    frame["deps"] = json!(["e".repeat(43)]);
    posted["profiles"][1]["frames"]
        .as_array_mut()
        .unwrap()
        .push(frame);
    posted["profiles"][1]["outbox"]
        .as_array_mut()
        .unwrap()
        .push(json!("f".repeat(43)));
    posted["clearedDrafts"][&thread] = json!(initial_revision + 2);
    assert!(store.commit(5, &posted.to_string()).is_err());
    posted["clearedDrafts"][&thread] = json!(initial_revision + 1);
    assert!(commit(&mut store, 5, &posted));
    let later = other
        .save_draft(&thread, initial_revision + 1, "A later draft")
        .unwrap()
        .unwrap();
    assert_eq!(later.revision, initial_revision + 2);
    assert_eq!(store.load_draft(&thread).unwrap().unwrap(), later);
    if legacy {
        let db = ProductDatabase::open_path("treehouse", &dir.path().join("treehouse-v1.sqlite3"))
            .unwrap();
        let retained = db
            .kv_get(&format!("treehouse:preview:draft:{thread}"))
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&retained).unwrap()["revision"],
            initial_revision + 2
        );
        assert_eq!(
            db.kv_get(DIGEST_DRAFT_KEY).unwrap(),
            None,
            "retained legacy drafts are not copied or migrated"
        );
    }
    assert_eq!(
        serde_json::from_str::<Value>(&store.open().unwrap().record.unwrap()).unwrap()
            ["clearedDrafts"][&thread],
        initial_revision + 1
    );
}

// Fixed public fixture digest, independently computed from the d/b replica above.
const DIGEST_DRAFT_KEY: &str =
    "treehouse:preview:draft:66523e02425751cfbc6d2db953e02345a2fb24cbca405490626059d945017806";
#[test]
fn conflicting_draft_rows_refuse_reads_saves_and_watermarks_without_choosing_a_winner() {
    for same_text in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let keys = Arc::new(InMemoryCarrierKeySeedStore::default());
        let mut store = PreviewStore::at_directory(dir.path(), keys).unwrap();
        let (record, thread) = thread_record(&mut store, &"d".repeat(43), &"b".repeat(43));
        let db = ProductDatabase::open_path("treehouse", &dir.path().join("treehouse-v1.sqlite3"))
            .unwrap();
        let legacy_key = format!("treehouse:preview:draft:{thread}");
        let legacy = json!({"version":1,"revision":1,"text":"Old process draft"}).to_string();
        let current = if same_text {
            legacy.clone()
        } else {
            json!({"version":1,"revision":1,"text":"New process draft"}).to_string()
        };
        db.kv_set(&legacy_key, &legacy).unwrap();
        db.kv_set(DIGEST_DRAFT_KEY, &current).unwrap();
        assert_eq!(
            store.load_draft(&thread).unwrap_err(),
            "draft_storage_conflict"
        );
        for text in ["", "Replacement"] {
            assert_eq!(
                store.save_draft(&thread, 1, text).unwrap_err(),
                "draft_storage_conflict"
            );
        }
        let mut posted = record.clone();
        posted["revision"] = json!(6);
        let mut frame = posted["profiles"][1]["frames"][0].clone();
        frame["id"] = json!("f".repeat(43));
        frame["deps"] = json!(["e".repeat(43)]);
        posted["profiles"][1]["frames"]
            .as_array_mut()
            .unwrap()
            .push(frame);
        posted["profiles"][1]["outbox"]
            .as_array_mut()
            .unwrap()
            .push(json!("f".repeat(43)));
        posted["clearedDrafts"][&thread] = json!(1);
        assert_eq!(
            store.commit(5, &posted.to_string()).unwrap_err(),
            "draft_storage_conflict"
        );
        assert_eq!(store.open().unwrap().record, Some(record.to_string()));
        assert_eq!(db.kv_get(&legacy_key).unwrap(), Some(legacy));
        assert_eq!(db.kv_get(DIGEST_DRAFT_KEY).unwrap(), Some(current));
    }
}
#[test]
fn corrupt_legacy_draft_refuses_without_creating_a_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(InMemoryCarrierKeySeedStore::default());
    let mut store = PreviewStore::at_directory(dir.path(), keys).unwrap();
    let (record, thread) = thread_record(&mut store, &"d".repeat(43), &"b".repeat(43));
    let db =
        ProductDatabase::open_path("treehouse", &dir.path().join("treehouse-v1.sqlite3")).unwrap();
    let legacy_key = format!("treehouse:preview:draft:{thread}");
    db.kv_set(&legacy_key, "invalid retained draft").unwrap();
    assert_eq!(store.load_draft(&thread).unwrap_err(), "invalid_draft");
    assert_eq!(
        store.save_draft(&thread, 0, "Replacement").unwrap_err(),
        "invalid_draft"
    );
    assert_eq!(store.open().unwrap().record, Some(record.to_string()));
    assert_eq!(
        db.kv_get(&legacy_key).unwrap().as_deref(),
        Some("invalid retained draft")
    );
    assert_eq!(db.kv_get(DIGEST_DRAFT_KEY).unwrap(), None);
}

fn join_intent() -> Value {
    json!({"version":2,"product":"treehouse","revision":1,"publicKey":null,"profiles":[],"active":null,
 "intent":{"kind":"join","name":"join","nonce":"j".repeat(43)},"clearedDrafts":{},"relay":null})
}
fn cleared(key: &str) -> Value {
    let mut r = join_intent();
    r["publicKey"] = json!(key);
    r["intent"] = Value::Null;
    r["revision"] = json!(2);
    r
}
#[test]
fn join_intent_mints_exactly_one_key_and_is_cleared_by_the_key_commit() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(InMemoryCarrierKeySeedStore::default());
    let mut store = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    assert!(commit(&mut store, 0, &join_intent()));
    let key = store.initialize().unwrap();
    // A crash between key creation and the clearing commit reuses the same key.
    assert_eq!(store.initialize().unwrap(), key);
    // Clearing the intent without the key skips the identity and is refused.
    let mut skip = join_intent();
    skip["intent"] = Value::Null;
    skip["revision"] = json!(2);
    assert_eq!(
        store.commit(1, &skip.to_string()).unwrap_err(),
        "creation_incomplete"
    );
    // Persisting the key while keeping the intent is not the clearing commit either.
    let mut keyed = join_intent();
    keyed["publicKey"] = json!(key);
    keyed["revision"] = json!(2);
    assert_eq!(
        store.commit(1, &keyed.to_string()).unwrap_err(),
        "creation_incomplete"
    );
    assert!(commit(&mut store, 1, &cleared(&key)));
    let opened = store.open().unwrap();
    assert_eq!(opened.key_status, "available");
    assert_eq!(opened.public_key.as_deref(), Some(key.as_str()));
    // The intent is spent: no second key, from this handle or a reopened one.
    assert_eq!(
        store.initialize().unwrap_err(),
        "identity_creation_not_allowed"
    );
    drop(store);
    let mut reopened = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    assert_eq!(
        reopened.initialize().unwrap_err(),
        "identity_creation_not_allowed"
    );
    // Reopening with the key lost mints nothing.
    let lost = Arc::new(InMemoryCarrierKeySeedStore::default());
    let mut lost_store = PreviewStore::at_directory(dir.path(), lost.clone()).unwrap();
    assert_eq!(lost_store.open().unwrap().key_status, "missing");
    assert_eq!(
        lost_store.initialize().unwrap_err(),
        "identity_creation_not_allowed"
    );
    assert!(lost.load_seed("device-carrier-v1").unwrap().is_none());
}
#[test]
fn join_intent_never_coexists_with_profiles_or_a_prior_identity() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(InMemoryCarrierKeySeedStore::default());
    let mut store = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    let initial = initialized(&mut store);
    let saved = with_space(initial);
    assert!(commit(&mut store, 2, &saved));
    // A join intent cannot be laid over an existing identity and Space.
    let mut over = saved.clone();
    over["intent"] = json!({"kind":"join","name":"join","nonce":"j".repeat(43)});
    over["revision"] = json!(4);
    assert_eq!(
        store.commit(3, &over.to_string()).unwrap_err(),
        "identity_creation_not_allowed"
    );
    // A fresh join record that already carries profiles is refused, and no key is minted.
    let dir2 = tempfile::tempdir().unwrap();
    let keys2 = Arc::new(InMemoryCarrierKeySeedStore::default());
    let mut fresh = PreviewStore::at_directory(dir2.path(), keys2.clone()).unwrap();
    let mut with_profiles = with_space(join_intent());
    with_profiles["intent"] = json!({"kind":"join","name":"join","nonce":"j".repeat(43)});
    with_profiles["revision"] = json!(1);
    assert!(fresh.commit(0, &with_profiles.to_string()).is_err());
    assert!(fresh.initialize().is_err());
    assert!(keys2.load_seed("device-carrier-v1").unwrap().is_none());
}
#[test]
fn joiner_keeps_a_foreign_root_space_profile_and_the_acked_set_only_grows() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(InMemoryCarrierKeySeedStore::default());
    let mut store = PreviewStore::at_directory(dir.path(), keys).unwrap();
    assert!(commit(&mut store, 0, &join_intent()));
    let key = store.initialize().unwrap();
    assert!(commit(&mut store, 1, &cleared(&key)));
    let replica = format!(
        "replica:treehouse:space:{}#root:{}",
        "a".repeat(43),
        "b".repeat(43)
    );
    let (g, p) = ("c".repeat(43), "d".repeat(43));
    let frame = |id: &str, deps: Value| json!({"v":1,"id":id,"replica":replica,"author":"founder","deps":deps,"kind":"authority","body":["nil"],"cap":["nil"],"sig":"s"});
    let mut joined = cleared(&key);
    joined["revision"] = json!(3);
    joined["active"] = json!(replica);
    joined["profiles"] = json!([{"product":"Treehouse.Space","replica":replica,
        "frames":[frame(&g, json!([])), frame(&p, json!([g]))],"outbox":[],"acked":[g]}]);
    // A pulled foreign frame is acked, never pending; the Rust store checks format only.
    assert!(commit(&mut store, 2, &joined));
    // acked ids must be retained frame ids.
    let mut stray = joined.clone();
    stray["revision"] = json!(4);
    stray["profiles"][0]["acked"] = json!([g, "z".repeat(43)]);
    assert!(store.commit(3, &stray.to_string()).is_err());
    // acked may grow.
    let mut grown = joined.clone();
    grown["revision"] = json!(4);
    grown["profiles"][0]["acked"] = json!([g, p]);
    assert!(commit(&mut store, 3, &grown));
    // acked may not shrink, and duplicates are refused.
    let mut shrunk = grown.clone();
    shrunk["revision"] = json!(5);
    shrunk["profiles"][0]["acked"] = json!([g]);
    assert_eq!(
        store.commit(4, &shrunk.to_string()).unwrap_err(),
        "retained_history_changed"
    );
    let mut dup = grown.clone();
    dup["revision"] = json!(5);
    dup["profiles"][0]["acked"] = json!([g, g, p]);
    assert!(store.commit(4, &dup.to_string()).is_err());
}
#[test]
fn relay_routes_are_capped_closed_and_pinned() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(InMemoryCarrierKeySeedStore::default());
    let mut store = PreviewStore::at_directory(dir.path(), keys).unwrap();
    let initial = initialized(&mut store);
    let pk = |n: u8| BASE64.encode([n; 32]);
    // Route 1 is the Space; the rest are Threads.
    let replica = |n: u8| {
        let nonce: String = std::iter::repeat_n(char::from(b'a' + n), 43).collect();
        let kind = if n == 1 { "space" } else { "thread" };
        format!("replica:treehouse:{kind}:{nonce}#root:{}", "R".repeat(43))
    };
    let route = |n: u8| json!({"replica":replica(n),"url":"ws://127.0.0.1:8080","expectedPeerRealm":"server","expectedPeerPubkey":pk(n)});
    let with = |n: u8, field: &str, value: &str| {
        let mut r = route(n);
        r[field] = json!(value);
        r
    };
    let relay = |routes: Vec<Value>| json!({"localRealm":"local","routes":routes});
    let mut next = initial.clone();
    next["revision"] = json!(3);
    next["relay"] = relay((1..=5).map(route).collect());
    assert_eq!(
        store.commit(2, &next.to_string()).unwrap_err(),
        "invalid_relay"
    );
    // A closed record: unknown or malformed fields refuse before the relay rules run.
    for bad in [
        json!({"localRealm":"local","routes":[route(1)],"extra":1}),
        relay(vec![
            json!({"replica":"r","url":"ws://x","expectedPeerRealm":"s","expectedPeerPubkey":"short"}),
        ]),
    ] {
        next["relay"] = bad;
        assert!(store.commit(2, &next.to_string()).is_err());
    }
    // The shell's semantic route rules hold at the persistence boundary too.
    for bad in [
        relay(vec![route(1), route(1)]),
        json!({"localRealm":"","routes":[]}),
        json!({"localRealm":"local","routes":[]}),
        json!({"localRealm":" local","routes":[route(1)]}),
        relay(vec![with(1, "replica", "r1")]),
        relay(vec![with(
            1,
            "replica",
            "replica:treehouse:space:short#root:short",
        )]),
        relay(vec![with(1, "url", "http://127.0.0.1:8080")]),
        relay(vec![with(1, "url", "ws://example.com:8080")]),
        relay(vec![with(1, "url", "wss://user@example.com")]),
        relay(vec![with(1, "url", "wss://example.com/#frag")]),
        relay(vec![with(1, "url", "ws://127.0.0.1:99999")]),
        relay(vec![with(1, "url", "ws://127.0.0.1:8a")]),
        relay(vec![with(1, "url", " wss://example.com")]),
        relay(vec![with(1, "url", "wss://[not-an-ip]")]),
        relay(vec![with(1, "url", "wss://[fe80::1%25en0]")]),
        relay(vec![with(1, "url", "wss://1.2.3.999")]),
        relay(vec![with(1, "url", "wss://ex\u{e4}mple.com")]),
        relay(vec![with(1, "url", "ws://[::2]:9")]),
        relay(vec![with(1, "url", "ws://[0:0:0:0:0:0:0:1]:9")]),
        relay(vec![with(1, "url", "ws://127.1")]),
        relay(vec![with(1, "url", "wss://[::ffff:1.2.3.4]")]),
        relay(vec![with(1, "url", "wss://010.0.0.1")]),
        relay(vec![with(1, "url", "wss://ex%61mple.com")]),
        relay(vec![with(1, "url", "wss://example.com/\u{e9}")]),
        // Exactly one Space route: none, or two, is refused.
        relay((2..=5).map(route).collect()),
        relay(vec![
            route(1),
            with(2, "replica", &replica(1).replacen("bbbb", "zzzz", 1)),
        ]),
        relay(vec![with(1, "url", "wss://example.com/\u{1}")]),
        relay(vec![with(1, "expectedPeerRealm", "server ")]),
    ] {
        next["relay"] = bad;
        assert_eq!(
            store.commit(2, &next.to_string()).unwrap_err(),
            "invalid_relay"
        );
    }
    for good in [
        "wss://relay.example.com:443/carrier",
        "ws://localhost:1",
        "ws://LocalHost:1",
        "ws://[::1]:9",
        "wss://[::A]",
        "wss://[2001:db8::1]:443",
        "wss://10.0.0.1",
        "wss://x:",
        "ws://[::1]:",
        "WSS://x",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut fresh = PreviewStore::at_directory(
            dir.path(),
            Arc::new(InMemoryCarrierKeySeedStore::default()),
        )
        .unwrap();
        let mut probe = initialized(&mut fresh);
        probe["revision"] = json!(3);
        probe["relay"] = relay(vec![with(1, "url", good)]);
        assert!(commit(&mut fresh, 2, &probe), "{good} is a valid route url");
    }
    next["relay"] = relay(vec![route(1), route(2)]);
    assert!(commit(&mut store, 2, &next));

    // Saved routes and the local realm are pinned; only additions are accepted.
    let replaced_url = with(1, "url", "ws://127.0.0.1:9090");
    let replaced_key = with(1, "expectedPeerPubkey", &pk(9));
    next["revision"] = json!(4);
    for bad in [
        relay(vec![replaced_url, route(2)]),
        relay(vec![replaced_key, route(2)]),
        relay(vec![route(1)]),
        json!({"localRealm":"other","routes":[route(1), route(2)]}),
        Value::Null,
    ] {
        next["relay"] = bad;
        assert_eq!(
            store.commit(3, &next.to_string()).unwrap_err(),
            "relay_already_configured"
        );
    }
    next["relay"] = relay((1..=4).map(route).collect());
    assert!(commit(&mut store, 3, &next));
}
