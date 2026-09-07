#[path = "../src/witness_bridge.rs"]
mod witness_bridge;
#[path = "../src/witness_document.rs"]
mod witness_document;
#[path = "../src/witness_entropy.rs"]
mod witness_entropy;
#[path = "../src/witness_operation.rs"]
mod witness_operation;
#[path = "../src/witness_owner.rs"]
mod witness_owner;
#[path = "../src/witness_session.rs"]
mod witness_session;

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tauri::{webview::PageLoadEvent, Webview, WebviewUrl, WebviewWindowBuilder};
use witness_bridge::Bytes32;
use witness_operation::test_adapter;
use witness_owner::{test_adapter as owner_adapter, WitnessOwner};

const LOCAL: &str = "http://tauri.localhost/index.html";

fn view(
    label: &str,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    Webview<tauri::test::MockRuntime>,
) {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let view = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(LOCAL.parse().unwrap()))
        .build()
        .unwrap();
    (app, view.as_ref().clone())
}

fn owner(seed: u8) -> WitnessOwner {
    let mut n = seed;
    owner_adapter::from_entropy(move || {
        n += 1;
        Ok(Bytes32([n; 32]))
    })
}

fn snapshot(
    owner: &WitnessOwner,
    view: &Webview<tauri::test::MockRuntime>,
) -> witness_session::SessionSnapshot {
    let url = LOCAL.parse().unwrap();
    assert!(owner.navigation_requested(view, &url));
    owner.page_load(view, PageLoadEvent::Started, &url).unwrap();
    owner
        .page_load(view, PageLoadEvent::Finished, &url)
        .unwrap();
    owner.snapshot(view).unwrap()
}

#[test]
fn operation_is_owned_by_exact_native_session_until_original_task_completes() {
    let (_app, view) = view("main");
    let first_owner = owner(0);
    let first = snapshot(&first_owner, &view);
    let registry = test_adapter::registry(|| Ok(Bytes32([9; 32])));
    let token = registry.begin(&first).unwrap();
    assert_eq!(token.id(), Bytes32([9; 32]));
    assert!(registry.current(&token, &first));
    assert!(registry.begin(&first).is_err());

    let target = registry.cancel(token.id(), &first).unwrap();
    assert_eq!(target.id(), token.id());
    assert_eq!(target.session_digest(), first.digest());
    assert!(!registry.current(&token, &first));
    assert!(registry.begin(&first).is_err());
    assert!(registry.complete(&token));

    let replacement = registry.begin(&first).unwrap();
    assert!(!registry.complete(&token));
    assert!(registry.current(&replacement, &first));
}

#[test]
fn wrong_id_or_owner_cannot_cancel_and_lifecycle_returns_one_immutable_target() {
    let (_app, view) = view("main");
    let first = snapshot(&owner(0), &view);
    let second = snapshot(&owner(0), &view);
    let registry = test_adapter::registry(|| Ok(Bytes32([7; 32])));
    let token = registry.begin(&first).unwrap();
    assert_eq!(registry.cancel(Bytes32([8; 32]), &first), None);
    assert_eq!(registry.cancel(token.id(), &second), None);
    assert!(registry.current(&token, &first));
    let target = registry.lifecycle_invalidated().unwrap();
    assert_eq!(target.id(), Bytes32([7; 32]));
    assert_eq!(target.session_digest(), first.digest());
    assert_eq!(registry.lifecycle_invalidated(), None);
    assert!(registry.begin(&first).is_err());
}

#[test]
fn entropy_failure_is_fail_closed_and_only_attempted_while_idle() {
    let (_app, view) = view("main");
    let current = snapshot(&owner(0), &view);
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let registry = test_adapter::registry(move || {
        let call = observed.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            Ok(Bytes32([3; 32]))
        } else {
            Err("native_entropy_unavailable")
        }
    });
    let token = registry.begin(&current).unwrap();
    assert!(registry.begin(&current).is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(registry.complete(&token));
    assert!(matches!(
        registry.begin(&current),
        Err("native_entropy_unavailable")
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(registry.lifecycle_invalidated(), None);
}
