//! Public witness IPC adapter. Registration and ACL activation are owned by the application.

use crate::{
    witness_flow::{PendingPhase, WitnessFlow, FLOW_REFUSED},
    witness_public::{
        decode_public_request, WITNESS_CANCEL, WITNESS_GENERATE, WITNESS_IDENTITY,
        WITNESS_PREPARE_CREATION, WITNESS_PROVE_BINDING,
    },
};
use serde::Serialize;
use std::sync::Arc;
use tauri::{
    ipc::{Invoke, InvokeError, InvokeResponseBody},
    Emitter, EventTarget, Runtime,
};

pub(crate) const PENDING_EVENT: &str = "treehouse:witness-pending-v1";
const MAIN_WEBVIEW: &str = "main";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingEvent {
    version: u8,
    attempt_id: crate::witness_bridge::Bytes32,
    phase: &'static str,
}

pub(crate) fn recognizes_command(command: &str) -> bool {
    matches!(
        command,
        WITNESS_IDENTITY
            | WITNESS_PREPARE_CREATION
            | WITNESS_GENERATE
            | WITNESS_PROVE_BINDING
            | WITNESS_CANCEL
    )
}

/// Returns false only for commands outside the five-name public witness surface.
pub(crate) fn handle<R: Runtime>(invoke: Invoke<R>) -> bool {
    let command = invoke.message.command();
    if !recognizes_command(command) {
        return false;
    }

    let request = match decode_public_request(command, invoke.message.payload()) {
        Ok(request) => request,
        Err(reason) => {
            invoke.resolver.reject(reason);
            return true;
        }
    };
    let webview = invoke.message.webview();
    if webview.label() != MAIN_WEBVIEW {
        invoke.resolver.reject(FLOW_REFUSED);
        return true;
    }
    let flow = invoke
        .message
        .state_ref()
        .try_get::<Arc<WitnessFlow>>()
        .map(|state| state.inner().clone());
    let Some(flow) = flow else {
        invoke.resolver.reject(FLOW_REFUSED);
        return true;
    };

    let event_view = webview.clone();
    let notice = Arc::new(move |attempt_id, phase| emit_pending(&event_view, attempt_id, phase));
    let pending = match flow.execute(webview, request, notice) {
        Ok(pending) => pending,
        Err(reason) => {
            invoke.resolver.reject(reason);
            return true;
        }
    };
    invoke.resolver.respond_async_serialized(async move {
        let bytes = pending.receive().await.map_err(invoke_error)?;
        let text = String::from_utf8(bytes).map_err(|_| invoke_error(FLOW_REFUSED))?;
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| invoke_error(FLOW_REFUSED))?;
        if !value.is_object() {
            return Err(invoke_error(FLOW_REFUSED));
        }
        Ok(InvokeResponseBody::Json(text))
    });
    true
}

fn emit_pending<R: Runtime>(
    webview: &tauri::Webview<R>,
    attempt_id: crate::witness_bridge::Bytes32,
    phase: PendingPhase,
) -> Result<(), &'static str> {
    let phase = match phase {
        PendingPhase::Review => "review",
        PendingPhase::Presence => "presence",
    };
    webview
        .emit_to(
            EventTarget::webview_window(webview.label()),
            PENDING_EVENT,
            PendingEvent {
                version: 1,
                attempt_id,
                phase,
            },
        )
        .map_err(|_| FLOW_REFUSED)
}

fn invoke_error(reason: &'static str) -> InvokeError {
    InvokeError(serde_json::Value::String(reason.to_string()))
}

#[cfg(test)]
pub(crate) fn emit_pending_for_test<R: Runtime>(
    webview: &tauri::Webview<R>,
    attempt_id: crate::witness_bridge::Bytes32,
    phase: PendingPhase,
) -> Result<(), &'static str> {
    emit_pending(webview, attempt_id, phase)
}
