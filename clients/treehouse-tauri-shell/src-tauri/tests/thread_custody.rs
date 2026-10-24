use base64::{
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD},
    Engine as _,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use lattice_mobile_core::CarrierKeySeedStore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use treehouse_tauri_shell::preview::PreviewStore;

#[derive(Default)]
struct Keys {
    seeds: Mutex<HashMap<String, [u8; 32]>>,
    writes: AtomicUsize,
    fail_after_save: AtomicBool,
    disappear_on_load: AtomicBool,
}
impl CarrierKeySeedStore for Keys {
    fn load_seed(&self, alias: &str) -> Result<Option<[u8; 32]>, String> {
        let mut seeds = self.seeds.lock().unwrap();
        if alias.starts_with("thread-root-v1:")
            && self.disappear_on_load.swap(false, Ordering::SeqCst)
        {
            return Ok(seeds.remove(alias));
        }
        Ok(seeds.get(alias).copied())
    }
    fn save_seed(&self, alias: &str, seed: [u8; 32]) -> Result<(), String> {
        self.seeds.lock().unwrap().insert(alias.into(), seed);
        self.writes.fetch_add(1, Ordering::SeqCst);
        if self.fail_after_save.swap(false, Ordering::SeqCst) {
            return Err("injected_after_save".into());
        }
        Ok(())
    }
}
fn pending(store: &mut PreviewStore) -> Value {
    let nonce = "A".repeat(43);
    let mut r = json!({"version":2,"product":"treehouse","revision":1,"publicKey":null,"profiles":[],"active":null,
      "intent":{"kind":"space","name":"Canopy","nonce":nonce},"clearedDrafts":{},"relay":null});
    assert!(store.commit(0, &r.to_string()).unwrap());
    let public = store.initialize().unwrap();
    let replica = format!("replica:treehouse:space:{nonce}#root:{}", "B".repeat(43));
    let id = "C".repeat(43);
    r["publicKey"] = json!(public);
    r["profiles"] = json!([{"product":"Treehouse.Space","replica":replica,"frames":[{"v":1,"id":id,"replica":replica,
      "author":public,"deps":[],"kind":"authority","body":["nil"],"cap":["nil"],"sig":"retention-test-sentinel"}],"outbox":[id],"acked":[]}]);
    r["active"] = json!(replica);
    r["intent"] = Value::Null;
    r["revision"] = json!(2);
    assert!(store.commit(1, &r.to_string()).unwrap());
    r["revision"] = json!(3);
    r["intent"] = json!({"kind":"thread","name":"General","nonce":nonce,"setup":{
        "nominee":BASE64.encode([2;32]),"witnesses":[BASE64.encode([3;32]),BASE64.encode([4;32])],"threshold":2,"maxLeaseEpochs":7}});
    assert!(store.commit(2, &r.to_string()).unwrap());
    r
}
fn alias(r: &Value) -> String {
    format!(
        "thread-root-v1:{}:{}",
        URL_SAFE_NO_PAD.encode(BASE64.decode(r["publicKey"].as_str().unwrap()).unwrap()),
        "A".repeat(43)
    )
}
fn replica(public: &str) -> String {
    format!(
        "replica:treehouse:thread:{}#authority:bounded-continuation-v1#root:{}",
        "A".repeat(43),
        URL_SAFE_NO_PAD.encode(Sha256::digest(BASE64.decode(public).unwrap()))
    )
}
fn payload(replica: &str, public: &str) -> Vec<u8> {
    fn bin(out: &mut Vec<u8>, value: &[u8]) {
        if value.len() < 24 {
            out.push(0x40 + value.len() as u8);
        } else {
            out.extend([0x58, value.len() as u8]);
        }
        out.extend(value);
    }
    let mut bytes = vec![0x87];
    bin(&mut bytes, b"lattice-op-v2");
    bin(&mut bytes, replica.as_bytes());
    bin(&mut bytes, &BASE64.decode(public).unwrap());
    // Remaining canonical slots: deps [], kind atom(command), body nil, cap nil.
    bytes.extend([0x80, 0xd9, 0xea, 0x60, 0x47]);
    bytes.extend(b"command");
    bytes.extend([0xf6, 0xf6]);
    bytes
}
#[test]
fn separate_key_reopens_retries_and_refuses_missing_or_substituted_custody() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let mut store = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    assert!(store.initialize_thread(&"A".repeat(43)).is_err());
    let r = pending(&mut store);
    let first = store.initialize_thread(&"A".repeat(43)).unwrap();
    assert_ne!(first, r["publicKey"]);
    drop(store);
    let mut store = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    assert_eq!(store.initialize_thread(&"A".repeat(43)).unwrap(), first);
    assert_eq!(keys.writes.load(Ordering::SeqCst), 2);
    let original = keys.seeds.lock().unwrap().remove(&alias(&r)).unwrap();
    assert_eq!(
        store.initialize_thread(&"A".repeat(43)),
        Err("thread_key_missing".into())
    );
    assert_eq!(keys.writes.load(Ordering::SeqCst), 2);
    keys.seeds.lock().unwrap().insert(alias(&r), [99; 32]);
    assert_eq!(
        store.initialize_thread(&"A".repeat(43)),
        Err("thread_key_mismatch".into())
    );
    keys.seeds.lock().unwrap().insert(alias(&r), original);
    assert_eq!(store.initialize_thread(&"A".repeat(43)).unwrap(), first);
    assert!(store.initialize_thread(&"E".repeat(43)).is_err());
    assert!(store.initialize_thread("not-an-alias").is_err());
    let mut completed = r.clone();
    completed["revision"] = json!(4);
    completed["intent"] = Value::Null;
    let name = replica(&first);
    let mut child = completed["profiles"][0].clone();
    child["product"] = json!("Treehouse.Thread");
    child["replica"] = json!(name);
    child["frames"][0]["replica"] = json!(name);
    child["frames"][0]["author"] = json!(first);
    child["frames"][0]["id"] = json!("E".repeat(43));
    child["outbox"] = json!(["E".repeat(43)]);
    completed["profiles"].as_array_mut().unwrap().push(child);
    completed["active"] = json!(name);
    assert!(store.commit(3, &completed.to_string()).unwrap());
    drop(store);
    let mut reopened = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    assert_eq!(reopened.thread_identity(&"A".repeat(43)).unwrap(), first);
    assert_eq!(reopened.initialize_thread(&"A".repeat(43)).unwrap(), first);
    keys.seeds.lock().unwrap().remove(&alias(&r));
    assert_eq!(
        reopened.thread_identity(&"A".repeat(43)),
        Err("thread_key_missing".into())
    );
    assert_eq!(
        reopened.initialize_thread(&"A".repeat(43)),
        Err("thread_key_missing".into())
    );
    assert_eq!(keys.writes.load(Ordering::SeqCst), 2);
}
#[test]
fn interrupted_keychain_save_reuses_the_orphan_and_signing_is_replica_and_owner_bound() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let mut store = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    let r = pending(&mut store);
    keys.fail_after_save.store(true, Ordering::SeqCst);
    assert!(store.initialize_thread(&"A".repeat(43)).is_err());
    let public = store.initialize_thread(&"A".repeat(43)).unwrap();
    assert_eq!(keys.writes.load(Ordering::SeqCst), 2);
    let bytes = payload(&replica(&public), &public);
    let signature = store
        .sign_thread(&"A".repeat(43), &BASE64.encode(&bytes))
        .unwrap();
    let key =
        VerifyingKey::from_bytes(&BASE64.decode(&public).unwrap().try_into().unwrap()).unwrap();
    key.verify(
        &bytes,
        &Signature::from_slice(&BASE64.decode(signature).unwrap()).unwrap(),
    )
    .unwrap();
    for bytes in [
        payload("other-replica", &public),
        payload(&replica(&public), r["publicKey"].as_str().unwrap()),
        b"arbitrary bytes".to_vec(),
    ] {
        assert_eq!(
            store.sign_thread(&"A".repeat(43), &BASE64.encode(bytes)),
            Err("thread_signing_scope_mismatch".into())
        );
    }
    assert!(store.sign_thread(&"E".repeat(43), "YQ==").is_err());
    let mut changed = r.clone();
    changed["revision"] = json!(4);
    changed["intent"]["setup"]["threshold"] = json!(1);
    assert_eq!(
        store.commit(3, &changed.to_string()),
        Err("creation_intent_changed".into())
    );
}
#[test]
fn concurrent_windows_generate_one_child_and_cannot_spend_a_different_key() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let mut store = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    let r = pending(&mut store);
    let threads: Vec<_> = (0..2)
        .map(|_| {
            let path = dir.path().to_owned();
            let keys = keys.clone();
            std::thread::spawn(move || {
                PreviewStore::at_directory(&path, keys)
                    .unwrap()
                    .initialize_thread(&"A".repeat(43))
                    .unwrap()
            })
        })
        .collect();
    let returned: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(returned[0], returned[1]);
    assert_eq!(keys.writes.load(Ordering::SeqCst), 2);
    let mut wrong = r.clone();
    wrong["revision"] = json!(4);
    wrong["intent"] = Value::Null;
    let mut child = r["profiles"][0].clone();
    child["product"] = json!("Treehouse.Thread");
    let name = format!(
        "replica:treehouse:thread:{}#authority:bounded-continuation-v1#root:{}",
        "A".repeat(43),
        "E".repeat(43)
    );
    child["replica"] = json!(name);
    child["frames"][0]["replica"] = json!(name);
    wrong["profiles"].as_array_mut().unwrap().push(child);
    assert_eq!(
        store.commit(3, &wrong.to_string()),
        Err("thread_key_mismatch".into())
    );
    assert_eq!(store.open().unwrap().record.unwrap(), r.to_string());
}

#[test]
fn bound_key_is_never_regenerated_between_reads_and_existing_binding_is_read_only() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let mut store = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    let r = pending(&mut store);
    let first = store.initialize_thread(&"A".repeat(43)).unwrap();
    let db = rusqlite::Connection::open(dir.path().join("treehouse-v1.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_child_update BEFORE UPDATE ON kv WHEN old.key LIKE 'treehouse:preview:child:%' BEGIN SELECT RAISE(ABORT, 'read-only-binding'); END;").unwrap();
    assert_eq!(store.initialize_thread(&"A".repeat(43)).unwrap(), first);
    keys.disappear_on_load.store(true, Ordering::SeqCst);
    assert_eq!(store.initialize_thread(&"A".repeat(43)).unwrap(), first);
    assert_eq!(keys.writes.load(Ordering::SeqCst), 2);
    assert!(!keys.seeds.lock().unwrap().contains_key(&alias(&r)));
    assert_eq!(
        store.initialize_thread(&"A".repeat(43)),
        Err("thread_key_missing".into())
    );
    let mut malformed = r;
    malformed["revision"] = json!(4);
    malformed["intent"]["setup"] = Value::Null;
    assert_eq!(
        store.commit(3, &malformed.to_string()),
        Err("invalid_creation_intent".into())
    );
}

#[test]
fn oversized_setup_and_capacity_fail_before_key_creation_or_intent_progress() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(Keys::default());
    let mut store = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    let r = pending(&mut store);
    let mut oversized = r.clone();
    oversized["revision"] = json!(4);
    oversized["intent"]["setup"]["witnesses"] =
        json!((20..37).map(|n| BASE64.encode([n; 32])).collect::<Vec<_>>());
    assert_eq!(
        store.commit(3, &oversized.to_string()),
        Err("invalid_creation_intent".into())
    );
    let mut full = r.clone();
    full["revision"] = json!(4);
    let mut extra = full["profiles"][0]["frames"][0].clone();
    extra["id"] = json!("D".repeat(43));
    extra["deps"] = json!(["C".repeat(43)]);
    extra["body"] = json!(["bin", "A".repeat(920_000)]);
    full["profiles"][0]["frames"]
        .as_array_mut()
        .unwrap()
        .push(extra);
    assert_eq!(
        store.commit(3, &full.to_string()),
        Err("preview_storage_limit".into())
    );
    assert_eq!(store.open().unwrap().record.unwrap(), r.to_string());
    assert_eq!(
        keys.writes.load(Ordering::SeqCst),
        1,
        "no child key was generated"
    );
    assert_eq!(
        store.thread_identity(&"A".repeat(43)),
        Err("thread_key_unbound".into())
    );
}
