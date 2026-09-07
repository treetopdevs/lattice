//! Private plugin boundary. No public witness command is exposed here.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub(crate) fn private_plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("treehouse-witness-internal")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager as _;
                let handle = _api.register_android_plugin(
                    "dev.treetop.lattice.treehouse.witness",
                    "TreehouseWitnessPlugin",
                )?;
                _app.manage(crate::witness_mobile::NativeWitnessPlugin::from_plugin_handle(handle));
            }
            Ok(())
        })
        .invoke_handler(|invoke| {
            invoke.resolver.reject("private_witness_plugin");
            // Handled is essential: false permits mobile plugin fallback dispatch.
            true
        })
        .build()
}
