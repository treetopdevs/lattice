#[path = "../src/witness_bridge.rs"]
mod witness_bridge;
#[path = "../src/witness_document.rs"]
mod witness_document;
#[path = "../src/witness_session.rs"]
mod witness_session;

use tauri::{webview::PageLoadEvent, Url, Webview, WebviewUrl, WebviewWindowBuilder};
use witness_bridge::{session_digest, Bytes32};
use witness_document::WitnessDocumentSession;
use witness_session::SESSION_REFUSED;

const LOCAL: &str = "http://tauri.localhost/index.html";
fn nonce(value: u8) -> Bytes32 {
    Bytes32([value; 32])
}

fn view() -> (
    tauri::App<tauri::test::MockRuntime>,
    Webview<tauri::test::MockRuntime>,
) {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let view =
        WebviewWindowBuilder::new(&app, "main", WebviewUrl::External(LOCAL.parse().unwrap()))
            .build()
            .unwrap();
    let webview = view.as_ref().clone();
    (app, webview)
}

#[test]
fn first_actual_started_and_matching_finished_establish_one_session() {
    let (_app, webview) = view();
    let url = LOCAL.parse().unwrap();
    let mut adapter = WitnessDocumentSession::new(nonce(1), || nonce(2));
    assert!(adapter.snapshot(&webview).is_err());
    assert_eq!(
        adapter.page_load(&webview, PageLoadEvent::Started, &url),
        Ok(())
    );
    assert!(adapter.snapshot(&webview).is_err());
    assert_eq!(
        adapter.page_load(&webview, PageLoadEvent::Finished, &url),
        Ok(())
    );
    assert_eq!(
        adapter.snapshot(&webview).unwrap().digest(),
        session_digest(nonce(1), nonce(2))
    );
}

#[test]
fn same_url_reload_and_late_finished_never_receive_a_replacement_ticket() {
    let (_app, webview) = view();
    let url = LOCAL.parse().unwrap();
    let mut adapter = WitnessDocumentSession::new(nonce(1), || nonce(2));
    assert!(adapter
        .page_load(&webview, PageLoadEvent::Started, &url)
        .is_ok());
    assert_eq!(
        adapter.page_load(&webview, PageLoadEvent::Started, &url),
        Err(SESSION_REFUSED)
    );
    assert_eq!(
        adapter.page_load(&webview, PageLoadEvent::Finished, &url),
        Err(SESSION_REFUSED)
    );
    assert!(adapter.snapshot(&webview).is_err());
}

#[test]
fn any_event_after_establishment_permanently_refuses_this_owner() {
    for event in [PageLoadEvent::Started, PageLoadEvent::Finished] {
        let (_app, webview) = view();
        let url = LOCAL.parse().unwrap();
        let mut adapter = WitnessDocumentSession::new(nonce(1), || nonce(2));
        adapter
            .page_load(&webview, PageLoadEvent::Started, &url)
            .unwrap();
        adapter
            .page_load(&webview, PageLoadEvent::Finished, &url)
            .unwrap();
        assert_eq!(
            adapter.page_load(&webview, event, &url),
            Err(SESSION_REFUSED)
        );
        assert!(adapter.snapshot(&webview).is_err());
    }
}

#[test]
fn lifecycle_and_destruction_latch_closed_until_fresh_owner() {
    let url = LOCAL.parse().unwrap();
    for destroy in [false, true] {
        let (_app, webview) = view();
        let mut adapter = WitnessDocumentSession::new(nonce(1), || nonce(2));
        adapter
            .page_load(&webview, PageLoadEvent::Started, &url)
            .unwrap();
        if destroy {
            adapter.owner_destroyed()
        } else {
            adapter.lifecycle_cancelled()
        }
        assert_eq!(
            adapter.page_load(&webview, PageLoadEvent::Finished, &url),
            Err(SESSION_REFUSED)
        );
        assert!(adapter.snapshot(&webview).is_err());
    }
    let (_app, webview) = view();
    let mut fresh = WitnessDocumentSession::new(nonce(1), || nonce(2));
    fresh
        .page_load(&webview, PageLoadEvent::Started, &url)
        .unwrap();
    fresh
        .page_load(&webview, PageLoadEvent::Finished, &url)
        .unwrap();
    assert!(fresh.snapshot(&webview).is_ok());
}

#[test]
fn foreign_owner_and_origin_poison_first_start() {
    let local: Url = LOCAL.parse().unwrap();
    let remote: Url = "https://example.com/".parse().unwrap();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let other = WebviewWindowBuilder::new(&app, "other", WebviewUrl::External(local.clone()))
        .build()
        .unwrap();
    let mut foreign = WitnessDocumentSession::new(nonce(1), || nonce(2));
    assert_eq!(
        foreign.page_load(other.as_ref(), PageLoadEvent::Started, &local),
        Err(SESSION_REFUSED)
    );
    assert_eq!(
        foreign.page_load(other.as_ref(), PageLoadEvent::Finished, &local),
        Err(SESSION_REFUSED)
    );

    let (_app, webview) = view();
    let mut origin = WitnessDocumentSession::new(nonce(1), || nonce(2));
    assert_eq!(
        origin.page_load(&webview, PageLoadEvent::Started, &remote),
        Err(SESSION_REFUSED)
    );
    assert_eq!(
        origin.page_load(&webview, PageLoadEvent::Started, &local),
        Err(SESSION_REFUSED)
    );

    let (_app, webview) = view();
    webview.navigate(remote.clone()).unwrap();
    let mut mismatched = WitnessDocumentSession::new(nonce(1), || nonce(2));
    assert_eq!(
        mismatched.page_load(&webview, PageLoadEvent::Started, &local),
        Err(SESSION_REFUSED)
    );
}

#[test]
fn missing_initial_started_hook_can_never_be_repaired_by_finished_or_later_start() {
    let (_app, webview) = view();
    let url = LOCAL.parse().unwrap();
    let mut adapter = WitnessDocumentSession::new(nonce(1), || nonce(2));
    assert_eq!(
        adapter.page_load(&webview, PageLoadEvent::Finished, &url),
        Err(SESSION_REFUSED)
    );
    assert_eq!(
        adapter.page_load(&webview, PageLoadEvent::Started, &url),
        Err(SESSION_REFUSED)
    );
    assert!(adapter.snapshot(&webview).is_err());
}
