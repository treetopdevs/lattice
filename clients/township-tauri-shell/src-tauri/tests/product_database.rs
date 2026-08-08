//! Township shell integration with the shared per-product SQLite storage
//! (plan 158 "Product Isolation and Migrations").
//!
//! The shell must open `township-v1.sqlite3` with the township product
//! marker, migrate the legacy `township-native-kv.json` state exactly once,
//! write kv state through the transactional store, and refuse another
//! product's database file.

use std::fs;
use std::path::PathBuf;

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
fn legacy_json_state_migrates_exactly_once() {
    let dir = temp_dir("legacy");
    fs::write(
        dir.join(TOWNSHIP_LEGACY_NATIVE_KV_FILE),
        r#"{"township:matter:local_ops":"[\"op-1\"]"}"#,
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
    }

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
