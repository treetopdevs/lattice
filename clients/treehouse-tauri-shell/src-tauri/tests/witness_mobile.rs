#[path = "../src/witness_binding.rs"]
mod witness_binding;
#[path = "../src/witness_bridge.rs"]
mod witness_bridge;
#[path = "../src/witness_drain.rs"]
mod witness_drain;
#[path = "../src/witness_mobile.rs"]
mod witness_mobile;
#[path = "../src/witness_reviewed.rs"]
mod witness_reviewed;
#[path = "../src/witness_snapshot.rs"]
mod witness_snapshot;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::json;
use std::{sync::mpsc, time::Duration};
use tauri::async_runtime::{block_on, channel};
use witness_bridge::{Bytes32, IdentityRequest, PrepareRequest, PrivateRequest};
use witness_mobile::{test_adapter, MobileResponse};

fn b(value: u8) -> Bytes32 {
    Bytes32([value; 32])
}
fn request() -> PrivateRequest {
    PrivateRequest::Identity(IdentityRequest {
        protocol: (),
        operation_id: b(1),
        session_digest: b(2),
    })
}

#[test]
fn dispatch_uses_exact_object_and_accepts_closed_identity_snapshot() {
    assert_eq!(test_adapter::METHOD, "dispatch");
    let response = json!({
        "protocol":"treehouse-witness-private-v1", "kind":"identity",
        "operationId": STANDARD.encode([1u8;32]), "sessionDigest": STANDARD.encode([2u8;32]),
        "status":"snapshot", "eligible":false,
        "identity": {"creationAttemptId":STANDARD.encode([3u8;32]), "phase":"prepared",
          "generationChallenge":null, "metadata":null, "revision":"1"},
        "enrollment":null
    });
    let pending = test_adapter::dispatch(
        request(),
        move |payload| async move {
            assert!(payload.is_object());
            assert_eq!(payload["kind"], "identity");
            Ok(response)
        },
        || true,
    );
    assert!(matches!(
        block_on(pending.receive()),
        Ok(MobileResponse::Snapshot(_))
    ));
}

#[test]
fn wrong_envelope_and_nonobject_response_refuse() {
    let wrong = json!({"protocol":"treehouse-witness-private-v1","kind":"identity",
      "operationId":STANDARD.encode([9u8;32]),"status":"missing"});
    assert!(block_on(
        test_adapter::dispatch(request(), |_| async move { Ok(wrong) }, || true).receive()
    )
    .is_err());
    assert!(block_on(
        test_adapter::dispatch(request(), |_| async { Ok(json!("{}")) }, || true).receive()
    )
    .is_err());
}

#[test]
fn caller_loss_keeps_private_transport_alive_and_discards_response() {
    let (send, mut receive) = channel(1);
    let (started, ready) = mpsc::channel();
    let (drained, done) = mpsc::channel();
    let pending = test_adapter::dispatch(
        request(),
        move |_| async move {
            started.send(()).unwrap();
            let value = receive.recv().await.unwrap();
            drained.send(()).unwrap();
            Ok(value)
        },
        || true,
    );
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    drop(pending);
    send.blocking_send(json!({"status":"ignored"})).unwrap();
    done.recv_timeout(Duration::from_secs(5)).unwrap();
}

#[test]
fn session_loss_after_closed_response_suppresses_release() {
    let response = json!({
        "protocol":"treehouse-witness-private-v1", "kind":"identity",
        "operationId": STANDARD.encode([1u8;32]), "sessionDigest": STANDARD.encode([2u8;32]),
        "status":"snapshot", "eligible":false,
        "identity":{"creationAttemptId":STANDARD.encode([3u8;32]),"phase":"prepared",
          "generationChallenge":null,"metadata":null,"revision":"1"},"enrollment":null});
    let pending = test_adapter::dispatch(request(), move |_| async move { Ok(response) }, || false);
    assert!(block_on(pending.receive()).is_err());
}

#[test]
fn prepare_snapshot_cannot_substitute_creation_attempt_or_enrollment() {
    let request = PrivateRequest::Prepare(PrepareRequest {
        protocol: (),
        operation_id: b(1),
        session_digest: b(2),
        replica: "replica:test".into(),
        enrollment_id: b(4),
        recipient: b(5),
        creation_attempt_id: b(3),
    });
    let response = json!({
        "protocol":"treehouse-witness-private-v1","kind":"prepare","operationId":STANDARD.encode([1u8;32]),
        "sessionDigest":STANDARD.encode([2u8;32]),"status":"snapshot","eligible":false,
        "identity":{"creationAttemptId":STANDARD.encode([9u8;32]),"phase":"prepared",
          "generationChallenge":null,"metadata":null,"revision":"1"},
        "enrollment":{"replica":"replica:test","enrollmentId":STANDARD.encode([4u8;32]),
          "recipient":STANDARD.encode([5u8;32]),"creationAttemptId":STANDARD.encode([9u8;32])}});
    assert!(block_on(
        test_adapter::dispatch(request, move |_| async move { Ok(response) }, || true).receive()
    )
    .is_err());
}

#[test]
fn snapshot_phase_shape_extra_fields_and_response_bound_are_refused() {
    let wrong_phase = json!({
        "protocol":"treehouse-witness-private-v1","kind":"identity","operationId":STANDARD.encode([1u8;32]),
        "sessionDigest":STANDARD.encode([2u8;32]),"status":"snapshot","eligible":false,
        "identity":{"creationAttemptId":STANDARD.encode([3u8;32]),"phase":"prepared",
          "generationChallenge":STANDARD.encode([4u8;32]),"metadata":null,"revision":"1"},"enrollment":null});
    assert!(block_on(
        test_adapter::dispatch(request(), move |_| async move { Ok(wrong_phase) }, || true)
            .receive()
    )
    .is_err());

    let extra = json!({
        "protocol":"treehouse-witness-private-v1","kind":"identity","operationId":STANDARD.encode([1u8;32]),
        "sessionDigest":STANDARD.encode([2u8;32]),"status":"snapshot","eligible":false,"extra":0,
        "identity":{"creationAttemptId":STANDARD.encode([3u8;32]),"phase":"prepared",
          "generationChallenge":null,"metadata":null,"revision":"1"},"enrollment":null});
    assert!(block_on(
        test_adapter::dispatch(request(), move |_| async move { Ok(extra) }, || true).receive()
    )
    .is_err());

    let oversized = json!({"status":"snapshot", "padding":"x".repeat(128 * 1024)});
    assert!(block_on(
        test_adapter::dispatch(request(), move |_| async move { Ok(oversized) }, || true).receive()
    )
    .is_err());
}
