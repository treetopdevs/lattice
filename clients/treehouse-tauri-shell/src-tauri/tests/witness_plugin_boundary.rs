#[path = "../src/witness_android.rs"]
mod witness_android;

#[test]
fn direct_webview_invokes_are_terminally_refused_for_every_private_command() {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    // Deliberately broaden the test ACL: a future permission mistake must not reach Kotlin.
    for command in [
        "identity",
        "prepare",
        "generate",
        "proof",
        "signPrepared",
        "cancel",
        "unknown",
    ] {
        context.runtime_authority_mut().__allow_command(
            format!("plugin:treehouse-witness-internal|{command}"),
            tauri::utils::acl::ExecutionContext::Remote {
                url: "http://tauri.localhost/*".parse().unwrap(),
            },
        );
    }
    let app = tauri::test::mock_builder()
        .plugin(witness_android::private_plugin())
        .build(context)
        .unwrap();
    let view =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    for command in [
        "identity",
        "prepare",
        "generate",
        "proof",
        "signPrepared",
        "cancel",
        "unknown",
    ] {
        let result = tauri::test::get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: format!("plugin:treehouse-witness-internal|{command}"),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: serde_json::json!({"operationId":"forged","sessionDigest":"forged"}).into(),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        );
        assert_eq!(
            result.err(),
            Some(serde_json::json!("private_witness_plugin")),
            "{command}"
        );
    }
}
