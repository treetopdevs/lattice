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
            view,
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| {}),
        )
        .unwrap();
    assert_eq!(
        block_on(pending.receive()).unwrap(),
        br#"{"status":"missing","version":1}"#
    );
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
            Arc::new(move |id, phase| observed.lock().unwrap().push((id, phase))),
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
    let (kinds_tx, kinds_rx) = mpsc::channel();
    let flow = witness_flow::test_adapter::flow(owner, operations, move |request, current| {
        let release = release.clone();
        let started = started_tx.clone();
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
        witness_mobile::test_adapter::dispatch(
            request,
            move |_| async move {
                let status = if kind == ResponseKind::Identity {
                    started.send(()).unwrap();
                    release.lock().unwrap().take().unwrap().recv().unwrap();
                    TerminalStatus::Missing
                } else {
                    TerminalStatus::Cancelled
                };
                let terminal = TerminalResponse::terminal(kind, operation_id, status).unwrap();
                Ok(serde_json::from_slice(&encode_terminal_response(&terminal).unwrap()).unwrap())
            },
            move || current(),
        )
    });
    let pending = flow
        .execute(
            view.clone(),
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| {}),
        )
        .unwrap();
    started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    drop(pending);
    assert_eq!(
        kinds_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        ResponseKind::Identity
    );
    assert_eq!(
        kinds_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
        ResponseKind::Cancel
    );
    assert!(flow
        .execute(
            view.clone(),
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| {})
        )
        .is_err());
    release_tx.send(()).unwrap();
    for _ in 0..100 {
        if let Ok(next) = flow.execute(
            view.clone(),
            witness_public::PublicRequest::Identity,
            Arc::new(|_, _| {}),
        ) {
            drop(next);
            return;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    panic!("operation slot was not released after the original callback drained");
}
