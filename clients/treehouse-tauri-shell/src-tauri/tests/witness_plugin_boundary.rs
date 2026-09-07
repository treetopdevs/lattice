#[path = "../src/witness_android.rs"]
mod witness_android;
#[path = "../src/witness_bridge.rs"]
mod witness_bridge;
#[path = "../src/witness_document.rs"]
mod witness_document;
#[path = "../src/witness_entropy.rs"]
mod witness_entropy;
#[path = "../src/witness_owner.rs"]
mod witness_owner;
#[path = "../src/witness_session.rs"]
mod witness_session;

#[test]
fn direct_webview_invokes_are_terminally_refused_for_every_private_command() {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    // Deliberately broaden the test ACL: a future permission mistake must not reach Kotlin.
    for command in [
        "dispatch",
        "sign_prepared",
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
        "dispatch",
        "sign_prepared",
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

#[test]
fn actual_plugin_navigation_hook_arms_first_document_and_refuses_later_navigation() {
    use tauri::plugin::Plugin;
    use tauri::webview::PageLoadEvent;
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(
        &app,
        "main",
        tauri::WebviewUrl::External("http://tauri.localhost/".parse().unwrap()),
    )
    .build()
    .unwrap();
    let webview = view.as_ref().clone();
    let owner = std::sync::Arc::new(witness_owner::WitnessOwner::new());
    let mut plugin = witness_android::test_plugin_with_owner(owner.clone());
    let url = "http://tauri.localhost/".parse().unwrap();
    assert!(plugin.on_navigation(&webview, &url));
    owner
        .page_load(&webview, PageLoadEvent::Started, &url)
        .unwrap();
    owner
        .page_load(&webview, PageLoadEvent::Finished, &url)
        .unwrap();
    let snapshot = owner.snapshot(&webview).unwrap();
    assert!(owner.current(&webview, &snapshot));
    assert!(plugin.on_navigation(&webview, &url));
    assert!(!owner.current(&webview, &snapshot));
}
