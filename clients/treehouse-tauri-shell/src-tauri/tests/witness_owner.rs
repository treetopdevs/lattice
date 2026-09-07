#[path = "../src/witness_bridge.rs"]
mod witness_bridge;
#[path = "../src/witness_document.rs"]
mod witness_document;
#[path = "../src/witness_entropy.rs"]
mod witness_entropy;
#[path = "../src/witness_owner.rs"]
mod witness_owner;
#[path = "../src/witness_session.rs"]
mod witness_session;

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tauri::{
    plugin::Plugin, webview::PageLoadEvent, Url, Webview, WebviewUrl, WebviewWindowBuilder,
};
use witness_bridge::{session_digest, Bytes32};
use witness_owner::{test_adapter, WitnessOwner};
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
fn owner() -> WitnessOwner {
    let mut n = 0;
    test_adapter::from_entropy(move || {
        n += 1;
        Ok(Bytes32([n; 32]))
    })
}
fn establish(owner: &WitnessOwner, view: &Webview<tauri::test::MockRuntime>) {
    let url = LOCAL.parse().unwrap();
    assert!(owner.navigation_requested(view, &url));
    owner.page_load(view, PageLoadEvent::Started, &url).unwrap();
    owner
        .page_load(view, PageLoadEvent::Finished, &url)
        .unwrap();
}
#[test]
fn real_plugin_navigation_then_loads_establish_only_preallocated_session() {
    let (_app, view) = view("main");
    let owner = Arc::new(owner());
    let navigation = owner.clone();
    let load = owner.clone();
    let mut plugin = tauri::plugin::Builder::<tauri::test::MockRuntime>::new("owner-test")
        .on_navigation(move |view, url| navigation.navigation_requested(view, url))
        .on_page_load(move |view, payload| {
            let _ = load.page_load(view, payload.event(), payload.url());
        })
        .build();
    let url = LOCAL.parse().unwrap();
    assert!(owner.snapshot(&view).is_err());
    assert!(plugin.on_navigation(&view, &url));
    owner
        .page_load(&view, PageLoadEvent::Started, &url)
        .unwrap();
    assert!(owner.snapshot(&view).is_err());
    owner
        .page_load(&view, PageLoadEvent::Finished, &url)
        .unwrap();
    let snapshot = owner.snapshot(&view).unwrap();
    assert_eq!(
        snapshot.digest(),
        session_digest(Bytes32([1; 32]), Bytes32([2; 32]))
    );
    assert!(owner.current(&view, &snapshot));
    assert!(plugin.on_navigation(&view, &url));
    assert!(!owner.current(&view, &snapshot));
    assert!(owner
        .page_load(&view, PageLoadEvent::Finished, &url)
        .is_err());
}
#[test]
fn entropy_is_allocated_twice_before_any_hook_and_failure_cannot_recover() {
    let (_app, view) = view("main");
    let url = LOCAL.parse().unwrap();
    for fail_at in [1, 2] {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let owner = test_adapter::from_entropy(move || {
            let at = count.fetch_add(1, Ordering::SeqCst) + 1;
            if at == fail_at {
                Err("native_entropy_unavailable")
            } else {
                Ok(Bytes32([1; 32]))
            }
        });
        assert_eq!(calls.load(Ordering::SeqCst), fail_at);
        assert!(owner.navigation_requested(&view, &url));
        assert!(owner
            .page_load(&view, PageLoadEvent::Started, &url)
            .is_err());
        assert!(owner
            .page_load(&view, PageLoadEvent::Finished, &url)
            .is_err());
        assert_eq!(
            owner.snapshot(&view).unwrap_err(),
            "native_entropy_unavailable"
        );
        assert_eq!(calls.load(Ordering::SeqCst), fail_at);
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let owner = test_adapter::from_entropy(move || {
        count.fetch_add(1, Ordering::SeqCst);
        Ok(Bytes32([1; 32]))
    });
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    establish(&owner, &view);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
#[test]
fn started_without_navigation_and_ambiguous_sequences_never_create_session() {
    let (_app, view) = view("main");
    let url = LOCAL.parse().unwrap();
    for sequence in [
        vec![0, 1],
        vec![2, 1, 0, 1],
        vec![2, 0, 0, 1],
        vec![2, 2, 0, 1],
        vec![2, 0, 2, 1],
    ] {
        let owner = owner();
        for event in sequence {
            match event {
                2 => {
                    assert!(owner.navigation_requested(&view, &url));
                }
                0 => {
                    let _ = owner.page_load(&view, PageLoadEvent::Started, &url);
                }
                _ => {
                    let _ = owner.page_load(&view, PageLoadEvent::Finished, &url);
                }
            }
        }
        assert!(owner.snapshot(&view).is_err());
    }
}
#[test]
fn lifecycle_destruction_poison_and_late_events_permanently_refuse() {
    let (_app, view) = view("main");
    let url = LOCAL.parse().unwrap();
    for cancel in 0..5 {
        let owner = owner();
        establish(&owner, &view);
        let snapshot = owner.snapshot(&view).unwrap();
        match cancel {
            0 => owner.lifecycle_cancelled(),
            1 => owner.owner_destroyed(),
            2 => {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    test_adapter::poison(&owner)
                }));
            }
            3 => {
                assert!(owner
                    .page_load(&view, PageLoadEvent::Started, &url)
                    .is_err());
            }
            _ => {
                assert!(owner
                    .page_load(&view, PageLoadEvent::Finished, &url)
                    .is_err());
            }
        }
        assert!(!owner.current(&view, &snapshot));
        assert!(owner.navigation_requested(&view, &url));
        assert!(owner
            .page_load(&view, PageLoadEvent::Started, &url)
            .is_err());
        assert!(owner
            .page_load(&view, PageLoadEvent::Finished, &url)
            .is_err());
    }
}
#[test]
fn foreign_origin_owner_and_equal_nonce_replacement_cannot_reuse_snapshot() {
    let (_app, view) = view("main");
    let first = owner();
    establish(&first, &view);
    let snapshot = first.snapshot(&view).unwrap();
    let second = owner();
    establish(&second, &view);
    assert!(!second.current(&view, &snapshot));
    for url in [
        "https://tauri.localhost/",
        "http://tauri.localhost:8080/",
        "http://user@tauri.localhost/",
        "http://127.0.0.1:5175/",
    ] {
        let rejected = owner();
        assert!(rejected.navigation_requested(&view, &url.parse().unwrap()));
        assert!(rejected.snapshot(&view).is_err());
    }
    let (_other, foreign) = view_other();
    let rejected = owner();
    assert!(rejected.navigation_requested(&foreign, &LOCAL.parse().unwrap()));
    assert!(rejected
        .page_load(&foreign, PageLoadEvent::Started, &LOCAL.parse().unwrap())
        .is_err());
    view.navigate("https://example.com/".parse().unwrap())
        .unwrap();
    assert!(!first.current(&view, &snapshot));
}
fn view_other() -> (
    tauri::App<tauri::test::MockRuntime>,
    Webview<tauri::test::MockRuntime>,
) {
    view("other")
}
