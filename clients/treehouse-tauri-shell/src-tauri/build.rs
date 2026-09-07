fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&[
        "treehouse_open",
        "treehouse_initialize_identity",
        "treehouse_commit",
        "treehouse_load_draft",
        "treehouse_save_draft",
        "treehouse_sign_carrier",
        "treehouse_witness_public_identity",
        "treehouse_witness_prepare_creation",
        "treehouse_witness_generate",
        "treehouse_witness_prove_binding",
        "treehouse_witness_cancel",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("Treehouse application permissions must compile");
}
