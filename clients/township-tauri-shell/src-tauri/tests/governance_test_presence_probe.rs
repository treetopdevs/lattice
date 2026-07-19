#![cfg(all(
    feature = "township-dev-trace",
    feature = "township-governance-test-presence"
))]

use std::fs::OpenOptions;
use std::io::Write;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use township_tauri_shell::{TownshipNativeState, TOWNSHIP_KEYRING_SERVICE};

#[test]
fn exports_the_deterministic_test_presence_public_key_for_fixture_preflight() {
    let out_path = std::env::var("TOWNSHIP_GOVERNANCE_TEST_PRESENCE_KEY_FILE").ok();

    let state = TownshipNativeState::platform_secure(TOWNSHIP_KEYRING_SERVICE);
    assert_eq!(
        state.governance_witness_provider_kind(),
        township_tauri_shell::GovernanceWitnessProviderKind::TestPresence
    );
    assert!(state.governance_witness_custody_is_bound());

    let before = township_tauri_shell::governance_test_presence_authorization_count();
    let first = state
        .governance_witness_public_key()
        .expect("test-presence provider reports a complete public identity");
    let second = state
        .governance_witness_public_key()
        .expect("test-presence provider reports a complete public identity");
    assert_eq!(first, second, "public identity discovery must be stable");
    assert_eq!(
        township_tauri_shell::governance_test_presence_authorization_count(),
        before,
        "public identity discovery must not authorize test presence"
    );

    let decoded = BASE64
        .decode(&first)
        .expect("probe key must be canonical base64");
    assert_eq!(decoded.len(), 32, "probe key must be a 32-byte Ed25519 key");
    assert_eq!(BASE64.encode(&decoded), first);

    if let Some(out_path) = out_path {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&out_path)
            .expect("probe output file must be newly created");
        file.write_all(first.as_bytes())
            .expect("probe output write must succeed");
    }
}
