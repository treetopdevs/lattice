#[path = "../src/witness_android.rs"]
mod witness_android;
#[path = "../src/witness_binding.rs"]
mod witness_binding;
#[path = "../src/witness_bridge.rs"]
mod witness_bridge;
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

#[test]
fn direct_webview_invokes_are_terminally_refused_for_every_private_command() {
    use tauri::Manager;
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
    assert!(app
        .try_state::<std::sync::Arc<witness_flow::WitnessFlow>>()
        .is_none());
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
    use tauri::webview::PageLoadEvent;
    use tauri::{plugin::Plugin, Manager};
    let owner = std::sync::Arc::new(witness_owner::WitnessOwner::new());
    let flow = witness_flow::test_adapter::flow(
        owner.clone(),
        std::sync::Arc::new(witness_operation::test_adapter::registry(|| {
            Ok(witness_bridge::Bytes32([9; 32]))
        })),
        |_, _| panic!("navigation must not dispatch"),
    );
    let app = tauri::test::mock_builder()
        .plugin(witness_android::test_plugin_with_flow(flow.clone()))
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
    assert!(std::sync::Arc::ptr_eq(
        &app.state::<std::sync::Arc<witness_flow::WitnessFlow>>(),
        &flow
    ));
    assert!(app
        .try_state::<std::sync::Arc<witness_owner::WitnessOwner>>()
        .is_none());
    let mut plugin = witness_android::private_plugin();
    let url = "http://tauri.localhost/".parse().unwrap();
    assert!(plugin.on_navigation(&webview, &url));
    flow.page_load(&webview, PageLoadEvent::Started, &url)
        .unwrap();
    flow.page_load(&webview, PageLoadEvent::Finished, &url)
        .unwrap();
    let snapshot = owner.snapshot(&webview).unwrap();
    assert!(owner.current(&webview, &snapshot));
    assert!(plugin.on_navigation(&webview, &url));
    assert!(!owner.current(&webview, &snapshot));
}

#[test]
fn actual_navigation_hook_cancels_active_flow_before_gated_native_callback_finishes() {
    cancellation_hook("navigation");
}
#[test]
fn actual_exit_hook_cancels_active_flow_before_gated_native_callback_finishes() {
    cancellation_hook("exit");
}
fn cancellation_hook(event: &str) {
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;
    use tauri::webview::PageLoadEvent;
    use tauri::{plugin::Plugin, Manager};
    use witness_bridge::{Bytes32, PrivateRequest, ResponseKind, TerminalResponse, TerminalStatus};
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
    let owner = Arc::new(witness_owner::WitnessOwner::new());
    let mut hooks = witness_android::private_plugin();
    let url = "http://tauri.localhost/".parse().unwrap();
    assert!(owner.navigation_requested(&webview, &url));
    owner
        .page_load(&webview, PageLoadEvent::Started, &url)
        .unwrap();
    owner
        .page_load(&webview, PageLoadEvent::Finished, &url)
        .unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (cancel_tx, cancel_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release = Arc::new(Mutex::new(Some(release_rx)));
    let flow = witness_flow::test_adapter::flow(
        owner,
        Arc::new(witness_operation::test_adapter::registry(|| {
            Ok(Bytes32([9; 32]))
        })),
        move |request, current| {
            let (kind, id) = match &request {
                PrivateRequest::Identity(v) => (ResponseKind::Identity, v.operation_id),
                PrivateRequest::Cancel(v) => {
                    cancel_tx.send(()).unwrap();
                    (ResponseKind::Cancel, v.operation_id)
                }
                _ => panic!("unexpected request"),
            };
            let started = started_tx.clone();
            let release = release.clone();
            witness_mobile::test_adapter::dispatch(
                request,
                move |_| async move {
                    if kind == ResponseKind::Identity {
                        started.send(()).unwrap();
                        release.lock().unwrap().take().unwrap().recv().unwrap();
                    }
                    let response = TerminalResponse::terminal(
                        kind,
                        id,
                        if kind == ResponseKind::Identity {
                            TerminalStatus::Missing
                        } else {
                            TerminalStatus::Cancelled
                        },
                    )
                    .unwrap();
                    Ok(serde_json::from_slice(
                        &witness_bridge::encode_terminal_response(&response).unwrap(),
                    )
                    .unwrap())
                },
                move || current(),
            )
        },
    );
    app.manage(flow.clone());
    let pending = flow
        .execute(
            webview.clone(),
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| Ok(())),
        )
        .unwrap();
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    match event {
        "navigation" => {
            assert!(hooks.on_navigation(&webview, &url));
        }
        "exit" => hooks.on_event(app.handle(), &tauri::RunEvent::Exit),
        _ => unreachable!(),
    }
    let cancelled = cancel_rx.recv_timeout(Duration::from_secs(1));
    release_tx.send(()).unwrap();
    assert!(tauri::async_runtime::block_on(pending.receive()).is_err());
    assert!(
        cancelled.is_ok(),
        "actual plugin hook must actively cancel native flow"
    );
}
