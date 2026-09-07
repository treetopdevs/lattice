//! Empty offline Treehouse shell. Native commands have fixed product and key boundaries.
#[cfg(target_os = "android")]
mod android_keyring;
mod catalog_store;
mod key_store;
pub mod preview;
pub mod witness_binding;
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
        .invoke_handler(tauri::generate_handler![
            treehouse_open,
            treehouse_initialize_identity,
            treehouse_commit,
            treehouse_load_draft,
            treehouse_save_draft,
            treehouse_sign_carrier
        ])
        .run(tauri::generate_context!())
        .expect("Treehouse application runtime failed");
}
