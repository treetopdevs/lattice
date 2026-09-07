//! Private plugin boundary. No public witness command is exposed here.
use crate::witness_flow::WitnessFlow;
#[cfg(not(target_os = "android"))]
use crate::witness_owner::WitnessOwner;
use std::sync::Arc;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub(crate) fn private_plugin<R: Runtime>() -> TauriPlugin<R> {
    hooks()
        .setup(move |app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin(
                    "dev.treetop.lattice.treehouse.witness",
                    "TreehouseWitnessPlugin",
                )?;
                let plugin = Arc::new(
                    crate::witness_mobile::NativeWitnessPlugin::from_plugin_handle(handle),
                );
                app.manage(WitnessFlow::new(plugin));
            }
            #[cfg(not(target_os = "android"))]
            {
                // Desktop retains the document guard for preview, with no custody provider.
                app.manage(Arc::new(WitnessOwner::new()));
            }
            Ok(())
        })
        .build()
}

fn hooks<R: Runtime>() -> Builder<R> {
    Builder::new("treehouse-witness-internal")
        .on_navigation(|webview, url| {
            if let Some(flow) = webview.try_state::<Arc<WitnessFlow>>() {
                return flow.navigation_requested(webview, url);
            }
            #[cfg(not(target_os = "android"))]
            if let Some(owner) = webview.try_state::<Arc<WitnessOwner>>() {
                return owner.navigation_requested(webview, url);
            }
            // Missing native state refuses custody elsewhere; preview navigation stays allowed.
            true
        })
        .on_page_load(|webview, payload| {
            if let Some(flow) = webview.try_state::<Arc<WitnessFlow>>() {
                let _ = flow.page_load(webview, payload.event(), payload.url());
                return;
            }
            #[cfg(not(target_os = "android"))]
            if let Some(owner) = webview.try_state::<Arc<WitnessOwner>>() {
                let _ = owner.page_load(webview, payload.event(), payload.url());
            }
        })
        .on_event(|app, event| {
            if let Some(flow) = app.try_state::<Arc<WitnessFlow>>() {
                match event {
                    tauri::RunEvent::WindowEvent { label, event, .. } if label == "main" => {
                        match event {
                            tauri::WindowEvent::Destroyed => flow.owner_destroyed(),
                            #[cfg(mobile)]
                            tauri::WindowEvent::Suspended => flow.lifecycle_invalidated(),
                            _ => {}
                        }
                    }
                    tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. } => {
                        flow.owner_destroyed()
                    }
                    _ => {}
                }
                return;
            }
            #[cfg(not(target_os = "android"))]
            if let Some(owner) = app.try_state::<Arc<WitnessOwner>>() {
                match event {
                    tauri::RunEvent::WindowEvent {
                        label,
                        event: tauri::WindowEvent::Destroyed,
                        ..
                    } if label == "main" => owner.owner_destroyed(),
                    #[cfg(mobile)]
                    tauri::RunEvent::WindowEvent {
                        label,
                        event: tauri::WindowEvent::Suspended,
                        ..
                    } if label == "main" => owner.lifecycle_cancelled(),
                    tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. } => {
                        owner.owner_destroyed()
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(|invoke| {
            invoke.resolver.reject("private_witness_plugin");
            // Handled is essential: false permits mobile plugin fallback dispatch.
            true
        })
}

#[cfg(test)]
pub(crate) fn test_plugin_with_flow<R: Runtime>(flow: Arc<WitnessFlow>) -> TauriPlugin<R> {
    hooks()
        .setup(move |app, _api| {
            app.manage(flow);
            Ok(())
        })
        .build()
}
