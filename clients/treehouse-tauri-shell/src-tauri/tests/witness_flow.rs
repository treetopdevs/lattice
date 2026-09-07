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

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signer as _, SigningKey};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{async_runtime::block_on, webview::PageLoadEvent, WebviewUrl, WebviewWindowBuilder};
use witness_bridge::{
    encode_terminal_response, Bytes32, ResponseKind, TerminalResponse, TerminalStatus,
};

#[test]
fn identity_missing_runs_through_owned_session_operation_and_private_transport() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = WebviewWindowBuilder::new(
        &app,
        "main",
        WebviewUrl::External("http://tauri.localhost/".parse().unwrap()),
    )
    .build()
    .unwrap();
    let view = window.as_ref().clone();
    let owner = Arc::new(witness_owner::test_adapter::from_entropy({
        let mut n = 0u8;
        move || {
            n += 1;
            Ok(Bytes32([n; 32]))
        }
    }));
    let url = "http://tauri.localhost/".parse().unwrap();
    owner.navigation_requested(&view, &url);
    owner
        .page_load(&view, PageLoadEvent::Started, &url)
        .unwrap();
    owner
        .page_load(&view, PageLoadEvent::Finished, &url)
        .unwrap();
    let operations = Arc::new(witness_operation::test_adapter::registry(|| {
        Ok(Bytes32([9; 32]))
    }));
    let flow = witness_flow::test_adapter::flow(owner, operations, |request, current| {
        let operation_id = match &request {
            witness_bridge::PrivateRequest::Identity(value) => value.operation_id,
            _ => panic!("unexpected private request"),
        };
        witness_mobile::test_adapter::dispatch(
            request,
            move |_| async move {
                let terminal = TerminalResponse::terminal(
                    ResponseKind::Identity,
                    operation_id,
                    TerminalStatus::Missing,
                )
                .unwrap();
                Ok(serde_json::from_slice(&encode_terminal_response(&terminal).unwrap()).unwrap())
            },
            move || current(),
        )
    });
    let pending = flow
        .execute(
            view.clone(),
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| Ok(())),
        )
        .unwrap();
    assert_eq!(
        block_on(pending.receive()).unwrap(),
        br#"{"status":"missing","version":1}"#
    );
    let immediate = flow
        .execute(
            view,
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| Ok(())),
        )
        .expect("terminal publication must include registry completion");
    assert!(block_on(immediate.receive()).is_ok());
}

#[test]
fn completed_identity_is_reviewed_then_presence_signed_and_publicly_projected() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = WebviewWindowBuilder::new(
        &app,
        "main",
        WebviewUrl::External("http://tauri.localhost/".parse().unwrap()),
    )
    .build()
    .unwrap();
    let view = window.as_ref().clone();
    let owner = Arc::new(witness_owner::test_adapter::from_entropy({
        let mut n = 0;
        move || {
            n += 1;
            Ok(Bytes32([n; 32]))
        }
    }));
    let url = "http://tauri.localhost/".parse().unwrap();
    owner.navigation_requested(&view, &url);
    owner
        .page_load(&view, PageLoadEvent::Started, &url)
        .unwrap();
    owner
        .page_load(&view, PageLoadEvent::Finished, &url)
        .unwrap();
    let session = owner.snapshot(&view).unwrap().digest();
    let operations = Arc::new(witness_operation::test_adapter::registry(|| {
        Ok(Bytes32([9; 32]))
    }));
    let signer = Arc::new(SigningKey::from_bytes(&[11; 32]));
    let public_key = signer.verifying_key().to_bytes();
    let challenge = Bytes32([4; 32]);
    let attempt = Bytes32([3; 32]);
    let saved_claim = Arc::new(Mutex::new(None));
    let flow = witness_flow::test_adapter::flow(owner, operations, {
        let signer = signer.clone();
        let saved_claim = saved_claim.clone();
        move |request, current| {
            let signer = signer.clone();
            let saved_claim = saved_claim.clone();
            witness_mobile::test_adapter::dispatch(
                request,
                move |payload| async move {
                    let kind = payload["kind"].as_str().unwrap();
                    let op = payload["operationId"].clone();
                    let session = payload["sessionDigest"].clone();
                    let response = match kind {
                        "identity" => {
                            let mut spki = vec![
                                0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21,
                                0x00,
                            ];
                            spki.extend(public_key);
                            json!({"protocol":witness_bridge::PRIVATE_PROTOCOL,"kind":"identity","operationId":op,"sessionDigest":session,"status":"snapshot","eligible":false,
                            "identity":{"creationAttemptId":STANDARD.encode(attempt.0),"phase":"generated_unvalidated","generationChallenge":STANDARD.encode(challenge.0),
                            "metadata":{"publicKey":STANDARD.encode(public_key),"spki":STANDARD.encode(spki),"appSignerSha256":STANDARD.encode([5;32]),"creationVersionCode":"1","certificateChain":[STANDARD.encode([1])]},"revision":"1"},"enrollment":null})
                        }
                        "proof" if payload.get("handle").is_none() => {
                            let digest: [u8; 32] = Sha256::digest(challenge.0).into();
                            let claim = json!({"replica":"replica:test","enrollmentId":payload["enrollmentId"],"recipient":payload["recipient"],"creationAttemptId":STANDARD.encode(attempt.0),
                            "actualWitnessPublicKey":STANDARD.encode(public_key),"generationChallengeDigest":STANDARD.encode(digest),"freshValidatorNonce":payload["freshValidatorNonce"],
                            "nativeRandomNonce":payload["nativeNonce"],"nativeCallerSessionDigest":session});
                            *saved_claim.lock().unwrap() = Some(claim.clone());
                            json!({"protocol":witness_bridge::PRIVATE_PROTOCOL,"kind":"proof","operationId":op,"sessionDigest":session,"status":"prepared","handle":STANDARD.encode([8;32]),"claim":claim,"remainingMillis":60000})
                        }
                        "sign_prepared" => {
                            let claim = saved_claim.lock().unwrap().clone().unwrap();
                            let parsed =
                                witness_binding::BindingClaim::from_public_json(&claim.to_string())
                                    .unwrap();
                            let signature = signer.sign(&parsed.canonical_bytes()).to_bytes();
                            json!({"protocol":witness_bridge::PRIVATE_PROTOCOL,"kind":"proof","operationId":op,"sessionDigest":session,"status":"signed","handle":payload["handle"],"claim":claim,"signature":STANDARD.encode(signature)})
                        }
                        _ => panic!("unexpected phase {kind}"),
                    };
                    Ok(response)
                },
                move || current(),
            )
        }
    });
    let phases = Arc::new(Mutex::new(Vec::new()));
    let observed = phases.clone();
    let pending = flow
        .execute(
            view,
            witness_public::PublicRequest::Proof(witness_public::ProofPublicRequest {
                replica: "replica:test".into(),
                enrollment_id: Bytes32([1; 32]),
                recipient: Bytes32([2; 32]),
                fresh_validator_nonce: Bytes32([6; 32]),
            }),
            Arc::new(move |id, phase| {
                observed.lock().unwrap().push((id, phase));
                Ok(())
            }),
        )
        .unwrap();
    let result = block_on(pending.receive()).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&result).unwrap();
    assert_eq!(value["status"], "signed");
    assert_eq!(value["eligible"], false);
    assert_eq!(
        *phases.lock().unwrap(),
        vec![
            (Bytes32([9; 32]), witness_flow::PendingPhase::Review),
            (Bytes32([9; 32]), witness_flow::PendingPhase::Presence)
        ]
    );
    assert_eq!(
        session,
        Bytes32(witness_bridge::session_digest(Bytes32([1; 32]), Bytes32([2; 32])).0)
    );
}

#[test]
fn dropping_caller_sends_private_cancel_but_holds_slot_until_blocked_call_drains() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = WebviewWindowBuilder::new(
        &app,
        "main",
        WebviewUrl::External("http://tauri.localhost/".parse().unwrap()),
    )
    .build()
    .unwrap();
    let view = window.as_ref().clone();
    let owner = Arc::new(witness_owner::test_adapter::from_entropy({
        let mut n = 0u8;
        move || {
            n += 1;
            Ok(Bytes32([n; 32]))
        }
    }));
    let url = "http://tauri.localhost/".parse().unwrap();
    owner.navigation_requested(&view, &url);
    owner
        .page_load(&view, PageLoadEvent::Started, &url)
        .unwrap();
    owner
        .page_load(&view, PageLoadEvent::Finished, &url)
        .unwrap();
    let operations = Arc::new(witness_operation::test_adapter::registry(|| {
        Ok(Bytes32([9; 32]))
    }));
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release = Arc::new(Mutex::new(Some(release_rx)));
    let (cancel_launch_tx, cancel_launch_rx) = mpsc::channel();
    let (register_tx, register_rx) = mpsc::channel();
    let register = Arc::new(Mutex::new(Some(register_rx)));
    let (cancel_release_tx, cancel_release_rx) = mpsc::channel();
    let cancel_release = Arc::new(Mutex::new(Some(cancel_release_rx)));
    let (kinds_tx, kinds_rx) = mpsc::channel();
    let flow = witness_flow::test_adapter::flow(owner, operations, move |request, current| {
        let release = release.clone();
        let register = register.clone();
        let cancel_release = cancel_release.clone();
        let started = started_tx.clone();
        let cancel_launch = cancel_launch_tx.clone();
        let kinds = kinds_tx.clone();
        let (kind, operation_id) = match &request {
            witness_bridge::PrivateRequest::Identity(value) => {
                (ResponseKind::Identity, value.operation_id)
            }
            witness_bridge::PrivateRequest::Cancel(value) => {
                (ResponseKind::Cancel, value.operation_id)
            }
            _ => panic!("unexpected later phase"),
        };
        kinds.send(kind).unwrap();
        let pending = witness_mobile::test_adapter::dispatch(
            request,
            move |_| async move {
                let status = if kind == ResponseKind::Identity {
                    if let Some(release) = release.lock().unwrap().take() {
                        started.send(()).unwrap();
                        release.recv().unwrap();
                    }
                    TerminalStatus::Missing
                } else {
                    cancel_release
                        .lock()
                        .unwrap()
                        .take()
                        .unwrap()
                        .recv()
                        .unwrap();
                    TerminalStatus::Cancelled
                };
                let terminal = TerminalResponse::terminal(kind, operation_id, status).unwrap();
                Ok(serde_json::from_slice(&encode_terminal_response(&terminal).unwrap()).unwrap())
            },
            move || current(),
        );
        if kind == ResponseKind::Cancel {
            cancel_launch.send(()).unwrap();
            register.lock().unwrap().take().unwrap().recv().unwrap();
        }
        pending
    });
    let pending = flow
        .execute(
            view.clone(),
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| Ok(())),
        )
        .unwrap();
    started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let (drop_returned_tx, drop_returned_rx) = mpsc::channel();
    let dropper = std::thread::spawn(move || {
        drop(pending);
        drop_returned_tx.send(()).unwrap();
    });
    assert_eq!(
        kinds_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        ResponseKind::Identity
    );
    assert_eq!(
        kinds_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        ResponseKind::Cancel
    );
    cancel_launch_rx
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    drop_returned_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("caller drop must return while cancel dispatch factory is blocked");
    // Let the original callback finish while start_cancel is between launch
    // and drain registration. The operation must remain reserved.
    release_tx.send(()).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    assert!(flow
        .execute(
            view.clone(),
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| Ok(()))
        )
        .is_err());
    register_tx.send(()).unwrap();
    dropper.join().unwrap();
    assert!(flow
        .execute(
            view.clone(),
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| Ok(()))
        )
        .is_err());
    cancel_release_tx.send(()).unwrap();
    for _ in 0..100 {
        if let Ok(next) = flow.execute(
            view.clone(),
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| Ok(())),
        ) {
            assert!(block_on(next.receive()).is_ok());
            return;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    panic!("operation slot was not released after the original callback drained");
}

#[test]
fn malformed_prepared_claim_dispatches_cancel_and_never_reaches_signing() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = WebviewWindowBuilder::new(
        &app,
        "main",
        WebviewUrl::External("http://tauri.localhost/".parse().unwrap()),
    )
    .build()
    .unwrap();
    let view = window.as_ref().clone();
    let owner = Arc::new(witness_owner::test_adapter::from_entropy({
        let mut n = 0u8;
        move || {
            n += 1;
            Ok(Bytes32([n; 32]))
        }
    }));
    let url = "http://tauri.localhost/".parse().unwrap();
    owner.navigation_requested(&view, &url);
    owner
        .page_load(&view, PageLoadEvent::Started, &url)
        .unwrap();
    owner
        .page_load(&view, PageLoadEvent::Finished, &url)
        .unwrap();
    let operations = Arc::new(witness_operation::test_adapter::registry(|| {
        Ok(Bytes32([9; 32]))
    }));
    let key = SigningKey::from_bytes(&[11; 32]).verifying_key().to_bytes();
    let attempt = Bytes32([3; 32]);
    let challenge = Bytes32([4; 32]);
    let (kinds_tx, kinds_rx) = mpsc::channel();
    let flow = witness_flow::test_adapter::flow(owner, operations, move |request, current| {
        let kinds = kinds_tx.clone();
        witness_mobile::test_adapter::dispatch(
            request,
            move |payload| async move {
                let kind = payload["kind"].as_str().unwrap();
                kinds.send(kind.to_owned()).unwrap();
                let op = payload["operationId"].clone();
                let session = payload["sessionDigest"].clone();
                let response = match kind {
                    "identity" => {
                        let mut spki = vec![
                            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
                        ];
                        spki.extend(key);
                        json!({"protocol":witness_bridge::PRIVATE_PROTOCOL,"kind":"identity","operationId":op,"sessionDigest":session,"status":"snapshot","eligible":false,
                          "identity":{"creationAttemptId":STANDARD.encode(attempt.0),"phase":"generated_unvalidated","generationChallenge":STANDARD.encode(challenge.0),
                          "metadata":{"publicKey":STANDARD.encode(key),"spki":STANDARD.encode(spki),"appSignerSha256":STANDARD.encode([5;32]),"creationVersionCode":"1","certificateChain":[STANDARD.encode([1])]},"revision":"1"},"enrollment":null})
                    }
                    "proof" => {
                        let digest: [u8; 32] = Sha256::digest(challenge.0).into();
                        // The recipient is deliberately different from the reviewed public request.
                        let claim = json!({"replica":"replica:test","enrollmentId":payload["enrollmentId"],"recipient":STANDARD.encode([99;32]),"creationAttemptId":STANDARD.encode(attempt.0),
                          "actualWitnessPublicKey":STANDARD.encode(key),"generationChallengeDigest":STANDARD.encode(digest),"freshValidatorNonce":payload["freshValidatorNonce"],
                          "nativeRandomNonce":payload["nativeNonce"],"nativeCallerSessionDigest":session});
                        json!({"protocol":witness_bridge::PRIVATE_PROTOCOL,"kind":"proof","operationId":op,"sessionDigest":session,"status":"prepared","handle":STANDARD.encode([8;32]),"claim":claim,"remainingMillis":60000})
                    }
                    "cancel" => {
                        json!({"protocol":witness_bridge::PRIVATE_PROTOCOL,"kind":"cancel","operationId":op,"sessionDigest":session,"status":"cancelled"})
                    }
                    "sign_prepared" => panic!("malformed prepared response reached signing"),
                    _ => panic!("unexpected private phase"),
                };
                Ok(response)
            },
            move || current(),
        )
    });
    let pending = flow
        .execute(
            view.clone(),
            witness_public::PublicRequest::Proof(witness_public::ProofPublicRequest {
                replica: "replica:test".into(),
                enrollment_id: Bytes32([1; 32]),
                recipient: Bytes32([2; 32]),
                fresh_validator_nonce: Bytes32([6; 32]),
            }),
            Arc::new(|_, _| Ok(())),
        )
        .unwrap();
    assert!(block_on(pending.receive()).is_err());
    assert_eq!(
        kinds_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        "identity"
    );
    assert_eq!(
        kinds_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        "proof"
    );
    assert_eq!(
        kinds_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        "cancel"
    );
    for _ in 0..100 {
        if let Ok(next) = flow.execute(
            view.clone(),
            witness_public::PublicRequest::Proof(witness_public::ProofPublicRequest {
                replica: "replica:test".into(),
                enrollment_id: Bytes32([1; 32]),
                recipient: Bytes32([2; 32]),
                fresh_validator_nonce: Bytes32([6; 32]),
            }),
            Arc::new(|_, _| Err("emit_failed")),
        ) {
            assert!(block_on(next.receive()).is_err());
            assert_eq!(
                kinds_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
                "identity"
            );
            assert_eq!(
                kinds_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
                "cancel"
            );
            return;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    panic!("malformed prepared cleanup did not release after cancel drained");
}

#[test]
fn unknown_cancel_dispatch_failure_is_a_failed_drain_and_retains_slot() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = WebviewWindowBuilder::new(
        &app,
        "main",
        WebviewUrl::External("http://tauri.localhost/".parse().unwrap()),
    )
    .build()
    .unwrap();
    let view = window.as_ref().clone();
    let owner = Arc::new(witness_owner::test_adapter::from_entropy({
        let mut n = 0u8;
        move || {
            n += 1;
            Ok(Bytes32([n; 32]))
        }
    }));
    let url = "http://tauri.localhost/".parse().unwrap();
    owner.navigation_requested(&view, &url);
    owner
        .page_load(&view, PageLoadEvent::Started, &url)
        .unwrap();
    owner
        .page_load(&view, PageLoadEvent::Finished, &url)
        .unwrap();
    let operations = Arc::new(witness_operation::test_adapter::registry(|| {
        Ok(Bytes32([9; 32]))
    }));
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release = Arc::new(Mutex::new(Some(release_rx)));
    let flow = witness_flow::test_adapter::flow(owner, operations, move |request, current| {
        if matches!(request, witness_bridge::PrivateRequest::Cancel(_)) {
            panic!("unknown whether a mobile callback launched before transport panic");
        }
        let release = release.clone();
        let started = started_tx.clone();
        let operation_id = match &request {
            witness_bridge::PrivateRequest::Identity(value) => value.operation_id,
            _ => panic!("unexpected request"),
        };
        witness_mobile::test_adapter::dispatch(
            request,
            move |_| async move {
                started.send(()).unwrap();
                release.lock().unwrap().take().unwrap().recv().unwrap();
                let terminal = TerminalResponse::terminal(
                    ResponseKind::Identity,
                    operation_id,
                    TerminalStatus::Missing,
                )
                .unwrap();
                Ok(serde_json::from_slice(&encode_terminal_response(&terminal).unwrap()).unwrap())
            },
            move || current(),
        )
    });
    let pending = flow
        .execute(
            view.clone(),
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| Ok(())),
        )
        .unwrap();
    started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    drop(pending);
    release_tx.send(()).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    assert!(flow
        .execute(
            view,
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| Ok(())),
        )
        .is_err());
}

#[test]
fn known_unlaunched_cancel_entropy_panic_does_not_wedge_after_original_drain() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = WebviewWindowBuilder::new(
        &app,
        "main",
        WebviewUrl::External("http://tauri.localhost/".parse().unwrap()),
    )
    .build()
    .unwrap();
    let view = window.as_ref().clone();
    let owner = Arc::new(witness_owner::test_adapter::from_entropy({
        let mut n = 0u8;
        move || {
            n += 1;
            Ok(Bytes32([n; 32]))
        }
    }));
    let url = "http://tauri.localhost/".parse().unwrap();
    owner.navigation_requested(&view, &url);
    owner
        .page_load(&view, PageLoadEvent::Started, &url)
        .unwrap();
    owner
        .page_load(&view, PageLoadEvent::Finished, &url)
        .unwrap();
    let operations = Arc::new(witness_operation::test_adapter::registry(|| {
        Ok(Bytes32([9; 32]))
    }));
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release = Arc::new(Mutex::new(Some(release_rx)));
    let flow = witness_flow::test_adapter::flow_with_cancel_entropy(
        owner,
        operations,
        move |request, current| {
            let release = release.clone();
            let started = started_tx.clone();
            let operation_id = match &request {
                witness_bridge::PrivateRequest::Identity(v) => v.operation_id,
                _ => panic!("cancel must not launch without entropy"),
            };
            witness_mobile::test_adapter::dispatch(
                request,
                move |_| async move {
                    if let Some(gate) = release.lock().unwrap().take() {
                        started.send(()).unwrap();
                        gate.recv().unwrap();
                    }
                    let terminal = TerminalResponse::terminal(
                        ResponseKind::Identity,
                        operation_id,
                        TerminalStatus::Missing,
                    )
                    .unwrap();
                    Ok(
                        serde_json::from_slice(&encode_terminal_response(&terminal).unwrap())
                            .unwrap(),
                    )
                },
                move || current(),
            )
        },
        || panic!("cancel entropy source panic before launch"),
    );
    let pending = flow
        .execute(
            view.clone(),
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| Ok(())),
        )
        .unwrap();
    started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    drop(pending);
    release_tx.send(()).unwrap();
    for _ in 0..100 {
        if let Ok(next) = flow.execute(
            view.clone(),
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| Ok(())),
        ) {
            assert!(block_on(next.receive()).is_ok());
            return;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    panic!("known no-launch entropy failure wedged the registry");
}

#[test]
fn lifecycle_hook_latches_owner_and_cancels_without_a_retrieved_webview() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = WebviewWindowBuilder::new(
        &app,
        "main",
        WebviewUrl::External("http://tauri.localhost/".parse().unwrap()),
    )
    .build()
    .unwrap();
    let view = window.as_ref().clone();
    let owner = Arc::new(witness_owner::test_adapter::from_entropy({
        let mut n = 0u8;
        move || {
            n += 1;
            Ok(Bytes32([n; 32]))
        }
    }));
    let url = "http://tauri.localhost/".parse().unwrap();
    owner.navigation_requested(&view, &url);
    owner
        .page_load(&view, PageLoadEvent::Started, &url)
        .unwrap();
    owner
        .page_load(&view, PageLoadEvent::Finished, &url)
        .unwrap();
    let operations = Arc::new(witness_operation::test_adapter::registry(|| {
        Ok(Bytes32([9; 32]))
    }));
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release = Arc::new(Mutex::new(Some(release_rx)));
    let (kinds_tx, kinds_rx) = mpsc::channel();
    let (factory_enter_tx, factory_enter_rx) = mpsc::channel();
    let (factory_release_tx, factory_release_rx) = mpsc::channel();
    let factory_release = Arc::new(Mutex::new(Some(factory_release_rx)));
    let flow = witness_flow::test_adapter::flow(owner, operations, move |request, current| {
        let release = release.clone();
        let started = started_tx.clone();
        let factory_release = factory_release.clone();
        let (kind, id) = match &request {
            witness_bridge::PrivateRequest::Identity(v) => (ResponseKind::Identity, v.operation_id),
            witness_bridge::PrivateRequest::Cancel(v) => (ResponseKind::Cancel, v.operation_id),
            _ => panic!("unexpected"),
        };
        kinds_tx.send(kind).unwrap();
        if kind == ResponseKind::Cancel {
            factory_enter_tx.send(()).unwrap();
            factory_release
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .recv()
                .unwrap();
        }
        witness_mobile::test_adapter::dispatch(
            request,
            move |_| async move {
                if kind == ResponseKind::Identity {
                    started.send(()).unwrap();
                    release.lock().unwrap().take().unwrap().recv().unwrap();
                }
                let status = if kind == ResponseKind::Identity {
                    TerminalStatus::Missing
                } else {
                    TerminalStatus::Cancelled
                };
                let terminal = TerminalResponse::terminal(kind, id, status).unwrap();
                Ok(serde_json::from_slice(&encode_terminal_response(&terminal).unwrap()).unwrap())
            },
            move || current(),
        )
    });
    let pending = flow
        .execute(
            view.clone(),
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| Ok(())),
        )
        .unwrap();
    started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    flow.lifecycle_invalidated();
    factory_enter_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("cancel factory must run on the owned background task");
    factory_release_tx.send(()).unwrap();
    assert_eq!(
        kinds_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        ResponseKind::Identity
    );
    assert_eq!(
        kinds_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        ResponseKind::Cancel
    );
    release_tx.send(()).unwrap();
    assert!(block_on(pending.receive()).is_err());
    assert!(flow
        .execute(
            view,
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| Ok(()))
        )
        .is_err());
}
