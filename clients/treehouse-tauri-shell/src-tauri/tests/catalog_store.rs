#[path = "../src/catalog_store.rs"]
mod catalog_store;
use catalog_store::*;
use lattice_mobile_core::ProductDatabase;

fn token(trust_revision: u64, history_generation: u64) -> StoreToken {
    StoreToken {
        trust_revision,
        history_generation,
    }
}
#[test]
fn whole_record_cas_rejects_stale_writer_even_when_counters_are_identical() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("candidate.sqlite3");
    let mut a = ProductDatabase::open_path("treehouse", &path).unwrap();
    let mut b = ProductDatabase::open_path("treehouse", &path).unwrap();
    let missing = load_candidate(&a, NativeIdentityPresence::Absent).unwrap();
    let initial = store_candidate(
        &mut a,
        &missing,
        NativeIdentityPresence::Absent,
        token(7, 11),
        b"first",
    )
    .unwrap();
    let stale = load_candidate(&b, NativeIdentityPresence::Present).unwrap();
    let winner = store_candidate(
        &mut a,
        &initial,
        NativeIdentityPresence::Present,
        token(7, 11),
        b"second",
    )
    .unwrap();
    assert_eq!(
        store_candidate(
            &mut b,
            &stale,
            NativeIdentityPresence::Present,
            token(8, 12),
            b"lost"
        ),
        Err("stale_trust_snapshot")
    );
    assert_eq!(
        load_candidate(&a, NativeIdentityPresence::Present).unwrap(),
        winner
    );
}

#[test]
fn owned_bytes_and_both_supplied_counters_survive_identical_replay_and_process_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("candidate.sqlite3");
    let mut db = ProductDatabase::open_path("treehouse", &path).unwrap();
    let empty = load_candidate(&db, NativeIdentityPresence::Absent).unwrap();
    let bytes = b"  { \"untrustedCandidate\": true }\n";
    let saved = store_candidate(
        &mut db,
        &empty,
        NativeIdentityPresence::Absent,
        token(5, 19),
        bytes,
    )
    .unwrap();
    let replay = store_candidate(
        &mut db,
        &saved,
        NativeIdentityPresence::Present,
        token(5, 19),
        bytes,
    )
    .unwrap();
    assert_eq!(saved, replay);
    assert_eq!(replay.snapshot_bytes(), bytes);
    assert_eq!(replay.token(), token(5, 19));
    drop(db);
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "candidate_reopen_child", "--nocapture"])
        .env("TREEHOUSE_CANDIDATE_TEST_PATH", &path)
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn candidate_reopen_child() {
    let Some(path) = std::env::var_os("TREEHOUSE_CANDIDATE_TEST_PATH") else {
        return;
    };
    let db = ProductDatabase::open_path("treehouse", std::path::Path::new(&path)).unwrap();
    let saved = load_candidate(&db, NativeIdentityPresence::Present).unwrap();
    assert_eq!(
        saved.snapshot_bytes(),
        b"  { \"untrustedCandidate\": true }\n"
    );
    assert_eq!(saved.token(), token(5, 19));
}

#[test]
fn existing_identity_never_supplies_a_fresh_bootstrap_or_repairs_missing_trust() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = ProductDatabase::open_path("treehouse", &dir.path().join("db")).unwrap();
    let empty = load_candidate(&db, NativeIdentityPresence::Absent).unwrap();
    assert_eq!(
        load_candidate(&db, NativeIdentityPresence::Present),
        Err("trust_recovery_required")
    );
    assert_eq!(
        store_candidate(
            &mut db,
            &empty,
            NativeIdentityPresence::Present,
            token(0, 0),
            b"candidate"
        ),
        Err("trust_recovery_required")
    );
    assert!(db.kv_get(CANDIDATE_KEY).unwrap().is_none());
}

#[test]
fn corrupt_closed_records_refuse_without_replacement_or_truncation() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = ProductDatabase::open_path("treehouse", &dir.path().join("db")).unwrap();
    let empty = load_candidate(&db, NativeIdentityPresence::Absent).unwrap();
    store_candidate(
        &mut db,
        &empty,
        NativeIdentityPresence::Absent,
        token(1, 2),
        b"candidate",
    )
    .unwrap();
    let valid = db.kv_get(CANDIDATE_KEY).unwrap().unwrap();
    let object: serde_json::Value = serde_json::from_str(&valid).unwrap();
    let mut corruptions = vec![
        "null".to_string(),
        "{}".to_string(),
        format!("{{\"version\":1,{}", &valid[1..]),
        valid.replace("\"version\":1", "\"version\":1,\"ver\\u0073ion\":1"),
    ];
    for (key, value) in [
        ("extra", serde_json::json!(true)),
        ("version", serde_json::json!(2)),
        ("snapshot", serde_json::json!("Y2FuZGlkYXRl=")),
        ("contentDigest", serde_json::json!("forged")),
        (
            "token",
            serde_json::json!({"trustRevision":1.0,"historyGeneration":2}),
        ),
        (
            "token",
            serde_json::json!({"trustRevision":1,"historyGeneration":9007199254740991_u64}),
        ),
        (
            "token",
            serde_json::json!({"trustRevision":1,"historyGeneration":2,"extra":0}),
        ),
    ] {
        let mut next = object.clone();
        next[key] = value;
        corruptions.push(next.to_string());
    }
    for raw in corruptions {
        db.kv_set(CANDIDATE_KEY, &raw).unwrap();
        for presence in [
            NativeIdentityPresence::Present,
            NativeIdentityPresence::Absent,
        ] {
            assert_eq!(
                load_candidate(&db, presence),
                Err("trust_recovery_required"),
                "{raw}"
            );
        }
        assert_eq!(db.kv_get(CANDIDATE_KEY).unwrap().unwrap(), raw);
    }
}

#[test]
fn failed_transaction_retains_snapshot_digest_and_both_counters_together() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db");
    let mut db = ProductDatabase::open_path("treehouse", &path).unwrap();
    let empty = load_candidate(&db, NativeIdentityPresence::Absent).unwrap();
    let first = store_candidate(
        &mut db,
        &empty,
        NativeIdentityPresence::Absent,
        token(3, 9),
        b"first",
    )
    .unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_update BEFORE UPDATE ON kv BEGIN SELECT RAISE(ABORT, 'refused'); END;").unwrap();
    assert_eq!(
        store_candidate(
            &mut db,
            &first,
            NativeIdentityPresence::Present,
            token(4, 11),
            b"second"
        ),
        Err("trust_persistence_failed")
    );
    assert_eq!(
        load_candidate(&db, NativeIdentityPresence::Present).unwrap(),
        first
    );
}

#[test]
fn malformed_candidate_never_writes_and_stale_identical_replay_never_restores_old_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = ProductDatabase::open_path("treehouse", &dir.path().join("db")).unwrap();
    let empty = load_candidate(&db, NativeIdentityPresence::Absent).unwrap();
    for (counter, bytes) in [
        (token(0, 0), b"".as_slice()),
        (token(u64::MAX, 0), b"x".as_slice()),
    ] {
        assert_eq!(
            store_candidate(
                &mut db,
                &empty,
                NativeIdentityPresence::Absent,
                counter,
                bytes
            ),
            Err("malformed_catalog")
        );
    }
    let first = store_candidate(
        &mut db,
        &empty,
        NativeIdentityPresence::Absent,
        token(4, 2),
        b"first",
    )
    .unwrap();
    let next = store_candidate(
        &mut db,
        &first,
        NativeIdentityPresence::Present,
        token(4, 3),
        b"next",
    )
    .unwrap();
    assert_eq!(
        store_candidate(
            &mut db,
            &first,
            NativeIdentityPresence::Present,
            token(4, 2),
            b"first"
        ),
        Err("stale_trust_snapshot")
    );
    assert_eq!(
        load_candidate(&db, NativeIdentityPresence::Present).unwrap(),
        next
    );
}
