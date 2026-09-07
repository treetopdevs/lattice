#[path = "../src/witness_bridge.rs"]
mod witness_bridge;
#[path = "../src/witness_session.rs"]
mod witness_session;

use witness_bridge::{session_digest, Bytes32};
use witness_session::{test_adapter::*, WitnessSession, SESSION_REFUSED};

const LOCAL: &str = "http://tauri.localhost/index.html";
fn local() -> Facts {
    Facts("main", "main", LOCAL)
}
fn nonce(value: u8) -> Bytes32 {
    Bytes32([value; 32])
}
fn complete(session: &mut WitnessSession, value: u8) {
    let ticket = start(session, &local(), LOCAL).unwrap();
    finish(session, &local(), ticket, LOCAL, nonce(value)).unwrap();
}

#[test]
fn normal_native_navigation_load_completion_rotates_snapshot() {
    let mut session = WitnessSession::new(nonce(1));
    assert_eq!(capture(&session, &local()), Err(SESSION_REFUSED));
    session.navigation_started();
    let ticket = start(&mut session, &local(), LOCAL).unwrap();
    assert_eq!(capture(&session, &local()), Err(SESSION_REFUSED));
    finish(&mut session, &local(), ticket, LOCAL, nonce(2)).unwrap();
    let first = capture(&session, &local()).unwrap();
    assert_eq!(first.digest(), session_digest(nonce(1), nonce(2)));
    session.navigation_started();
    assert_eq!(capture(&session, &local()), Err(SESSION_REFUSED));
    complete(&mut session, 3);
    let second = capture(&session, &local()).unwrap();
    assert_ne!(first, second);
    assert_ne!(first.digest(), second.digest());
}

#[test]
fn actual_window_and_webview_labels_and_current_origin_are_required() {
    let mut session = WitnessSession::new(nonce(1));
    complete(&mut session, 2);
    for facts in [
        Facts("other", "main", LOCAL),
        Facts("main", "other", LOCAL),
        Facts("main", "main", "https://tauri.localhost/index.html"),
        Facts("main", "main", "http://127.0.0.1:5175/index.html"),
        Facts("main", "main", "http://tauri.localhost:81/index.html"),
        Facts("main", "main", "http://user@tauri.localhost/index.html"),
        Facts(
            "main",
            "main",
            "http://user:pass@tauri.localhost/index.html",
        ),
        Facts("main", "main", "http://tauri.localhost.evil/index.html"),
        Facts("main", "main", "http://tauri.localhost./index.html"),
        Facts("main", "main", "http://tauri.localhost/other.html"),
    ] {
        assert_eq!(capture(&session, &facts), Err(SESSION_REFUSED));
    }
}

#[test]
fn wrong_owner_or_nonlocal_load_start_never_establishes_a_session() {
    for facts in [Facts("other", "main", LOCAL), Facts("main", "other", LOCAL)] {
        let mut session = WitnessSession::new(nonce(1));
        assert!(start(&mut session, &facts, LOCAL).is_err());
        assert!(capture(&session, &local()).is_err());
    }
    for target in [
        "https://example.com/",
        "http://user@tauri.localhost/",
        "http://tauri.localhost:81/",
    ] {
        let mut session = WitnessSession::new(nonce(1));
        assert!(start(&mut session, &local(), target).is_err());
    }
}

#[test]
fn mismatched_completion_or_current_document_refuses() {
    for (facts, event) in [
        (
            Facts("main", "main", "http://tauri.localhost/other.html"),
            LOCAL,
        ),
        (local(), "http://tauri.localhost/other.html"),
        (Facts("other", "main", LOCAL), LOCAL),
        (Facts("main", "main", "https://example.com/"), LOCAL),
    ] {
        let mut session = WitnessSession::new(nonce(1));
        let ticket = start(&mut session, &local(), LOCAL).unwrap();
        assert_eq!(
            finish(&mut session, &facts, ticket, event, nonce(2)),
            Err(SESSION_REFUSED)
        );
        assert!(capture(&session, &local()).is_err());
    }
}

#[test]
fn overlapping_same_url_loads_and_old_tickets_latch_closed() {
    let mut session = WitnessSession::new(nonce(1));
    let old = start(&mut session, &local(), LOCAL).unwrap();
    assert!(start(&mut session, &local(), LOCAL).is_err());
    assert_eq!(
        finish(&mut session, &local(), old, LOCAL, nonce(2)),
        Err(SESSION_REFUSED)
    );
    session.navigation_started();
    assert!(start(&mut session, &local(), LOCAL).is_err());
    assert!(capture(&session, &local()).is_err());
}

#[test]
fn navigation_cancellation_and_destruction_refuse_pending_results() {
    for invalidate in [
        WitnessSession::navigation_started,
        WitnessSession::lifecycle_cancelled,
        WitnessSession::owner_destroyed,
    ] {
        let mut session = WitnessSession::new(nonce(1));
        let old = start(&mut session, &local(), LOCAL).unwrap();
        invalidate(&mut session);
        assert_eq!(
            finish(&mut session, &local(), old, LOCAL, nonce(2)),
            Err(SESSION_REFUSED)
        );
        assert!(capture(&session, &local()).is_err());
    }
    let mut session = WitnessSession::new(nonce(1));
    complete(&mut session, 2);
    session.lifecycle_cancelled();
    assert!(capture(&session, &local()).is_err());
    complete(&mut session, 3);
    session.owner_destroyed();
    assert!(start(&mut session, &local(), LOCAL).is_err());
}

#[test]
fn actual_tauri_mock_webview_adapter_rechecks_url_and_invalidates_old_snapshots() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(
        &app,
        "main",
        tauri::WebviewUrl::External(LOCAL.parse().unwrap()),
    )
    .build()
    .unwrap();
    let mut session = WitnessSession::new(nonce(1));
    assert!(session.snapshot(view.as_ref()).is_err());
    let url = LOCAL.parse().unwrap();
    session.navigation_started();
    let ticket = session.page_load_started(view.as_ref(), &url).unwrap();
    session
        .page_load_finished(view.as_ref(), ticket, &url, nonce(2))
        .unwrap();
    let first = session.snapshot(view.as_ref()).unwrap();
    assert_eq!(session.validate(view.as_ref(), &first), Ok(()));
    view.navigate("https://example.com/".parse().unwrap())
        .unwrap();
    assert_eq!(
        session.validate(view.as_ref(), &first),
        Err(SESSION_REFUSED)
    );
    session.navigation_started();
    view.navigate(url.clone()).unwrap();
    let ticket = session.page_load_started(view.as_ref(), &url).unwrap();
    session
        .page_load_finished(view.as_ref(), ticket, &url, nonce(3))
        .unwrap();
    assert_eq!(
        session.validate(view.as_ref(), &first),
        Err(SESSION_REFUSED)
    );
    assert!(session.snapshot(view.as_ref()).is_ok());
    session.owner_destroyed();
    assert!(session.snapshot(view.as_ref()).is_err());
    let mut replacement = WitnessSession::new(nonce(1));
    replacement.navigation_started();
    let ticket = replacement.page_load_started(view.as_ref(), &url).unwrap();
    replacement
        .page_load_finished(view.as_ref(), ticket, &url, nonce(2))
        .unwrap();
    // Even equal launch/navigation digests do not confer ownership of a new guard.
    assert_eq!(
        replacement.snapshot(view.as_ref()).unwrap().digest(),
        first.digest()
    );
    assert_eq!(
        replacement.validate(view.as_ref(), &first),
        Err(SESSION_REFUSED)
    );
}

#[test]
fn completion_ticket_from_previous_native_owner_cannot_complete_new_owner() {
    let mut previous = WitnessSession::new(nonce(1));
    let old_ticket = start(&mut previous, &local(), LOCAL).unwrap();
    previous.owner_destroyed();
    // Recreating a Webview within one app launch must not revive the old ticket.
    let mut replacement = WitnessSession::new(nonce(1));
    let _replacement_ticket = start(&mut replacement, &local(), LOCAL).unwrap();
    assert_eq!(
        finish(&mut replacement, &local(), old_ticket, LOCAL, nonce(2)),
        Err(SESSION_REFUSED)
    );
    assert!(capture(&replacement, &local()).is_err());
}
