use lattice_mobile_core::{InMemoryCarrierKeySeedStore, ProductDatabase};
use serde_json::{json, Value};
use std::sync::Arc;
use treehouse_tauri_shell::preview::{PreviewStore, HISTORY_KEY};
fn pending() -> Value {
    json!({"version":1,"product":"treehouse","revision":1,"publicKey":null,"profiles":[],"active":null,"intent":{"kind":"space","name":"Canopy","nonce":"a".repeat(43)},"clearedDrafts":{}})
}
#[test]
fn failed_write_and_unknown_envelope_preserve_original_storage() {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(InMemoryCarrierKeySeedStore::default());
    let mut store = PreviewStore::at_directory(dir.path(), keys.clone()).unwrap();
    let initial = pending();
    assert!(store.commit(0, &initial.to_string()).unwrap());
    let conn = rusqlite::Connection::open(dir.path().join("treehouse-v1.sqlite3")).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER refuse_update BEFORE UPDATE ON kv BEGIN SELECT RAISE(ABORT,'refused');END;",
    )
    .unwrap();
    let key = store.initialize().unwrap();
    let mut next = initial.clone();
    next["publicKey"] = json!(key);
    next["revision"] = json!(2);
    assert!(store.commit(1, &next.to_string()).is_err());
    assert_eq!(store.open().unwrap().record, Some(initial.to_string()));
    conn.execute_batch("DROP TRIGGER refuse_update;").unwrap();
    assert!(store.commit(1, &next.to_string()).unwrap());
    let saved = store.open().unwrap().record;
    let mut future = next.clone();
    future["version"] = json!(900);
    future["revision"] = json!(3);
    assert!(store.commit(2, &future.to_string()).is_err());
    assert_eq!(store.open().unwrap().record, saved);
    drop(store);
    let missing =
        PreviewStore::at_directory(dir.path(), Arc::new(InMemoryCarrierKeySeedStore::default()))
            .unwrap();
    assert_eq!(missing.open().unwrap().key_status, "missing");
    assert!(missing.sign("YWJj").is_err());
}
#[test]
fn native_boundary_reads_only_the_closed_n_minus_one_envelope_and_requires_current_writes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("treehouse-v1.sqlite3");
    let mut db = ProductDatabase::open_path("treehouse", &path).unwrap();
    let mut preceding = pending();
    preceding["version"] = json!(0);
    preceding.as_object_mut().unwrap().remove("clearedDrafts");
    db.kv_set(HISTORY_KEY, &preceding.to_string()).unwrap();
    drop(db);
    let mut store =
        PreviewStore::at_directory(dir.path(), Arc::new(InMemoryCarrierKeySeedStore::default()))
            .unwrap();
    assert_eq!(store.open().unwrap().record, Some(preceding.to_string()));
    preceding["revision"] = json!(2);
    assert!(store.commit(1, &preceding.to_string()).is_err());
    let mut current = pending();
    current["revision"] = json!(2);
    assert!(store.commit(1, &current.to_string()).unwrap());
    assert_eq!(store.open().unwrap().record, Some(current.to_string()));
}
#[test]
fn product_future_interrupted_and_corrupt_databases_refuse_before_key_creation() {
    for failure in ["product", "future", "interrupted", "corrupt"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("treehouse-v1.sqlite3");
        if failure == "corrupt" {
            std::fs::write(&path, b"not a database").unwrap();
        } else {
            drop(
                ProductDatabase::open_path(
                    if failure == "product" {
                        "township"
                    } else {
                        "treehouse"
                    },
                    &path,
                )
                .unwrap(),
            );
            let conn = rusqlite::Connection::open(&path).unwrap();
            if failure == "future" {
                conn.execute_batch(
                    "INSERT INTO migration_ledger VALUES(999,'future','applied',0);",
                )
                .unwrap();
            }
            if failure == "interrupted" {
                conn.execute_batch("UPDATE migration_ledger SET state='pending' WHERE version=3;")
                    .unwrap();
            }
        }
        let before = std::fs::read(&path).unwrap();
        assert!(
            PreviewStore::at_directory(
                dir.path(),
                Arc::new(InMemoryCarrierKeySeedStore::default())
            )
            .is_err(),
            "{failure}"
        );
        assert_eq!(std::fs::read(path).unwrap(), before);
    }
}
