#![cfg(all(
    target_os = "macos",
    not(feature = "township-governance-test-presence")
))]

use tauri::Manager;
use township_tauri_shell::{
    configure_platform_secure_township_builder, GovernanceWitnessProviderKind, TownshipNativeState,
    TOWNSHIP_GOVERNANCE_KEYRING_SERVICE, TOWNSHIP_KEYRING_SERVICE,
};

#[test]
fn ordinary_macos_builder_binds_protected_governance_custody() {
    assert_eq!(
        TOWNSHIP_GOVERNANCE_KEYRING_SERVICE,
        "dev.treetop.lattice.township.governance-witness"
    );
    assert_ne!(
        TOWNSHIP_GOVERNANCE_KEYRING_SERVICE,
        TOWNSHIP_KEYRING_SERVICE
    );

    let app = configure_platform_secure_township_builder(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let state = app.state::<TownshipNativeState>();

    assert_eq!(
        state.governance_witness_provider_kind(),
        GovernanceWitnessProviderKind::MacosProtectedKeychain
    );
    assert!(state.governance_witness_custody_is_bound());
}
