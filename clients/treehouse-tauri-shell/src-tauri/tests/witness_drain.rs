#[path = "../src/witness_drain.rs"]
mod witness_drain;

use std::{sync::mpsc, time::Duration};
use tauri::async_runtime::{block_on, channel};
use witness_drain::{start_native_call, CALL_CANCELLED};

#[test]
fn dropped_caller_keeps_native_receiver_alive_until_terminal_callback() {
    let (terminal, mut callback) = channel(1);
    let (started, ready) = mpsc::channel();
    let (drained, done) = mpsc::channel();
    let pending = start_native_call(
        async move {
            started.send(()).unwrap();
            let result = callback.recv().await.unwrap();
            drained.send(()).unwrap();
            result
        },
        || true,
    );
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    drop(pending);
    // Mirrors the pinned helper's callback send: receiver loss is a failure.
    terminal
        .blocking_send(42)
        .expect("native receiver must survive caller loss");
    done.recv_timeout(Duration::from_secs(5)).unwrap();
}

#[test]
fn explicit_cancellation_drains_but_never_releases_success() {
    let (terminal, mut callback) = channel(1);
    let pending = start_native_call(async move { callback.recv().await.unwrap() }, || true);
    pending.cancellation().cancel();
    terminal.blocking_send(42).unwrap();
    assert_eq!(block_on(pending.receive()), Err(CALL_CANCELLED));
}

#[test]
fn changed_native_session_refuses_after_response_and_current_session_releases() {
    assert_eq!(
        block_on(start_native_call(async { 42 }, || false).receive()),
        Err(CALL_CANCELLED)
    );
    assert_eq!(
        block_on(start_native_call(async { 42 }, || true).receive()),
        Ok(42)
    );
}

#[test]
fn session_loss_after_native_completion_but_before_caller_receive_refuses() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let valid = Arc::new(AtomicBool::new(true));
    let checked_valid = valid.clone();
    let (checked, completed) = mpsc::channel();
    let pending = start_native_call(async { 42 }, move || {
        let value = checked_valid.load(Ordering::Acquire);
        let _ = checked.send(());
        value
    });
    completed.recv_timeout(Duration::from_secs(5)).unwrap();
    valid.store(false, Ordering::Release);
    assert_eq!(block_on(pending.receive()), Err(CALL_CANCELLED));
}
