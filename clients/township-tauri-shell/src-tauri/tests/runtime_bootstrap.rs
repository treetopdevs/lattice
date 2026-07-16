#[test]
fn generated_context_embeds_township_app_identity() {
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let config = context.config();
    let main_window = config
        .app
        .windows
        .first()
        .expect("Township shell config should declare a main window");

    assert_eq!(config.product_name.as_deref(), Some("Township"));
    assert_eq!(config.identifier, "dev.treetop.lattice.township");
    assert!(config.bundle.active);
    assert_eq!(main_window.label, "main");
    assert_eq!(main_window.title, "Township");

    let deep_link = config
        .plugins
        .0
        .get("deep-link")
        .expect("Township shell config should include deep-link plugin config");
    assert_eq!(
        deep_link["desktop"]["schemes"][0],
        serde_json::Value::String("township".to_string())
    );
    assert_eq!(
        deep_link["mobile"][0]["scheme"][0],
        serde_json::Value::String("township".to_string())
    );
    assert_eq!(
        deep_link["mobile"][0]["appLink"],
        serde_json::Value::Bool(false)
    );
}
