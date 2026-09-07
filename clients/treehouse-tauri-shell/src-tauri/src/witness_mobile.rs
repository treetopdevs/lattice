//! Owned private Android dispatch. This module registers no command or plugin.

use crate::{
    witness_bridge::{
        decode_terminal_response, encode_request, PrivateRequest, ResponseKind, TerminalResponse,
        MAX_PRIVATE_MESSAGE,
    },
    witness_drain::{start_native_call, NativeCancellation, NativeDrain, NativePending},
    witness_snapshot::{decode_snapshot, SnapshotResponse},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{de::Error as _, Deserialize, Deserializer};
use serde_json::Value;
use std::future::Future;
use tauri::{plugin::PluginHandle, Runtime};

const MOBILE_METHOD: &str = "dispatch";
const RESPONSE_REFUSED: &str = "invalid_private_response";

pub(crate) struct NativeWitnessPlugin<R: Runtime> {
    handle: PluginHandle<R>,
}

impl<R: Runtime> NativeWitnessPlugin<R> {
    pub(crate) fn from_plugin_handle(handle: PluginHandle<R>) -> Self {
        Self { handle }
    }

    #[cfg(target_os = "android")]
    pub(crate) fn dispatch<V>(&self, request: PrivateRequest, current: V) -> MobilePending
    where
        V: Fn() -> bool + Send + Sync + 'static,
    {
        let handle = self.handle.clone();
        dispatch_with(
            request,
            move |payload| async move {
                handle
                    .run_mobile_plugin_async::<Value>(MOBILE_METHOD, payload)
                    .await
                    .map_err(|_| RESPONSE_REFUSED)
            },
            current,
        )
    }
}

pub(crate) enum MobileResponse {
    Terminal(TerminalResponse),
    Snapshot(SnapshotResponse),
    /// Exact proof response bytes are consumed by witness_reviewed with its sealed context.
    Reviewed(Vec<u8>),
}

pub(crate) struct MobilePending(NativePending<Result<MobileResponse, &'static str>>);
impl MobilePending {
    pub(crate) fn cancellation(&self) -> NativeCancellation {
        self.0.cancellation()
    }
    pub(crate) fn drain(&self) -> NativeDrain {
        self.0.drain()
    }
    pub(crate) async fn receive(self) -> Result<MobileResponse, &'static str> {
        self.0.receive().await?
    }
}

fn dispatch_with<F, Fut, V>(request: PrivateRequest, transport: F, current: V) -> MobilePending
where
    F: FnOnce(Value) -> Fut + Send + 'static,
    Fut: Future<Output = Result<Value, &'static str>> + Send + 'static,
    V: Fn() -> bool + Send + Sync + 'static,
{
    let request_bytes = encode_request(&request);
    MobilePending(start_native_call(
        async move {
            let request_bytes = request_bytes?;
            let payload: Value =
                serde_json::from_slice(&request_bytes).map_err(|_| RESPONSE_REFUSED)?;
            let raw = transport(payload).await?;
            if !raw.is_object() {
                return Err(RESPONSE_REFUSED);
            }
            let bytes = serde_json::to_vec(&raw).map_err(|_| RESPONSE_REFUSED)?;
            if bytes.len() > MAX_PRIVATE_MESSAGE {
                return Err(RESPONSE_REFUSED);
            }
            decode_response(bytes, &request)
        },
        current,
    ))
}

fn decode_response(
    bytes: Vec<u8>,
    request: &PrivateRequest,
) -> Result<MobileResponse, &'static str> {
    let raw: Value = serde_json::from_slice(&bytes).map_err(|_| RESPONSE_REFUSED)?;
    let status = raw
        .get("status")
        .and_then(Value::as_str)
        .ok_or(RESPONSE_REFUSED)?;
    if matches!(status, "missing" | "refused" | "cancelled") {
        let terminal = decode_terminal_response(&bytes)?;
        if terminal.kind != expected_kind(request) || terminal.operation_id != operation_id(request)
        {
            return Err(RESPONSE_REFUSED);
        }
        return Ok(MobileResponse::Terminal(terminal));
    }
    if status == "snapshot" {
        return decode_snapshot(&bytes, request).map(MobileResponse::Snapshot);
    }
    match request {
        PrivateRequest::Proof(r) if status == "prepared" => {
            let response: PreparedWire =
                serde_json::from_slice(&bytes).map_err(|_| RESPONSE_REFUSED)?;
            if response.valid(r.operation_id, r.session_digest)
                && (1..=60_000).contains(&response.remaining_millis)
            {
                Ok(MobileResponse::Reviewed(bytes))
            } else {
                Err(RESPONSE_REFUSED)
            }
        }
        PrivateRequest::SignPrepared(r) if status == "signed" => {
            let response: SignedWire =
                serde_json::from_slice(&bytes).map_err(|_| RESPONSE_REFUSED)?;
            if response.valid(r.operation_id, r.session_digest) && response.handle == r.handle {
                Ok(MobileResponse::Reviewed(bytes))
            } else {
                Err(RESPONSE_REFUSED)
            }
        }
        _ => Err(RESPONSE_REFUSED),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreparedWire {
    protocol: String,
    kind: String,
    #[serde(rename = "operationId")]
    operation_id: crate::witness_bridge::Bytes32,
    #[serde(rename = "sessionDigest")]
    session_digest: crate::witness_bridge::Bytes32,
    status: String,
    handle: crate::witness_bridge::Bytes32,
    claim: crate::witness_binding::BindingClaim,
    #[serde(rename = "remainingMillis")]
    remaining_millis: u64,
}
impl PreparedWire {
    fn valid(
        &self,
        op: crate::witness_bridge::Bytes32,
        session: crate::witness_bridge::Bytes32,
    ) -> bool {
        let _ = (&self.handle, &self.claim);
        self.protocol == crate::witness_bridge::PRIVATE_PROTOCOL
            && self.kind == "proof"
            && self.status == "prepared"
            && self.operation_id == op
            && self.session_digest == session
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignedWire {
    protocol: String,
    kind: String,
    #[serde(rename = "operationId")]
    operation_id: crate::witness_bridge::Bytes32,
    #[serde(rename = "sessionDigest")]
    session_digest: crate::witness_bridge::Bytes32,
    status: String,
    handle: crate::witness_bridge::Bytes32,
    claim: crate::witness_binding::BindingClaim,
    #[serde(deserialize_with = "signature64")]
    signature: [u8; 64],
}
impl SignedWire {
    fn valid(
        &self,
        op: crate::witness_bridge::Bytes32,
        session: crate::witness_bridge::Bytes32,
    ) -> bool {
        let _ = (&self.claim, &self.signature);
        self.protocol == crate::witness_bridge::PRIVATE_PROTOCOL
            && self.kind == "proof"
            && self.status == "signed"
            && self.operation_id == op
            && self.session_digest == session
    }
}
fn signature64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<[u8; 64], D::Error> {
    let value = String::deserialize(deserializer)?;
    let bytes = STANDARD.decode(&value).map_err(D::Error::custom)?;
    if value.len() != 88 || STANDARD.encode(&bytes) != value {
        return Err(D::Error::custom("invalid_signature"));
    }
    bytes
        .try_into()
        .map_err(|_| D::Error::custom("invalid_signature"))
}

fn operation_id(request: &PrivateRequest) -> crate::witness_bridge::Bytes32 {
    match request {
        PrivateRequest::Identity(r) => r.operation_id,
        PrivateRequest::Prepare(r) => r.operation_id,
        PrivateRequest::Generate(r) => r.operation_id,
        PrivateRequest::Proof(r) => r.operation_id,
        PrivateRequest::SignPrepared(r) => r.operation_id,
        PrivateRequest::Cancel(r) => r.operation_id,
    }
}
fn expected_kind(request: &PrivateRequest) -> ResponseKind {
    match request {
        PrivateRequest::Identity(_) => ResponseKind::Identity,
        PrivateRequest::Prepare(_) => ResponseKind::Prepare,
        PrivateRequest::Generate(_) => ResponseKind::Generate,
        PrivateRequest::Proof(_) | PrivateRequest::SignPrepared(_) => ResponseKind::Proof,
        PrivateRequest::Cancel(_) => ResponseKind::Cancel,
    }
}

#[cfg(test)]
pub(crate) mod test_adapter {
    use super::*;
    pub(crate) fn dispatch<F, Fut, V>(
        request: PrivateRequest,
        transport: F,
        current: V,
    ) -> MobilePending
    where
        F: FnOnce(Value) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Value, &'static str>> + Send + 'static,
        V: Fn() -> bool + Send + Sync + 'static,
    {
        dispatch_with(request, transport, current)
    }
    pub(crate) const METHOD: &str = MOBILE_METHOD;
}
