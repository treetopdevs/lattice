//! Private plugin boundary. No public witness command is exposed here.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub(crate) fn private_plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("treehouse-witness-internal")
        .invoke_handler(|invoke| {
            invoke.resolver.reject("private_witness_plugin");
            // Handled is essential: false permits mobile plugin fallback dispatch.
            true
        })
        .build()
}
