use lattice_mobile_core::{CarrierKeySeedStore, InMemoryCarrierKeySeedStore};
use serde_json::{json, Value};
use std::sync::Arc;
use treehouse_tauri_shell::preview::PreviewStore;
fn intent() -> Value {
    json!({"version":1,"product":"treehouse","revision":1,"publicKey":null,"profiles":[],"active":null,
 "intent":{"kind":"space","name":"Canopy","nonce":"a".repeat(43)},"clearedDrafts":{}})
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
    r["profiles"] = json!([{"product":"Treehouse.Space","replica":replica,"frames":[{"v":1,"id":id,"replica":replica,"author":r["publicKey"],"deps":[],"kind":"authority","body":["nil"],"cap":["nil"],"sig":"native-retention-layer-sentinel"}],"outbox":[id]}]);
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
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(InMemoryCarrierKeySeedStore::default());
    let mut store = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    let initial = initialized(&mut store);
    let mut record = with_space(initial);
    assert!(commit(&mut store, 2, &record));
    record["revision"] = json!(4);
    record["intent"] = json!({"kind":"thread","name":"Notes","nonce":"d".repeat(43)});
    assert!(commit(&mut store, 3, &record));
    let thread = format!(
        "replica:treehouse:thread:{}#root:{}",
        "d".repeat(43),
        "b".repeat(43)
    );
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
    assert!(commit(&mut store, 4, &record));
    let before = store.open().unwrap().record;
    assert_eq!(
        store
            .save_draft(&thread, 0, "A draft")
            .unwrap()
            .unwrap()
            .revision,
        1
    );
    assert_eq!(
        store.open().unwrap().record,
        before,
        "typing does not rewrite retained history"
    );
    let mut other = PreviewStore::at_directory(dir.path(), keys).unwrap();
    assert!(other
        .save_draft(&thread, 0, "Stale draft")
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
    posted["clearedDrafts"][&thread] = json!(2);
    assert!(store.commit(5, &posted.to_string()).is_err());
    posted["clearedDrafts"][&thread] = json!(1);
    assert!(commit(&mut store, 5, &posted));
    let later = other
        .save_draft(&thread, 1, "A later draft")
        .unwrap()
        .unwrap();
    assert_eq!(later.revision, 2);
    assert_eq!(store.load_draft(&thread).unwrap().unwrap(), later);
    assert_eq!(
        serde_json::from_str::<Value>(&store.open().unwrap().record.unwrap()).unwrap()
            ["clearedDrafts"][&thread],
        1
    );
}
