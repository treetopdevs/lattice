//! The plan-158 migration matrix as executable contracts:
//! fresh install; current-schema reopen; interrupted-migration rollback;
//! one N-1 -> N upgrade; future-schema refusal; cross-product file refusal;
//! plus the one-time legacy JSON import with the seed boundary.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};

use lattice_mobile_core::{
    LegacyJsonImport, MigrationFault, MigrationLedgerEntry, ProductDatabase, ProductDatabaseError,
    PRODUCT_DATABASE_SCHEMA_VERSION,
};

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "lattice-mobile-core-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn expected_full_ledger() -> Vec<MigrationLedgerEntry> {
    vec![
        MigrationLedgerEntry {
            version: 1,
            name: "initial-kv".to_string(),
            state: "applied".to_string(),
        },
        MigrationLedgerEntry {
            version: 2,
            name: "outbox-frames".to_string(),
            state: "applied".to_string(),
        },
        MigrationLedgerEntry {
            version: 3,
            name: "invalid-kv-quarantine".to_string(),
            state: "applied".to_string(),
        },
    ]
}

fn fabricate_v2_database(path: &Path, product: &str, kv: &[(&str, &str)]) {
    fabricate_v1_database(path, product, kv);
    let conn = rusqlite::Connection::open(path).expect("open fabricated v2 db");
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE frames (
           queue TEXT NOT NULL,
           seq INTEGER NOT NULL,
           frame TEXT NOT NULL,
           PRIMARY KEY (queue, seq)
         );
         INSERT INTO migration_ledger (version, name, state, applied_at_unix_ms)
           VALUES (2, 'outbox-frames', 'applied', 0);
         COMMIT;",
    )
    .expect("fabricate v2 schema");
}

/// Fabricate a valid township database frozen at schema v1 with kv rows —
/// the shape a previous (N-1) build would have left on disk.
fn fabricate_v1_database(path: &Path, product: &str, kv: &[(&str, &str)]) {
    let conn = rusqlite::Connection::open(path).expect("open fabricated db");
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE product_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE migration_ledger (
           version INTEGER PRIMARY KEY,
           name TEXT NOT NULL,
           state TEXT NOT NULL,
           applied_at_unix_ms INTEGER NOT NULL
         );
         CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO migration_ledger (version, name, state, applied_at_unix_ms)
           VALUES (1, 'initial-kv', 'applied', 0);
         COMMIT;",
    )
    .expect("fabricate v1 schema");
    conn.execute(
        "INSERT INTO product_meta (key, value) VALUES ('product', ?1)",
        [product],
    )
    .expect("fabricate product marker");
    for (key, value) in kv {
        conn.execute("INSERT INTO kv (key, value) VALUES (?1, ?2)", [key, value])
            .expect("fabricate kv row");
    }
}

#[test]
fn fresh_install_creates_marked_current_schema_database() {
    let dir = temp_dir("fresh-install");
    let path = dir.join("township-v1.sqlite3");

    let db = ProductDatabase::open_path("township", &path).expect("fresh install opens");

    assert!(
        path.exists(),
        "database file must exist after fresh install"
    );
    assert_eq!(db.product(), "township");
    assert_eq!(
        db.schema_version().expect("schema version"),
        PRODUCT_DATABASE_SCHEMA_VERSION
    );
    assert_eq!(
        db.migration_ledger().expect("ledger"),
        expected_full_ledger()
    );
    assert!(db.kv_entries().expect("kv entries").is_empty());
}

#[test]
fn current_schema_reopen_preserves_state_without_new_migrations() {
    let dir = temp_dir("reopen");
    let path = dir.join("township-v1.sqlite3");

    {
        let db = ProductDatabase::open_path("township", &path).expect("first open");
        db.kv_set("township:matter:local_ops", "[\"op-1\"]")
            .expect("kv set");
    }

    let db = ProductDatabase::open_path("township", &path).expect("reopen");
    assert_eq!(
        db.kv_get("township:matter:local_ops").expect("kv get"),
        Some("[\"op-1\"]".to_string())
    );
    assert_eq!(
        db.schema_version().expect("schema version"),
        PRODUCT_DATABASE_SCHEMA_VERSION
    );
    assert_eq!(
        db.migration_ledger().expect("ledger"),
        expected_full_ledger()
    );
}

#[test]
fn concurrent_first_open_serializes_bootstrap_and_migrations() {
    let dir = temp_dir("concurrent-first-open");
    let path = Arc::new(dir.join("township-v1.sqlite3"));
    let barrier = Arc::new(Barrier::new(9));
    let openers = (0..8)
        .map(|_| {
            let path = Arc::clone(&path);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                let db = ProductDatabase::open_path("township", &path)
                    .expect("concurrent first-open must converge");
                assert_eq!(
                    db.migration_ledger().expect("ledger"),
                    expected_full_ledger()
                );
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    for opener in openers {
        opener.join().expect("join concurrent opener");
    }
}

#[test]
fn a_real_sqlite_write_lock_surfaces_as_database_busy() {
    let dir = temp_dir("database-busy");
    let path = dir.join("township-v1.sqlite3");
    let db = ProductDatabase::open_path("township", &path).expect("open product database");
    let lock_holder = rusqlite::Connection::open(&path).expect("open lock holder");
    lock_holder
        .execute_batch("BEGIN EXCLUSIVE;")
        .expect("hold exclusive write lock");

    assert!(matches!(
        db.kv_set("township:matter:profile", "resident")
            .expect_err("locked write must fail with a typed retryable error"),
        ProductDatabaseError::DatabaseBusy(_)
    ));
    lock_holder
        .execute_batch("ROLLBACK;")
        .expect("release exclusive lock");
}

#[test]
fn zero_table_sqlite_file_resumes_bootstrap() {
    let dir = temp_dir("zero-table-bootstrap");
    let path = dir.join("township-v1.sqlite3");

    // A process can create the SQLite file and die before the bootstrap
    // transaction creates either marker table. That object-free database is
    // still an unambiguous first-install state and must be recoverable.
    rusqlite::Connection::open(&path).expect("create empty SQLite file");
    assert!(path.exists(), "the recovery fixture must predate open_path");
    assert_eq!(
        fs::metadata(&path).expect("empty SQLite metadata").len(),
        0,
        "this case must exercise an aborted zero-byte SQLite create"
    );

    let db = ProductDatabase::open_path("township", &path)
        .expect("an object-free SQLite file must resume product bootstrap");

    assert_eq!(db.product(), "township");
    assert_eq!(
        db.schema_version().expect("schema version"),
        PRODUCT_DATABASE_SCHEMA_VERSION
    );
    assert_eq!(
        db.migration_ledger().expect("ledger"),
        expected_full_ledger()
    );
    assert!(db.kv_entries().expect("empty entries").is_empty());

    drop(db);
    let reopened =
        ProductDatabase::open_path("township", &path).expect("reopen recovered product database");
    assert_eq!(
        reopened.migration_ledger().expect("reopened ledger"),
        expected_full_ledger()
    );
    assert!(reopened.kv_entries().expect("reopened entries").is_empty());
}

#[test]
fn header_bearing_object_free_sqlite_file_resumes_bootstrap() {
    let dir = temp_dir("header-only-bootstrap");
    let path = dir.join("township-v1.sqlite3");
    {
        let conn = rusqlite::Connection::open(&path).expect("create SQLite file");
        conn.execute_batch("CREATE TABLE crash_residue (x TEXT); DROP TABLE crash_residue;")
            .expect("leave a valid SQLite header without user objects");
        let object_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| row.get(0))
            .expect("count SQLite objects");
        assert_eq!(object_count, 0, "fixture must be object-free");
    }
    assert!(
        fs::metadata(&path).expect("header SQLite metadata").len() > 0,
        "this case must not collapse to the zero-byte recovery shape"
    );

    let db = ProductDatabase::open_path("township", &path)
        .expect("a header-bearing object-free SQLite file must resume product bootstrap");
    assert_eq!(db.product(), "township");
    assert_eq!(
        db.migration_ledger().expect("ledger"),
        expected_full_ledger()
    );
    assert!(db.kv_entries().expect("entries").is_empty());
}

#[test]
fn product_marker_mismatch_fails_closed() {
    let dir = temp_dir("marker-mismatch");
    let path = dir.join("township-v1.sqlite3");

    {
        let db = ProductDatabase::open_path("township", &path).expect("township creates");
        db.kv_set("township:matter:profile", "resident")
            .expect("kv set");
    }

    let refusal = ProductDatabase::open_path("toolshed", &path);
    assert_eq!(
        refusal.err(),
        Some(ProductDatabaseError::ProductMarkerMismatch {
            expected: "toolshed".to_string(),
            found: "township".to_string(),
        }),
        "a toolshed shell must refuse to open the township database"
    );

    let db = ProductDatabase::open_path("township", &path).expect("township still opens");
    assert_eq!(
        db.kv_get("township:matter:profile").expect("kv get"),
        Some("resident".to_string()),
        "the refused cross-product open must not alter the database"
    );
}

#[test]
fn future_schema_fails_closed() {
    let dir = temp_dir("future-schema");
    let path = dir.join("township-v1.sqlite3");

    fabricate_v1_database(&path, "township", &[("k", "v")]);
    {
        let conn = rusqlite::Connection::open(&path).expect("raw open");
        conn.execute(
            "INSERT INTO migration_ledger (version, name, state, applied_at_unix_ms)
               VALUES (99, 'from-the-future', 'applied', 0)",
            [],
        )
        .expect("insert future ledger row");
    }

    let refusal = ProductDatabase::open_path("township", &path);
    assert_eq!(
        refusal.err(),
        Some(ProductDatabaseError::FutureSchema {
            found: 99,
            supported: PRODUCT_DATABASE_SCHEMA_VERSION,
        }),
        "an older build must refuse a database created by a newer build"
    );
}

#[test]
fn interrupted_migration_rolls_back_and_fails_closed() {
    let dir = temp_dir("interrupted");
    let path = dir.join("township-v1.sqlite3");

    fabricate_v1_database(&path, "township", &[("kept", "value")]);

    let interrupted =
        ProductDatabase::open_path_with_fault("township", &path, MigrationFault::FailAfterApply(2));
    assert!(
        interrupted.is_err(),
        "the injected migration interruption must surface as an error"
    );

    {
        let conn = rusqlite::Connection::open(&path).expect("raw open");
        let frames_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'frames'",
                [],
                |row| row.get(0),
            )
            .expect("query sqlite_master");
        assert_eq!(
            frames_table, 0,
            "the interrupted migration body must roll back"
        );
        let kept: String = conn
            .query_row("SELECT value FROM kv WHERE key = 'kept'", [], |row| {
                row.get(0)
            })
            .expect("kv row survives rollback");
        assert_eq!(kept, "value");
    }

    let refusal = ProductDatabase::open_path("township", &path);
    assert_eq!(
        refusal.err(),
        Some(ProductDatabaseError::InterruptedMigration { version: 2 }),
        "a database with an interrupted migration must fail closed on reopen"
    );
}

#[test]
fn n_minus_1_to_n_upgrade_preserves_state_and_extends_ledger() {
    let dir = temp_dir("upgrade");
    let path = dir.join("township-v1.sqlite3");

    fabricate_v2_database(
        &path,
        "township",
        &[
            ("township:matter:local_ops", "[\"op-1\",\"op-2\"]"),
            ("township:matter:carrier_frames", "[]"),
        ],
    );

    let db = ProductDatabase::open_path("township", &path).expect("upgrade opens");
    assert_eq!(
        db.schema_version().expect("schema version"),
        PRODUCT_DATABASE_SCHEMA_VERSION
    );
    assert_eq!(
        db.migration_ledger().expect("ledger"),
        expected_full_ledger()
    );
    assert_eq!(
        db.kv_get("township:matter:local_ops").expect("kv get"),
        Some("[\"op-1\",\"op-2\"]".to_string()),
        "upgrade must preserve existing state"
    );

    let conn = rusqlite::Connection::open(&path).expect("raw open");
    let frames_table: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'frames'",
            [],
            |row| row.get(0),
        )
        .expect("query sqlite_master");
    assert_eq!(
        frames_table, 1,
        "the N-1 database must retain its frames table"
    );
}

#[test]
fn foreign_file_is_refused_not_recreated() {
    let dir = temp_dir("foreign-file");
    let path = dir.join("township-v1.sqlite3");
    fs::write(&path, b"this is not a sqlite database").expect("write foreign file");

    let refusal = ProductDatabase::open_path("township", &path);
    assert!(
        matches!(
            refusal.err(),
            Some(ProductDatabaseError::NotAProductDatabase(_)) | Some(ProductDatabaseError::Sql(_))
        ),
        "a foreign file must refuse, never silently recreate"
    );
    assert_eq!(
        fs::read(&path).expect("reread foreign file"),
        b"this is not a sqlite database".to_vec(),
        "the refused open must not clobber the foreign file"
    );
}

#[test]
fn cleanly_closed_sqlite_without_product_marker_is_refused_without_mutation() {
    let dir = temp_dir("unmarked-sqlite");
    let path = dir.join("township-v1.sqlite3");
    {
        let conn = rusqlite::Connection::open(&path).expect("raw create");
        conn.execute_batch(
            "CREATE TABLE unrelated (x TEXT);
             INSERT INTO unrelated (x) VALUES ('foreign-sentinel');",
        )
        .expect("create unrelated table");
    }

    let bytes_before = fs::read(&path).expect("read foreign SQLite before refusal");
    let directory_before = fs::read_dir(&dir)
        .expect("list foreign directory before refusal")
        .map(|entry| entry.expect("foreign directory entry").file_name())
        .collect::<BTreeSet<_>>();

    let refusal = ProductDatabase::open_path("township", &path);
    assert!(
        matches!(
            refusal.err(),
            Some(ProductDatabaseError::NotAProductDatabase(_))
        ),
        "an unmarked SQLite file must refuse, never adopt"
    );
    assert_eq!(
        fs::read(&path).expect("read foreign SQLite after refusal"),
        bytes_before,
        "refusing this cleanly closed foreign SQLite fixture must not mutate it"
    );
    let directory_after = fs::read_dir(&dir)
        .expect("list foreign directory after refusal")
        .map(|entry| entry.expect("foreign directory entry").file_name())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        directory_after, directory_before,
        "refusal must not leave journal, WAL, or shared-memory sidecars"
    );

    let conn = rusqlite::Connection::open(&path).expect("reopen foreign SQLite");
    let sentinel: String = conn
        .query_row("SELECT x FROM unrelated", [], |row| row.get(0))
        .expect("foreign sentinel survives refusal");
    assert_eq!(sentinel, "foreign-sentinel");

    let product_tables: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name IN ('product_meta', 'migration_ledger')",
            [],
            |row| row.get(0),
        )
        .expect("query product tables");
    assert_eq!(
        product_tables, 0,
        "refusal must not adopt the foreign database by adding product metadata"
    );
}

#[test]
fn runtime_kv_set_refuses_secret_shaped_keys_without_persisting_them() {
    let dir = temp_dir("runtime-secret-refusal");
    let path = dir.join("township-v1.sqlite3");
    let db = ProductDatabase::open_path("township", &path).expect("open product database");

    db.kv_set("township:matter:profile", "resident")
        .expect("ordinary replayable state remains writable");
    let public_id = format!("abc-Seed-{}", "x".repeat(34));
    assert_eq!(public_id.len(), 43, "fixture is an unpadded sha256 id");
    db.kv_set(
        &format!("township:matter:township:witness-artifact:v1:{public_id}"),
        "public-artifact",
    )
    .expect("hash-derived fields must not match secret tokens by content");

    let secret_keys = [
        "township:matter:carrier_seed",
        "township:matter:PRIVATE_material",
        "township:matter:secret_material",
        "township:matter:mnemonic_words",
        "township:matter:pkcs8_bytes",
        "township:matter:signing_key_bytes",
        "township:matter:signing-key-bytes",
        "township:matter:carrierSeed",
        "township:matter:signingKey",
        "township:matter:privateKey",
        "township:matter:secretKey",
        "township:matter:seedPhrase",
        "township:matter:mnemonicPhrase",
        "township:matter:pkcs8Bytes",
        "township:matter:carrierSeedV1",
        "township:matter:carrier.seed",
        "township:matter:carrier_seed:",
        "township:matter:carrier_seed:v1",
        "pkcs8_bytes:backup",
        "pkcs8_bytes:backup:",
        "township:carrier_seed:",
        "carrier_seed::",
        "township:carrier_seed:v1",
        "pkcs8_bytes:backup:v1",
        "carrier_seed::v1",
    ];

    for key in secret_keys {
        let error = match db.kv_set(key, "must-not-land") {
            Ok(()) => panic!("secret-shaped runtime write must refuse: {key}"),
            Err(error) => error,
        };
        assert_eq!(
            error.to_string(),
            format!("storage key contains non-replayable secret material at {key}"),
            "runtime refusal must be the typed secret-material policy, not an incidental SQL error"
        );
        assert_eq!(
            db.kv_get(key)
                .expect("read secret-shaped key after refusal"),
            None,
            "runtime refusal must not partially persist {key}"
        );
    }
    assert_eq!(
        db.kv_get("township:matter:profile")
            .expect("read ordinary key"),
        Some("resident".to_string()),
        "refusing secret material must not disturb ordinary replayable state"
    );
}

#[test]
fn runtime_kv_set_refuses_an_explicit_cross_product_key_prefix() {
    let dir = temp_dir("runtime-cross-product-key");
    let path = dir.join("township-v1.sqlite3");
    let db = ProductDatabase::open_path("township", &path).expect("open product database");
    for key in ["toolshed:shed:profile", "TOOLSHED:shed:profile"] {
        assert_eq!(
            db.kv_set(key, "must-not-land")
                .expect_err("cross-product key prefix must refuse"),
            ProductDatabaseError::ProductKeyMismatch {
                expected: "township".to_string(),
                found: "toolshed".to_string(),
            }
        );
        assert_eq!(db.kv_get(key).expect("read refused key"), None);
    }
}

#[test]
fn legacy_import_quarantines_cross_product_state_without_bricking_startup() {
    let dir = temp_dir("legacy-cross-product-key");
    let path = dir.join("township-v1.sqlite3");
    let legacy_path = dir.join("township-native-kv.json");
    fs::write(&legacy_path, r#"{"toolshed:shed:profile":"wrong-product"}"#)
        .expect("write cross-product legacy state");
    let mut db = ProductDatabase::open_path("township", &path).expect("open product database");

    assert_eq!(
        db.import_legacy_json_values(&legacy_path)
            .expect("cross-product legacy key must be quarantined"),
        LegacyJsonImport::Recovered {
            entries: 0,
            purged_secret_keys: Vec::new(),
            retained_secret_keys: Vec::new(),
            quarantined_cross_product_keys: vec!["toolshed:shed:profile".to_string()],
            skipped_non_string_keys: Vec::new(),
            legacy_cleanup_error: None,
        }
    );
    assert!(db.kv_entries().expect("entries").is_empty());
    assert_eq!(
        db.quarantined_kv_get("toolshed:shed:profile")
            .expect("quarantine read"),
        Some("wrong-product".to_string())
    );
    assert_eq!(
        fs::read_to_string(&legacy_path).expect("read sanitized cross-product legacy file"),
        "{}"
    );
}

#[test]
fn existing_sqlite_secret_rows_are_explicitly_purgeable_after_upgrade() {
    let dir = temp_dir("existing-secret-row");
    let path = dir.join("township-v1.sqlite3");
    ProductDatabase::open_path("township", &path).expect("create product database");
    let conn = rusqlite::Connection::open(&path).expect("open raw prior-build database");
    conn.execute(
        "INSERT INTO kv (key, value) VALUES (?1, ?2)",
        ["toolshed:carrier_seed", "must-not-load"],
    )
    .expect("fabricate row written by a pre-guard build");
    conn.execute(
        "INSERT INTO kv (key, value) VALUES (?1, ?2)",
        ["township:matter:profile", "resident"],
    )
    .expect("fabricate ordinary prior-build row");
    drop(conn);

    let mut db = ProductDatabase::open_path("township", &path).expect("reopen product database");
    assert_eq!(
        db.kv_entries()
            .expect_err("secret-shaped prior row must refuse enumeration"),
        ProductDatabaseError::NonReplayableStorageKey("toolshed:carrier_seed".to_string())
    );
    assert_eq!(
        db.recover_invalid_entries()
            .expect("recover prior non-replayable row")
            .purged_secret_keys,
        vec!["toolshed:carrier_seed".to_string()]
    );
    assert_eq!(
        db.kv_entries().expect("enumerate repaired database"),
        HashMap::from([(
            "township:matter:profile".to_string(),
            "resident".to_string()
        )])
    );
    assert_eq!(
        db.quarantined_kv_get("toolshed:carrier_seed")
            .expect("secret quarantine probe"),
        None,
        "secret-shaped cross-product rows must be purged, never value-preserved"
    );
}

#[test]
fn recovery_quarantines_cross_product_rows_outside_active_state() {
    let dir = temp_dir("cross-product-row-purge");
    let path = dir.join("township-v1.sqlite3");
    ProductDatabase::open_path("township", &path).expect("create product database");
    let conn = rusqlite::Connection::open(&path).expect("open raw database");
    conn.execute(
        "INSERT INTO kv (key, value) VALUES (?1, ?2)",
        ["toolshed:shed:profile", "wrong-product"],
    )
    .expect("fabricate cross-product row");
    drop(conn);
    let mut db = ProductDatabase::open_path("township", &path).expect("reopen product database");

    let recovery = db
        .recover_invalid_entries()
        .expect("cross-product contamination must be recoverable");
    assert_eq!(
        recovery.quarantined_cross_product_keys,
        vec!["toolshed:shed:profile".to_string()]
    );
    assert_eq!(
        db.kv_get("toolshed:shed:profile")
            .expect("cross-product row leaves active state"),
        None
    );
    assert_eq!(
        db.quarantined_kv_get("toolshed:shed:profile")
            .expect("cross-product row remains available for diagnosis"),
        Some("wrong-product".to_string())
    );
}

#[test]
fn runtime_kv_batch_refusal_is_atomic_and_repairable() {
    let dir = temp_dir("runtime-secret-batch-refusal");
    let path = dir.join("township-v1.sqlite3");
    let mut db = ProductDatabase::open_path("township", &path).expect("open product database");
    let ordinary_key = "township:matter:profile".to_string();
    let secret_key = "township:matter:private_material".to_string();
    let mut entries = HashMap::from([
        (ordinary_key.clone(), "resident".to_string()),
        (secret_key.clone(), "must-not-land".to_string()),
    ]);

    assert_eq!(
        db.kv_set_batch(&entries)
            .expect_err("mixed batch must refuse"),
        ProductDatabaseError::NonReplayableStorageKey(secret_key.clone())
    );
    assert_eq!(db.kv_get(&ordinary_key).expect("ordinary read"), None);
    assert_eq!(db.kv_get(&secret_key).expect("secret read"), None);

    entries.remove(&secret_key);
    db.kv_set_batch(&entries).expect("repaired batch succeeds");
    assert_eq!(
        db.kv_get(&ordinary_key).expect("repaired ordinary read"),
        Some("resident".to_string())
    );
}

#[test]
fn legacy_json_state_imports_exactly_once() {
    let dir = temp_dir("legacy-import");
    let path = dir.join("township-v1.sqlite3");
    let legacy_path = dir.join("township-native-kv.json");
    fs::write(
        &legacy_path,
        r#"{"township:matter:local_ops":"[\"op-1\"]","township:matter:carrier_peer_config":"{\"url\":\"wss://example\"}"}"#,
    )
    .expect("write legacy json");

    {
        let mut db = ProductDatabase::open_path("township", &path).expect("fresh open");
        let import = db
            .import_legacy_json_values(&legacy_path)
            .expect("first import succeeds");
        assert_eq!(import, LegacyJsonImport::Imported { entries: 2 });
        assert_eq!(
            db.kv_get("township:matter:local_ops").expect("kv get"),
            Some("[\"op-1\"]".to_string())
        );

        let repeat = db
            .import_legacy_json_values(&legacy_path)
            .expect("repeat import succeeds");
        assert_eq!(repeat, LegacyJsonImport::AlreadyDecided);
    }

    fs::write(
        &legacy_path,
        r#"{"township:matter:local_ops":"[\"tampered\"]"}"#,
    )
    .expect("tamper legacy json");

    let mut db = ProductDatabase::open_path("township", &path).expect("reopen");
    let repeat = db
        .import_legacy_json_values(&legacy_path)
        .expect("post-reopen import call succeeds");
    assert_eq!(
        repeat,
        LegacyJsonImport::AlreadyDecided,
        "a reopened database must not re-import legacy state"
    );
    assert_eq!(
        db.kv_get("township:matter:local_ops").expect("kv get"),
        Some("[\"op-1\"]".to_string()),
        "a tampered legacy file must not clobber migrated state"
    );
}

#[test]
fn missing_legacy_state_is_recorded_so_a_later_file_cannot_clobber() {
    let dir = temp_dir("legacy-none");
    let path = dir.join("township-v1.sqlite3");
    let legacy_path = dir.join("township-native-kv.json");

    {
        let mut db = ProductDatabase::open_path("township", &path).expect("fresh open");
        let import = db
            .import_legacy_json_values(&legacy_path)
            .expect("import with no legacy file succeeds");
        assert_eq!(import, LegacyJsonImport::NoLegacyState);
    }

    fs::write(&legacy_path, r#"{"late":"arrival"}"#).expect("write late legacy json");

    let mut db = ProductDatabase::open_path("township", &path).expect("reopen");
    let import = db
        .import_legacy_json_values(&legacy_path)
        .expect("import call succeeds");
    assert_eq!(
        import,
        LegacyJsonImport::AlreadyDecided,
        "a legacy file appearing after first decision must be ignored"
    );
    assert_eq!(db.kv_get("late").expect("kv get"), None);
}

#[test]
fn concurrent_legacy_import_decision_is_serialized() {
    let dir = temp_dir("concurrent-legacy-decision");
    let path = dir.join("township-v1.sqlite3");
    let legacy_path = Arc::new(dir.join("township-native-kv.json"));
    let databases = [
        ProductDatabase::open_path("township", &path).expect("open first database"),
        ProductDatabase::open_path("township", &path).expect("open second database"),
    ];
    let barrier = Arc::new(Barrier::new(3));
    let importers = databases.map(|mut db| {
        let barrier = Arc::clone(&barrier);
        let legacy_path = Arc::clone(&legacy_path);
        std::thread::spawn(move || {
            barrier.wait();
            db.import_legacy_json_values(&legacy_path)
                .expect("concurrent import decision must converge")
        })
    });
    barrier.wait();
    let outcomes = importers.map(|importer| importer.join().expect("join importer"));
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, LegacyJsonImport::NoLegacyState))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, LegacyJsonImport::AlreadyDecided))
            .count(),
        1
    );
}

#[test]
fn legacy_import_purges_secret_material_and_records_the_decision() {
    let dir = temp_dir("legacy-secret");
    let path = dir.join("township-v1.sqlite3");
    let legacy_path = dir.join("township-native-kv.json");
    fs::write(
        &legacy_path,
        r#"{"toolshed:carrier_seed":"c2VjcmV0","township:matter:profile":"resident","retries":1}"#,
    )
    .expect("write secret legacy json");

    let mut db = ProductDatabase::open_path("township", &path).expect("fresh open");
    assert_eq!(
        db.import_legacy_json_values(&legacy_path)
            .expect("secret-shaped legacy entries must be recoverable"),
        LegacyJsonImport::Recovered {
            entries: 1,
            purged_secret_keys: vec!["toolshed:carrier_seed".to_string()],
            retained_secret_keys: Vec::new(),
            quarantined_cross_product_keys: Vec::new(),
            skipped_non_string_keys: vec!["retries".to_string()],
            legacy_cleanup_error: None,
        }
    );
    assert_eq!(
        db.kv_get("toolshed:carrier_seed").expect("secret key read"),
        None,
        "a secret-shaped cross-product key must be purged, never quarantined"
    );
    assert_eq!(
        db.kv_get("township:matter:profile").expect("kv get"),
        Some("resident".to_string())
    );
    let repaired_legacy = fs::read_to_string(&legacy_path).expect("read repaired legacy file");
    assert!(!repaired_legacy.contains("toolshed:carrier_seed"));
    assert!(!repaired_legacy.contains("c2VjcmV0"));
    let repaired_value: serde_json::Value =
        serde_json::from_str(&repaired_legacy).expect("decode repaired legacy file");
    assert_eq!(repaired_value["retries"], 1);

    fs::write(
        &legacy_path,
        r#"{"township:matter:profile":"tampered","toolshed:carrier_seed":"residue-after-crash","retries":1}"#,
    )
    .expect("restore simulated post-decision secret residue");
    assert_eq!(
        db.import_legacy_json_values(&legacy_path)
            .expect("decided import must retry secret cleanup"),
        LegacyJsonImport::Recovered {
            entries: 0,
            purged_secret_keys: vec!["toolshed:carrier_seed".to_string()],
            retained_secret_keys: Vec::new(),
            quarantined_cross_product_keys: Vec::new(),
            skipped_non_string_keys: Vec::new(),
            legacy_cleanup_error: None,
        }
    );
    let retried_legacy = fs::read_to_string(&legacy_path).expect("read retried legacy cleanup");
    assert!(!retried_legacy.contains("toolshed:carrier_seed"));
    assert!(!retried_legacy.contains("residue-after-crash"));
    let retried_value: serde_json::Value =
        serde_json::from_str(&retried_legacy).expect("decode retried legacy cleanup");
    assert_eq!(retried_value["retries"], 1);
    assert_eq!(
        db.import_legacy_json_values(&legacy_path)
            .expect("repeat import succeeds"),
        LegacyJsonImport::AlreadyDecided
    );

    fs::write(&legacy_path, r#"{"toolshed:carrier_seed":"truncated""#)
        .expect("write undecodable decided residue");
    let undecodable = db
        .import_legacy_json_values(&legacy_path)
        .expect("undecodable decided residue must be reported without bricking startup");
    assert!(matches!(
        undecodable,
        LegacyJsonImport::Recovered {
            legacy_cleanup_error: Some(_),
            ..
        }
    ));
}
