use lattice_mobile_core::{ProductDatabase, ProductDatabaseError};

#[test]
fn a_stale_independent_handle_cannot_drop_retained_history() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("treehouse-v1.sqlite3");
    let mut first = ProductDatabase::open_path("treehouse", &path).unwrap();
    let mut second = ProductDatabase::open_path("treehouse", &path).unwrap();
    let key = "treehouse:preview:history";
    assert!(first.kv_compare_and_set(key, None, "genesis").unwrap());
    let old = second.kv_get(key).unwrap().unwrap();
    assert!(first
        .kv_compare_and_set(key, Some(&old), "genesis,post-A")
        .unwrap());
    assert!(!second
        .kv_compare_and_set(key, Some(&old), "genesis,post-B")
        .unwrap());
    assert_eq!(
        second.kv_get(key).unwrap().as_deref(),
        Some("genesis,post-A")
    );
    assert!(!second.kv_compare_and_set(key, None, "replacement").unwrap());
    assert!(second
        .kv_compare_and_set(key, Some("genesis,post-A"), "genesis,post-A,post-B")
        .unwrap());
    drop(first);
    drop(second);
    let reopened = ProductDatabase::open_path("treehouse", &path).unwrap();
    assert_eq!(
        reopened.kv_get(key).unwrap().as_deref(),
        Some("genesis,post-A,post-B")
    );
}

#[test]
fn rejected_keys_and_failed_writes_preserve_the_original_value() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("treehouse-v1.sqlite3");
    let mut db = ProductDatabase::open_path("treehouse", &path).unwrap();
    assert!(matches!(
        db.kv_compare_and_set("township:history", None, "x"),
        Err(ProductDatabaseError::ProductKeyMismatch { .. })
    ));
    assert!(matches!(
        db.kv_compare_and_set("treehouse:private_seed", None, "x"),
        Err(ProductDatabaseError::NonReplayableStorageKey(_))
    ));
    assert!(db
        .kv_compare_and_set("treehouse:history", None, "original")
        .unwrap());
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_update BEFORE UPDATE ON kv BEGIN SELECT RAISE(ABORT, 'write refused'); END;").unwrap();
    assert!(db
        .kv_compare_and_set("treehouse:history", Some("original"), "replacement")
        .is_err());
    assert_eq!(
        db.kv_get("treehouse:history").unwrap().as_deref(),
        Some("original")
    );
}
