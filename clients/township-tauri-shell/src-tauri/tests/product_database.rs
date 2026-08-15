//! Township shell integration with the shared per-product SQLite storage
//! (plan 158 "Product Isolation and Migrations").
//!
//! The shell must open `township-v1.sqlite3` with the township product
//! marker, migrate the legacy `township-native-kv.json` state exactly once,
//! write kv state through the transactional store, and refuse another
//! product's database file.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Barrier};

use township_tauri_shell::{
    TownshipNativeState, TOWNSHIP_APP_IDENTIFIER, TOWNSHIP_DATABASE_FILE, TOWNSHIP_KEYRING_SERVICE,
    TOWNSHIP_LEGACY_NATIVE_KV_FILE, TOWNSHIP_PRODUCT,
};

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "township-product-db-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

#[test]
fn township_identifiers_match_the_shared_isolation_manifest() {
    let manifest = lattice_mobile_core::ProductManifest::for_product(TOWNSHIP_PRODUCT)
        .expect("township manifest");
    assert_eq!(manifest.app_id, TOWNSHIP_APP_IDENTIFIER);
    assert_eq!(manifest.key_service, TOWNSHIP_KEYRING_SERVICE);
    assert_eq!(manifest.database_file, TOWNSHIP_DATABASE_FILE);
}

#[test]
fn attach_product_database_creates_the_township_database_file() {
    let dir = temp_dir("create");
    let state = TownshipNativeState::ephemeral();

    state
        .attach_product_database(&dir)
        .expect("attach product database");

    assert!(
        dir.join(TOWNSHIP_DATABASE_FILE).exists(),
        "attaching the product database must create {TOWNSHIP_DATABASE_FILE}"
    );
}

#[test]
fn kv_state_persists_through_the_product_database() {
    let dir = temp_dir("persist");

    {
        let state = TownshipNativeState::ephemeral();
        state
            .attach_product_database(&dir)
            .expect("attach product database");
        state
            .kv_set(
                "township:matter:carrier_peer_config",
                "{\"url\":\"wss://x\"}",
            )
            .expect("kv set");
    }

    let restarted = TownshipNativeState::ephemeral();
    restarted
        .attach_product_database(&dir)
        .expect("attach product database after restart");
    assert_eq!(
        restarted
            .kv_get("township:matter:carrier_peer_config")
            .expect("kv get"),
        Some("{\"url\":\"wss://x\"}".to_string()),
        "kv state must survive a process restart through the SQLite store"
    );
}

#[test]
fn concurrent_state_writes_keep_memory_and_database_in_the_same_order() {
    let dir = temp_dir("concurrent-write-order");
    let state = Arc::new(TownshipNativeState::ephemeral());
    state
        .attach_product_database(&dir)
        .expect("attach product database");
    for round in 0..200 {
        let barrier = Arc::new(Barrier::new(3));
        let writers = [format!("first-{round}"), format!("second-{round}")].map(|value| {
            let state = Arc::clone(&state);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                state
                    .kv_set("township:matter:profile", &value)
                    .expect("concurrent state write");
            })
        });
        barrier.wait();
        for writer in writers {
            writer.join().expect("join concurrent writer");
        }

        let memory_value = state
            .kv_get("township:matter:profile")
            .expect("read in-memory value");
        let conn = rusqlite::Connection::open(dir.join(TOWNSHIP_DATABASE_FILE))
            .expect("open database after concurrent writes");
        let database_value: String = conn
            .query_row(
                "SELECT value FROM kv WHERE key = 'township:matter:profile'",
                [],
                |row| row.get(0),
            )
            .expect("read database value");
        assert_eq!(
            Some(database_value),
            memory_value,
            "serialized state writes must commit to SQLite and memory in the same order at round {round}"
        );
    }
}

#[test]
fn webview_state_refuses_secret_shaped_keys_before_database_attachment() {
    let dir = temp_dir("pre-database-secret");
    let values_path = dir.join("values.json");
    fs::write(&values_path, "{}").expect("write empty values file");
    let state = TownshipNativeState::with_persistent_values_file(&values_path)
        .expect("load empty values file");
    let key = "township:matter:CARRIER_SEED";
    let before = fs::read(&values_path).expect("read values before refusal");

    assert_eq!(
        state
            .kv_set(key, "must-not-land")
            .expect_err("secret-shaped state write must refuse"),
        format!("township key-value write contains secret material at {key}")
    );
    assert_eq!(
        state.kv_get(key).expect("read refused state key"),
        None,
        "a pre-database refusal must not fall through to memory or the values file"
    );
    assert_eq!(
        fs::read(&values_path).expect("read values after refusal"),
        before,
        "a refused webview write must not mutate the values file"
    );
}

#[test]
fn webview_state_uses_the_same_secret_refusal_after_database_attachment() {
    let dir = temp_dir("attached-secret");
    let state = TownshipNativeState::ephemeral();
    state
        .attach_product_database(&dir)
        .expect("attach product database");
    let key = "township:matter:signing_key_material";

    assert_eq!(
        state
            .kv_set(key, "must-not-land")
            .expect_err("attached secret-shaped state write must refuse"),
        format!("township key-value write contains secret material at {key}")
    );
    let database_path = dir.join(TOWNSHIP_DATABASE_FILE);
    assert!(
        database_path.exists(),
        "attachment must create the database"
    );
    let db = lattice_mobile_core::ProductDatabase::open_path(TOWNSHIP_PRODUCT, &database_path)
        .expect("reopen attached database");
    assert_eq!(db.kv_get(key).expect("read refused key"), None);
}

#[test]
fn loading_mixed_preexisting_state_purges_secrets_and_preserves_replayable_state() {
    let dir = temp_dir("preexisting-secret");
    let values_path = dir.join("preexisting-values.json");
    let key = "toolshed:carrier_seed";
    let ordinary_key = "township:matter:profile";
    fs::write(
        &values_path,
        format!(r#"{{"{ordinary_key}":"resident","{key}":"must-not-land"}}"#),
    )
    .expect("write mixed preexisting values file");
    let recovered = TownshipNativeState::with_persistent_values_file(&values_path)
        .expect("pre-guard values file must recover without a startup panic");
    assert_eq!(recovered.kv_get(key).expect("secret read"), None);
    assert_eq!(
        recovered.kv_get(ordinary_key).expect("ordinary read"),
        Some("resident".to_string())
    );
    let repaired_on_disk = fs::read_to_string(&values_path).expect("read repaired values file");
    assert!(!repaired_on_disk.contains(key));
    assert!(!repaired_on_disk.contains("must-not-land"));
    assert!(
        !dir.join(TOWNSHIP_DATABASE_FILE).exists(),
        "values-file recovery must happen before database attachment"
    );

    recovered
        .attach_product_database(&dir)
        .expect("recovered state must attach without deleting the database");
    assert_eq!(
        recovered.kv_get(ordinary_key).expect("read repaired state"),
        Some("resident".to_string()),
        "automatic recovery must preserve ordinary replayable state"
    );
}

#[test]
fn loading_cross_product_values_file_quarantines_the_foreign_rows() {
    let dir = temp_dir("preexisting-cross-product");
    let values_path = dir.join("preexisting-values.json");
    fs::write(
        &values_path,
        r#"{"township:matter:profile":"resident","toolshed:shed:profile":"maker"}"#,
    )
    .expect("write mixed product values file");

    let recovered = TownshipNativeState::with_persistent_values_file(&values_path)
        .expect("cross-product values file must recover");
    assert_eq!(
        recovered
            .kv_get("township:matter:profile")
            .expect("township read"),
        Some("resident".to_string())
    );
    assert_eq!(
        recovered
            .kv_get("toolshed:shed:profile")
            .expect("active cross-product read"),
        None
    );
    let quarantine_path = dir.join("preexisting-values.json.cross-product-quarantine.json");
    assert_eq!(
        fs::read_to_string(quarantine_path).expect("read cross-product quarantine"),
        r#"{"toolshed:shed:profile":"maker"}"#
    );
}

#[test]
fn legacy_json_state_migrates_exactly_once() {
    let dir = temp_dir("legacy");
    fs::write(
        dir.join(TOWNSHIP_LEGACY_NATIVE_KV_FILE),
        r#"{"township:matter:local_ops":"[\"op-1\"]","toolshed:carrier_seed":"must-not-land"}"#,
    )
    .expect("write legacy json");

    {
        let state = TownshipNativeState::ephemeral();
        state
            .attach_product_database(&dir)
            .expect("attach product database");
        assert_eq!(
            state.kv_get("township:matter:local_ops").expect("kv get"),
            Some("[\"op-1\"]".to_string()),
            "the legacy JSON state must migrate into the product database"
        );
        assert_eq!(
            state.kv_get("toolshed:carrier_seed").expect("secret read"),
            None,
            "secret-shaped cross-product legacy state must be purged without bricking attachment"
        );
    }

    let recovered_legacy = fs::read_to_string(dir.join(TOWNSHIP_LEGACY_NATIVE_KV_FILE))
        .expect("read recovered legacy");
    assert!(!recovered_legacy.contains("toolshed:carrier_seed"));
    assert!(!recovered_legacy.contains("must-not-land"));

    fs::write(
        dir.join(TOWNSHIP_LEGACY_NATIVE_KV_FILE),
        r#"{"township:matter:local_ops":"[\"tampered\"]"}"#,
    )
    .expect("tamper legacy json");

    let restarted = TownshipNativeState::ephemeral();
    restarted
        .attach_product_database(&dir)
        .expect("attach product database after restart");
    assert_eq!(
        restarted
            .kv_get("township:matter:local_ops")
            .expect("kv get"),
        Some("[\"op-1\"]".to_string()),
        "a tampered legacy file must not clobber already-migrated state"
    );
}

#[test]
fn attach_product_database_refuses_a_cross_product_file() {
    let dir = temp_dir("cross-product");
    // A toolshed shell left its database under the township file name.
    lattice_mobile_core::ProductDatabase::open_path("toolshed", &dir.join(TOWNSHIP_DATABASE_FILE))
        .expect("fabricate toolshed database");

    let state = TownshipNativeState::ephemeral();
    let refusal = state.attach_product_database(&dir);
    assert!(
        refusal.is_err(),
        "the township shell must refuse another product's database"
    );
    let message = refusal.expect_err("refusal message");
    assert!(
        message.contains("marker mismatch"),
        "refusal must name the product marker mismatch, got: {message}"
    );
}

#[test]
fn attach_product_database_purges_pre_guard_secret_rows_and_preserves_replayable_state() {
    let dir = temp_dir("pre-guard-secret-row");
    let database_path = dir.join(TOWNSHIP_DATABASE_FILE);
    {
        let db = lattice_mobile_core::ProductDatabase::open_path(TOWNSHIP_PRODUCT, &database_path)
            .expect("create prior-build database");
        db.kv_set("township:matter:profile", "resident")
            .expect("write ordinary prior-build state");
    }
    let conn = rusqlite::Connection::open(&database_path).expect("open raw prior-build database");
    conn.execute(
        "INSERT INTO kv (key, value) VALUES (?1, ?2)",
        ["township:matter:carrierSeed", "must-not-load"],
    )
    .expect("fabricate secret row from pre-guard build");
    conn.execute(
        "INSERT INTO kv (key, value) VALUES (?1, ?2)",
        ["toolshed:shed:profile", "maker"],
    )
    .expect("fabricate cross-product row from pre-guard build");
    drop(conn);

    let state = TownshipNativeState::ephemeral();
    state
        .attach_product_database(&dir)
        .expect("upgrade attachment purges the non-replayable row");
    assert_eq!(
        state.kv_get("township:matter:profile").expect("profile"),
        Some("resident".to_string())
    );
    assert_eq!(
        state
            .kv_get("township:matter:carrierSeed")
            .expect("purged key"),
        None
    );

    let db = lattice_mobile_core::ProductDatabase::open_path(TOWNSHIP_PRODUCT, &database_path)
        .expect("reopen upgraded database");
    assert_eq!(
        db.kv_get("township:matter:carrierSeed")
            .expect("purged database key"),
        None
    );
    assert_eq!(
        db.kv_get("toolshed:shed:profile")
            .expect("quarantined active key"),
        None
    );
    assert_eq!(
        db.quarantined_kv_get("toolshed:shed:profile")
            .expect("quarantined diagnostic key"),
        Some("maker".to_string())
    );
}
