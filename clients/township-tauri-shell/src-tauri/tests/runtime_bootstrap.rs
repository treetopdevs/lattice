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
    assert_eq!(main_window.label, "main");
    assert_eq!(main_window.title, "Township");
}
