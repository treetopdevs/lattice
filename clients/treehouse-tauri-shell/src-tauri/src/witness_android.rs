//! Private plugin boundary. No public witness command is exposed here.
use crate::witness_owner::WitnessOwner;
use std::sync::Arc;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub(crate) fn private_plugin<R: Runtime>() -> TauriPlugin<R> {
    plugin_with_owner(Arc::new(WitnessOwner::new()))
}

fn plugin_with_owner<R: Runtime>(owner: Arc<WitnessOwner>) -> TauriPlugin<R> {
    let navigation_owner = owner.clone();
    let load_owner = owner.clone();
    let event_owner = owner.clone();
    Builder::new("treehouse-witness-internal")
        .setup(move |_app, _api| {
            use tauri::Manager as _;
            _app.manage(owner.clone());
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin(
                    "dev.treetop.lattice.treehouse.witness",
                    "TreehouseWitnessPlugin",
                )?;
                _app.manage(crate::witness_mobile::NativeWitnessPlugin::from_plugin_handle(handle));
            }
            Ok(())
        })
        .on_navigation(move |webview, url| navigation_owner.navigation_requested(webview, url))
        .on_page_load(move |webview, payload| {
            let _ = load_owner.page_load(webview, payload.event(), payload.url());
        })
        .on_event(move |_app, event| match event {
            tauri::RunEvent::WindowEvent { label, event, .. } if label == "main" => match event {
                tauri::WindowEvent::Destroyed => event_owner.owner_destroyed(),
                #[cfg(mobile)]
                tauri::WindowEvent::Suspended => event_owner.lifecycle_cancelled(),
                _ => {}
            },
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. } => {
                event_owner.owner_destroyed()
            }
            _ => {}
        })
        .invoke_handler(|invoke| {
            invoke.resolver.reject("private_witness_plugin");
            // Handled is essential: false permits mobile plugin fallback dispatch.
            true
        })
        .build()
}

#[cfg(test)]
pub(crate) fn test_plugin_with_owner<R: Runtime>(owner: Arc<WitnessOwner>) -> TauriPlugin<R> {
    plugin_with_owner(owner)
}
