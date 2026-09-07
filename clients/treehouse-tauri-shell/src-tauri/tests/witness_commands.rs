#[path = "../src/witness_binding.rs"]
mod witness_binding;
#[path = "../src/witness_bridge.rs"]
mod witness_bridge;
#[path = "../src/witness_commands.rs"]
mod witness_commands;
#[path = "../src/witness_document.rs"]
mod witness_document;
#[path = "../src/witness_drain.rs"]
mod witness_drain;
#[path = "../src/witness_entropy.rs"]
mod witness_entropy;
#[path = "../src/witness_flow.rs"]
mod witness_flow;
#[path = "../src/witness_mobile.rs"]
mod witness_mobile;
#[path = "../src/witness_operation.rs"]
mod witness_operation;
#[path = "../src/witness_owner.rs"]
mod witness_owner;
#[path = "../src/witness_public.rs"]
mod witness_public;
#[path = "../src/witness_result.rs"]
mod witness_result;
#[path = "../src/witness_reviewed.rs"]
mod witness_reviewed;
#[path = "../src/witness_session.rs"]
mod witness_session;
#[path = "../src/witness_snapshot.rs"]
mod witness_snapshot;

use serde_json::json;
use std::sync::Arc;
use tauri::{Listener, Manager, WebviewUrl, WebviewWindowBuilder};
use witness_bridge::{
    encode_terminal_response, Bytes32, ResponseKind, TerminalResponse, TerminalStatus,
};

const PLUGIN: &str = "witness-public-test";

fn context(command: &str) -> tauri::Context<tauri::test::MockRuntime> {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.runtime_authority_mut().__allow_command(
        format!("plugin:{PLUGIN}|{command}"),
        tauri::utils::acl::ExecutionContext::Remote {
            url: "http://tauri.localhost/*".parse().unwrap(),
        },
    );
    context
}

fn app(command: &str) -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .plugin(
            tauri::plugin::Builder::<tauri::test::MockRuntime, ()>::new(PLUGIN)
                .invoke_handler(witness_commands::handle)
                .build(),
        )
        .build(context(command))
        .unwrap()
}

fn invoke(
    view: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    body: tauri::ipc::InvokeBody,
) -> Result<serde_json::Value, serde_json::Value> {
    tauri::test::get_ipc_response(
        view,
        tauri::webview::InvokeRequest {
            cmd: format!("plugin:{PLUGIN}|{command}"),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body,
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .and_then(|body| body.deserialize().map_err(|error| json!(error.to_string())))
}

#[test]
fn known_command_is_handled_and_refused_when_runtime_state_is_absent() {
    let app = app(witness_public::WITNESS_IDENTITY);
    let view = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .build()
        .unwrap();
    assert_eq!(
        invoke(&view, witness_public::WITNESS_IDENTITY, json!({}).into()),
        Err(json!(witness_flow::FLOW_REFUSED))
    );
}

#[test]
fn known_command_rejects_nonclosed_body_and_unknown_command_reaches_fallback() {
    let app = app(witness_public::WITNESS_IDENTITY);
    let view = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .build()
        .unwrap();
    assert_eq!(
        invoke(
            &view,
            witness_public::WITNESS_IDENTITY,
            json!({"extra":true}).into()
        ),
        Err(json!(witness_public::PUBLIC_REQUEST_REFUSED))
    );
    assert!(!witness_commands::recognizes_command("treehouse_open"));
    assert!(!witness_commands::recognizes_command("dispatch"));
}

#[test]
fn successful_result_is_a_json_object_and_not_a_numeric_byte_array() {
    let app = app(witness_public::WITNESS_IDENTITY);
    let view = WebviewWindowBuilder::new(
        &app,
        "main",
        WebviewUrl::External("http://tauri.localhost/".parse().unwrap()),
    )
    .build()
    .unwrap();
    let webview = view.as_ref().clone();
    let owner = Arc::new(witness_owner::test_adapter::from_entropy(|| {
        Ok(Bytes32([1; 32]))
    }));
    let url = "http://tauri.localhost/".parse().unwrap();
    owner.navigation_requested(&webview, &url);
    owner
        .page_load(&webview, tauri::webview::PageLoadEvent::Started, &url)
        .unwrap();
    owner
        .page_load(&webview, tauri::webview::PageLoadEvent::Finished, &url)
        .unwrap();
    let operations = Arc::new(witness_operation::test_adapter::registry(|| {
        Ok(Bytes32([9; 32]))
    }));
    let flow = witness_flow::test_adapter::flow(owner, operations, |request, current| {
        let witness_bridge::PrivateRequest::Identity(value) = request else {
            panic!("unexpected request")
        };
        witness_mobile::test_adapter::dispatch(
            witness_bridge::PrivateRequest::Identity(value),
            move |_| async move {
                let terminal = TerminalResponse::terminal(
                    ResponseKind::Identity,
                    Bytes32([9; 32]),
                    TerminalStatus::Missing,
                )
                .unwrap();
                Ok(serde_json::from_slice(&encode_terminal_response(&terminal).unwrap()).unwrap())
            },
            move || current(),
        )
    });
    app.manage(flow);
    assert_eq!(
        invoke(&view, witness_public::WITNESS_IDENTITY, json!({}).into()),
        Ok(json!({"status":"missing","version":1}))
    );
}

#[test]
fn a_non_main_webview_cannot_use_managed_flow() {
    let app = app(witness_public::WITNESS_IDENTITY);
    let view = WebviewWindowBuilder::new(&app, "other", WebviewUrl::App("index.html".into()))
        .build()
        .unwrap();
    assert_eq!(
        invoke(&view, witness_public::WITNESS_IDENTITY, json!({}).into()),
        Err(json!(witness_flow::FLOW_REFUSED))
    );
}

#[test]
fn pending_event_targets_the_webview_window_listener_scope_only() {
    let app = app(witness_public::WITNESS_IDENTITY);
    let view = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .build()
        .unwrap();
    let window_hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let webview_hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = window_hits.clone();
    view.listen(witness_commands::PENDING_EVENT, move |_| {
        observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
    let observed = webview_hits.clone();
    view.as_ref()
        .listen(witness_commands::PENDING_EVENT, move |_| {
            observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
    witness_commands::emit_pending_for_test(
        view.as_ref(),
        Bytes32([7; 32]),
        witness_flow::PendingPhase::Review,
    )
    .unwrap();
    assert_eq!(window_hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(webview_hits.load(std::sync::atomic::Ordering::SeqCst), 0);
}
