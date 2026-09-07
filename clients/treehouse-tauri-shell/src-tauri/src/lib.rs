//! Empty offline Treehouse shell. Native commands have fixed product and key boundaries.
#[cfg(target_os = "android")]
mod android_keyring;
mod catalog_store;
mod key_store;
pub mod preview;
mod witness_android;
pub mod witness_binding;
mod witness_bridge;
mod witness_commands;
mod witness_document;
mod witness_drain;
mod witness_entropy;
mod witness_flow;
mod witness_mobile;
mod witness_operation;
mod witness_owner;
mod witness_public;
mod witness_result;
mod witness_reviewed;
mod witness_session;
mod witness_snapshot;
use preview::{Draft, OpenResult, PreviewStore};
use std::sync::{Arc, Mutex};
use tauri::Manager as _;
struct AppState(Mutex<Result<PreviewStore, String>>);
fn with_store<T>(
    state: &tauri::State<'_, AppState>,
    run: impl FnOnce(&mut PreviewStore) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "local_store_unavailable".to_string())?;
    match guard.as_mut() {
        Ok(store) => run(store),
        Err(reason) => Err(reason.clone()),
    }
}
#[tauri::command]
fn treehouse_open(state: tauri::State<'_, AppState>) -> Result<OpenResult, String> {
    with_store(&state, |s| s.open())
}
#[tauri::command]
fn treehouse_initialize_identity(state: tauri::State<'_, AppState>) -> Result<String, String> {
    with_store(&state, |s| s.initialize())
}
#[tauri::command]
fn treehouse_commit(
    state: tauri::State<'_, AppState>,
    expected_revision: u64,
    next: String,
) -> Result<bool, String> {
    with_store(&state, |s| s.commit(expected_revision, &next))
}
#[tauri::command]
fn treehouse_load_draft(
    state: tauri::State<'_, AppState>,
    replica: String,
) -> Result<Option<Draft>, String> {
    with_store(&state, |s| s.load_draft(&replica))
}
#[tauri::command]
fn treehouse_save_draft(
    state: tauri::State<'_, AppState>,
    replica: String,
    expected_revision: u64,
    text: String,
) -> Result<Option<Draft>, String> {
    with_store(&state, |s| s.save_draft(&replica, expected_revision, &text))
}
#[tauri::command]
fn treehouse_sign_carrier(
    state: tauri::State<'_, AppState>,
    bytes: String,
) -> Result<String, String> {
    with_store(&state, |s| s.sign(&bytes))
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(witness_android::private_plugin())
        .setup(|app| {
            #[cfg(target_os = "android")]
            let bootstrap = android_keyring::configure();
            #[cfg(not(target_os = "android"))]
            let bootstrap: Result<(), String> = Ok(());
            let store = bootstrap.and_then(|()| {
                app.path()
                    .app_data_dir()
                    .map_err(|_| "local_store_unavailable".to_string())
                    .and_then(|path| {
                        PreviewStore::at_directory(&path, Arc::new(key_store::TreehouseKeyStore))
                    })
            });
            app.manage(AppState(Mutex::new(store)));
            Ok(())
        })
        .invoke_handler(application_invoke_handler())
        .run(tauri::generate_context!())
        .expect("Treehouse application runtime failed");
}

fn application_invoke_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    let preview: fn(tauri::ipc::Invoke<R>) -> bool = tauri::generate_handler![
        treehouse_open,
        treehouse_initialize_identity,
        treehouse_commit,
        treehouse_load_draft,
        treehouse_save_draft,
        treehouse_sign_carrier
    ];
    move |invoke| {
        if witness_commands::recognizes_command(invoke.message.command()) {
            witness_commands::handle(invoke)
        } else {
            preview(invoke)
        }
    }
}

#[cfg(test)]
mod application_boundary_tests {
    use super::*;
    use serde_json::{json, Value};
    use tauri::{test::MockRuntime, WebviewUrl, WebviewWindowBuilder};

    fn app() -> tauri::App<MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        for command in [
            "treehouse_open",
            witness_public::WITNESS_IDENTITY,
            witness_public::WITNESS_PREPARE_CREATION,
            witness_public::WITNESS_GENERATE,
            witness_public::WITNESS_PROVE_BINDING,
            witness_public::WITNESS_CANCEL,
            "treehouse_witness_identity",
        ] {
            context.runtime_authority_mut().__allow_command(
                command.into(),
                tauri::utils::acl::ExecutionContext::Remote {
                    url: "http://tauri.localhost/*".parse().unwrap(),
                },
            );
        }
        let app = tauri::test::mock_builder()
            .plugin(witness_android::private_plugin())
            .invoke_handler(application_invoke_handler())
            .build(context)
            .unwrap();
        app.manage(AppState(Mutex::new(Err(
            "preview_test_store_unavailable".into()
        ))));
        app
    }

    fn invoke(
        view: &tauri::WebviewWindow<MockRuntime>,
        command: &str,
        body: Value,
    ) -> Result<Value, Value> {
        tauri::test::get_ipc_response(
            view,
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: body.into(),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
        .and_then(|body| body.deserialize().map_err(|e| json!(e.to_string())))
    }

    #[test]
    fn compiled_permissions_allow_only_local_main_witness_requests() {
        use std::collections::BTreeMap;
        use tauri::utils::acl::{capability::Capability, manifest::Manifest, resolved::Resolved};
        let manifests: BTreeMap<String, Manifest> =
            serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
        let capabilities: BTreeMap<String, Capability> =
            serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
        for target in [
            tauri::utils::platform::Target::Android,
            tauri::utils::platform::Target::MacOS,
        ] {
            let resolved = Resolved::resolve(&manifests, capabilities.clone(), target).unwrap();
            let authority = tauri::ipc::RuntimeAuthority::new(
                serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap(),
                resolved,
            );
            for command in [
                witness_public::WITNESS_IDENTITY,
                witness_public::WITNESS_PREPARE_CREATION,
                witness_public::WITNESS_GENERATE,
                witness_public::WITNESS_PROVE_BINDING,
                witness_public::WITNESS_CANCEL,
            ] {
                assert!(
                    authority
                        .resolve_access(command, "main", "main", &tauri::ipc::Origin::Local)
                        .is_some(),
                    "{command}"
                );
                assert!(
                    authority
                        .resolve_access(command, "main", "other", &tauri::ipc::Origin::Local)
                        .is_none(),
                    "{command}"
                );
                assert!(
                    authority
                        .resolve_access(
                            command,
                            "main",
                            "main",
                            &tauri::ipc::Origin::Remote {
                                url: "https://example.invalid".parse().unwrap()
                            }
                        )
                        .is_none(),
                    "{command}"
                );
            }
            assert!(authority
                .resolve_access("treehouse_open", "main", "main", &tauri::ipc::Origin::Local)
                .is_some());
            for command in [
                "treehouse_witness_identity",
                "plugin:treehouse-witness-internal|dispatch",
                "treehouse_unregistered_action",
            ] {
                assert!(
                    authority
                        .resolve_access(command, "main", "main", &tauri::ipc::Origin::Local)
                        .is_none(),
                    "{command}"
                );
            }
        }
    }

    #[test]
    fn application_routes_witness_requests_to_closed_decoder_and_preview_to_existing_store() {
        let app = app();
        let view = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
        assert_eq!(
            invoke(&view, "treehouse_open", json!({})),
            Err(json!("preview_test_store_unavailable"))
        );
        for command in [
            witness_public::WITNESS_IDENTITY,
            witness_public::WITNESS_PREPARE_CREATION,
            witness_public::WITNESS_GENERATE,
            witness_public::WITNESS_PROVE_BINDING,
            witness_public::WITNESS_CANCEL,
        ] {
            assert_eq!(
                invoke(&view, command, json!({"unexpected":true})),
                Err(json!(witness_public::PUBLIC_REQUEST_REFUSED)),
                "{command}"
            );
        }
    }

    #[test]
    fn application_identity_refuses_without_android_flow_and_does_not_fall_through() {
        let app = app();
        let view = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
        assert_eq!(
            invoke(&view, witness_public::WITNESS_IDENTITY, json!({})),
            Err(json!(witness_flow::FLOW_REFUSED))
        );
        assert!(invoke(&view, "treehouse_witness_identity", json!({})).is_err());
    }
}
