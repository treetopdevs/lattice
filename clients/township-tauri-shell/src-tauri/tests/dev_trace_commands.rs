#![cfg(feature = "township-dev-trace")]

use std::path::PathBuf;

use township_tauri_shell::{
    configure_township_builder, TownshipNativeState, TOWNSHIP_DEV_TRACE_FILE_ENV,
};

#[test]
fn explicit_trace_is_fail_loud_while_command_telemetry_is_best_effort() {
    let trace_path = unique_trace_path();
    std::env::set_var(TOWNSHIP_DEV_TRACE_FILE_ENV, &trace_path);

    let app =
        configure_township_builder(tauri::test::mock_builder(), TownshipNativeState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    assert_ipc_response(
        &webview,
        "lattice_trace_dev_event",
        serde_json::json!({ "event": "deep-link:township://pairing" }),
        Ok(()),
    );
    assert!(std::fs::read_to_string(&trace_path)
        .unwrap()
        .lines()
        .any(|line| line == "deep-link:township://pairing"));

    std::env::set_var(
        TOWNSHIP_DEV_TRACE_FILE_ENV,
        trace_path.join("missing-parent").join("trace.log"),
    );
    assert_ipc_response(
        &webview,
        "lattice_trace_dev_event",
        serde_json::json!({ "event": "township-native-hydration-settled" }),
        Err("unable to write Township development trace".to_string()),
    );
    assert_ipc_response(
        &webview,
        "lattice_kv_get",
        serde_json::json!({ "key": "township:never-written" }),
        Ok(None::<String>),
    );

    std::env::remove_var(TOWNSHIP_DEV_TRACE_FILE_ENV);
    let _ = std::fs::remove_file(trace_path);
}

fn assert_ipc_response<T>(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: serde_json::Value,
    expected: Result<T, T>,
) where
    T: serde::Serialize + std::fmt::Debug + Send + Sync + 'static,
{
    tauri::test::assert_ipc_response(
        webview,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: body.into(),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
        expected,
    );
}

fn unique_trace_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "township-native-command-trace-{}-{:?}.log",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
