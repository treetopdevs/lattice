//! Plan 181 5b: the dev-trace identity seam. Compiled only with `treehouse-dev-trace`.
//! The seam replaces key generation with a fixed test key for one packaged test variant; it never
//! touches a key store and it is absent from the ordinary build.
#![cfg(feature = "treehouse-dev-trace")]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::{Signature, SigningKey, Verifier as _};
use lattice_mobile_core::CarrierKeySeedStore;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use treehouse_tauri_shell::preview::PreviewStore;

/// A key store that records every access. The seam must never save, and a fixed key is never
/// loaded from it either.
#[derive(Default)]
struct TrippedStore {
    saves: AtomicUsize,
    loads: AtomicUsize,
}
impl CarrierKeySeedStore for TrippedStore {
    fn load_seed(&self, _key_id: &str) -> Result<Option<[u8; 32]>, String> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    }
    fn save_seed(&self, _key_id: &str, _seed: [u8; 32]) -> Result<(), String> {
        self.saves.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn seed(byte: u8) -> [u8; 32] {
    [byte; 32]
}
fn public(seed: [u8; 32]) -> String {
    BASE64.encode(SigningKey::from_bytes(&seed).verifying_key().as_bytes())
}
fn intent(kind: &str, name: &str) -> Value {
    json!({"version":2,"product":"treehouse","revision":1,"publicKey":null,"profiles":[],"active":null,"intent":{"kind":kind,"name":name,"nonce":"a".repeat(43)},"clearedDrafts":{},"relay":null})
}
/// The commit that persists the key. A join intent is spent by it; a space intent stays until
/// the Space profile exists.
fn with_key(mut record: Value, key: &str) -> Value {
    record["publicKey"] = json!(key);
    if record["intent"]["kind"] == "join" {
        record["intent"] = Value::Null;
    }
    record["revision"] = json!(2);
    record
}

#[test]
fn first_launch_reports_absent_key_not_missing_local_history() {
    let dir = tempfile::tempdir().unwrap();
    let store = PreviewStore::at_directory_dev(dir.path(), seed(7)).unwrap();
    let opened = store.open().unwrap();
    assert_eq!(opened.key_status, "absent");
    assert_eq!(opened.public_key, None);
    assert_eq!(opened.record, None);
}

#[test]
fn initialize_yields_exactly_the_seed_key_and_writes_nothing_to_a_key_store() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(TrippedStore::default());
    let mut store = PreviewStore::at_directory_dev_with(dir.path(), seed(7), keys.clone()).unwrap();
    assert_eq!(
        store.initialize(),
        Err("identity_creation_not_allowed".to_string()),
        "no intent, no key: the existing creation gate still applies"
    );
    assert!(store
        .commit(0, &intent("space", "Canopy").to_string())
        .unwrap());
    assert_eq!(store.initialize().unwrap(), public(seed(7)));
    assert_eq!(
        keys.saves.load(Ordering::SeqCst),
        0,
        "no seed is ever saved"
    );
    assert_eq!(
        keys.loads.load(Ordering::SeqCst),
        0,
        "the key store is never consulted"
    );
    // Before the key is persisted, open sees the seeded key against an intent-only record.
    let opened = store.open().unwrap();
    assert_eq!(opened.public_key, Some(public(seed(7))));
    assert_eq!(opened.key_status, "available");
}

#[test]
fn the_commit_that_persists_the_seed_key_succeeds_and_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = PreviewStore::at_directory_dev(dir.path(), seed(9)).unwrap();
    let pending = intent("space", "Canopy");
    assert!(store.commit(0, &pending.to_string()).unwrap());
    let key = store.initialize().unwrap();
    let done = with_key(pending, &key);
    assert!(
        store.commit(1, &done.to_string()).unwrap(),
        "no identity_mismatch"
    );
    drop(store);
    let store = PreviewStore::at_directory_dev(dir.path(), seed(9)).unwrap();
    let opened = store.open().unwrap();
    assert_eq!(opened.key_status, "available");
    assert_eq!(opened.public_key, Some(public(seed(9))));
    assert_eq!(opened.record, Some(done.to_string()));
    let signature = store.sign(&BASE64.encode(b"treehouse")).unwrap();
    let signature = Signature::from_slice(&BASE64.decode(signature).unwrap()).unwrap();
    SigningKey::from_bytes(&seed(9))
        .verifying_key()
        .verify(b"treehouse", &signature)
        .unwrap();
}

#[test]
fn join_and_space_intents_both_work() {
    for (kind, name, byte) in [("join", "join", 3u8), ("space", "Canopy", 4u8)] {
        let dir = tempfile::tempdir().unwrap();
        let mut store = PreviewStore::at_directory_dev(dir.path(), seed(byte)).unwrap();
        let pending = intent(kind, name);
        assert!(store.commit(0, &pending.to_string()).unwrap(), "{kind}");
        let key = store.initialize().unwrap();
        assert_eq!(key, public(seed(byte)), "{kind}");
        assert!(
            store
                .commit(1, &with_key(pending, &key).to_string())
                .unwrap(),
            "{kind}"
        );
        assert_eq!(store.open().unwrap().key_status, "available", "{kind}");
    }
}

#[test]
fn two_directories_with_two_seeds_hold_different_keys() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut first = PreviewStore::at_directory_dev(a.path(), seed(1)).unwrap();
    let mut second = PreviewStore::at_directory_dev(b.path(), seed(2)).unwrap();
    for store in [&mut first, &mut second] {
        assert!(store
            .commit(0, &intent("space", "Canopy").to_string())
            .unwrap());
    }
    let (ka, kb) = (first.initialize().unwrap(), second.initialize().unwrap());
    assert_ne!(ka, kb);
    assert!(first
        .commit(1, &with_key(intent("space", "Canopy"), &ka).to_string())
        .unwrap());
    assert!(second
        .commit(1, &with_key(intent("space", "Canopy"), &kb).to_string())
        .unwrap());
    // One store's key cannot sign for the other's persisted identity.
    drop(second);
    let wrong = PreviewStore::at_directory_dev(b.path(), seed(1)).unwrap();
    assert_eq!(wrong.open().unwrap().key_status, "mismatch");
    assert_eq!(wrong.sign("YWJj"), Err("identity_mismatch".to_string()));
}

#[test]
fn a_seeded_store_never_mints_a_key_without_an_intent() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(TrippedStore::default());
    let mut store = PreviewStore::at_directory_dev_with(dir.path(), seed(5), keys.clone()).unwrap();
    assert!(store.initialize().is_err());
    assert_eq!(store.open().unwrap().public_key, None);
    // Signing before any identity is persisted is refused, not served by the fixed key.
    assert_eq!(store.sign("YWJj"), Err("identity_unavailable".to_string()));
    assert_eq!(keys.saves.load(Ordering::SeqCst), 0);
}

#[test]
fn trace_records_command_names_only() {
    let dir = tempfile::tempdir().unwrap();
    let trace = dir.path().join("trace.log");
    let mut store = PreviewStore::at_directory_dev(dir.path(), seed(8))
        .unwrap()
        .with_dev_trace(trace.clone());
    store.open().unwrap();
    let pending = intent("space", "Private group name");
    assert!(store.commit(0, &pending.to_string()).unwrap());
    let key = store.initialize().unwrap();
    assert!(store
        .commit(1, &with_key(pending, &key).to_string())
        .unwrap());
    store.sign(&BASE64.encode(b"payload-text")).unwrap();
    let text = std::fs::read_to_string(&trace).unwrap();
    assert_eq!(
        text.lines().collect::<Vec<_>>(),
        [
            "treehouse_open",
            "treehouse_commit",
            "treehouse_initialize_identity",
            "treehouse_commit",
            "treehouse_sign_carrier"
        ]
    );
    assert!(!text.contains("Private group name"));
    assert!(!text.contains("payload-text"));
}
