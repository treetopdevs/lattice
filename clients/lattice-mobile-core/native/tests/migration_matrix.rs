//! The plan-158 migration matrix as executable contracts:
//! fresh install; current-schema reopen; interrupted-migration rollback;
//! one N-1 -> N upgrade; future-schema refusal; cross-product file refusal;
//! plus the one-time legacy JSON import with the seed boundary.

use std::fs;
use std::path::{Path, PathBuf};

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
    ]
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

    assert!(path.exists(), "database file must exist after fresh install");
    assert_eq!(db.product(), "township");
    assert_eq!(
        db.schema_version().expect("schema version"),
        PRODUCT_DATABASE_SCHEMA_VERSION
    );
    assert_eq!(db.migration_ledger().expect("ledger"), expected_full_ledger());
    assert!(db.kv_entries().expect("kv entries").is_empty());
}

#[test]
fn current_schema_reopen_preserves_state_without_new_migrations() {
    let dir = temp_dir("reopen");
    let path = dir.join("township-v1.sqlite3");

    {
        let db = ProductDatabase::open_path("township", &path).expect("first open");
        db.kv_set("township:matter:local_ops", "[\"op-1\"]").expect("kv set");
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
    assert_eq!(db.migration_ledger().expect("ledger"), expected_full_ledger());
}

#[test]
fn product_marker_mismatch_fails_closed() {
    let dir = temp_dir("marker-mismatch");
    let path = dir.join("township-v1.sqlite3");

    {
        let db = ProductDatabase::open_path("township", &path).expect("township creates");
        db.kv_set("township:matter:profile", "resident").expect("kv set");
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
            .query_row("SELECT value FROM kv WHERE key = 'kept'", [], |row| row.get(0))
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

    fabricate_v1_database(
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
    assert_eq!(db.migration_ledger().expect("ledger"), expected_full_ledger());
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
    assert_eq!(frames_table, 1, "the v2 migration must create the frames table");
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
fn sqlite_file_without_product_marker_is_refused() {
    let dir = temp_dir("unmarked-sqlite");
    let path = dir.join("township-v1.sqlite3");
    {
        let conn = rusqlite::Connection::open(&path).expect("raw create");
        conn.execute_batch("CREATE TABLE unrelated (x TEXT);")
            .expect("create unrelated table");
    }

    let refusal = ProductDatabase::open_path("township", &path);
    assert!(
        matches!(
            refusal.err(),
            Some(ProductDatabaseError::NotAProductDatabase(_))
        ),
        "an unmarked SQLite file must refuse, never adopt"
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
fn legacy_import_refuses_secret_material_and_stays_undecided() {
    let dir = temp_dir("legacy-secret");
    let path = dir.join("township-v1.sqlite3");
    let legacy_path = dir.join("township-native-kv.json");
    fs::write(
        &legacy_path,
        r#"{"township:matter:carrier_seed":"c2VjcmV0","township:matter:profile":"resident"}"#,
    )
    .expect("write secret legacy json");

    let mut db = ProductDatabase::open_path("township", &path).expect("fresh open");
    let refusal = db.import_legacy_json_values(&legacy_path);
    assert!(
        matches!(
            refusal.err(),
            Some(ProductDatabaseError::LegacyImportContainsSecret(_))
        ),
        "seed-shaped legacy entries must refuse the import"
    );
    assert!(
        db.kv_entries().expect("kv entries").is_empty(),
        "a refused import must not partially apply"
    );

    fs::write(&legacy_path, r#"{"township:matter:profile":"resident"}"#)
        .expect("write repaired legacy json");
    let import = db
        .import_legacy_json_values(&legacy_path)
        .expect("repaired import succeeds");
    assert_eq!(import, LegacyJsonImport::Imported { entries: 1 });
    assert_eq!(
        db.kv_get("township:matter:profile").expect("kv get"),
        Some("resident".to_string())
    );
}
