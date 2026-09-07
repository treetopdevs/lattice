//! A3 resource-stickiness gates, run with private test-only fault fixtures.
//!
//! Contract: prove out-of-band sticky OOM/deadline/cancellation detection even
//! when guest JavaScript catches the failure and returns a plausible semantic
//! refusal. If the default engine cannot expose reliable sticky OOM status,
//! record that gate as failed - no error-text classification, no heap-sample
//! proof, no allocator workaround.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use treehouse_catalog_runtime_spike::{
    run_fault_fixture, run_fault_fixture_with_start_signal, ExperimentLimits, RunFailure,
};

const FAULT_LIMITS: ExperimentLimits = ExperimentLimits {
    memory_bytes: 32 * 1024 * 1024,
    stack_bytes: 2 * 1024 * 1024,
    deadline: Duration::from_millis(1500),
    input_bytes_max: 24 * 1024 * 1024,
    output_bytes_max: 64 * 1024 * 1024,
};

/// A plausible semantic refusal, byte-identical to what the real verifier
/// returns for malformed input. Produced by the masquerade fixtures.
const PLAUSIBLE_REFUSAL: &str = r#"{"kind":"reject","reason":"malformed_catalog","detail":{"ids":[],"coreReason":null,"pendingProofIds":[]}}"#;

const OOM_MASQUERADE: &str = include_str!("../fault_fixtures/oom_masquerade.js");
const OOM_CONTROL: &str = include_str!("../fault_fixtures/oom_control.js");
const DEADLINE_MASQUERADE: &str = include_str!("../fault_fixtures/deadline_masquerade.js");
const LATE_RESULT: &str = include_str!("../fault_fixtures/late_result.js");
const STALLED_PROMISE: &str = include_str!("../fault_fixtures/stalled_promise.js");
const STACK_MASQUERADE: &str = include_str!("../fault_fixtures/stack_masquerade.js");

/// GATE RESULT (sticky OOM): the default engine throws a *catchable*
/// InternalError on allocation failure (quickjs.c JS_ThrowOutOfMemory has no
/// uncatchable flag; rt->in_out_of_memory is transient and unexposed). The
/// guest catches it and returns a refusal byte-identical to a genuine semantic
/// refusal, and every out-of-band signal available to Rust is indistinguishable
/// from a clean run. This test *documents the limitation precisely*; it fails
/// loudly if the engine ever starts exposing the signal (so the gate would be
/// re-evaluated) or stops enforcing the memory limit at all.
#[test]
fn sticky_oom_gate_fails_default_engine_cannot_distinguish_masked_oom() {
    let masked = run_fault_fixture(OOM_MASQUERADE, FAULT_LIMITS, None).expect(
        "masked OOM completes as an ordinary run: engine exposes no out-of-band OOM status",
    );
    let control =
        run_fault_fixture(OOM_CONTROL, FAULT_LIMITS, None).expect("control run completes");

    let masked_json: serde_json::Value = serde_json::from_str(&masked.output).unwrap();
    // The guest really did hit the engine memory limit and caught it in JS.
    assert_eq!(
        masked_json["oomObserved"], true,
        "fixture must actually exhaust the 32 MiB limit: {}",
        masked.output
    );
    let masked_refusal = serde_json::to_string(&masked_json["refusal"]).unwrap();
    let control_refusal = serde_json::to_string(
        &serde_json::from_str::<serde_json::Value>(&control.output).unwrap()["refusal"],
    )
    .unwrap();
    let expected: serde_json::Value = serde_json::from_str(PLAUSIBLE_REFUSAL).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&masked_refusal).unwrap(),
        expected
    );

    // Byte-identical plausible refusals from the OOM-masked run and the
    // genuine-refusal control run.
    assert_eq!(
        masked_refusal, control_refusal,
        "masked OOM output is indistinguishable from a genuine refusal"
    );

    // Every out-of-band signal Rust can observe is identical in kind: no
    // sticky flag, no exception, completed result. (Interrupt-poll counts and
    // heap samples differ, but the contract forbids using heap samples as OOM
    // proof and they are unreliable: the catch handler frees before return.)
    assert!(!masked.signals.deadline_exceeded && !masked.signals.cancelled);
    assert!(!control.signals.deadline_exceeded && !control.signals.cancelled);
    assert!(!masked.signals.wall_exceeded_deadline);
}

/// The engine does enforce the memory limit itself: an uncaught exhaustion
/// surfaces as an exception (InternalError: out of memory). Detection relies on
/// the guest not catching it, which the masquerade test above defeats - that
/// asymmetry *is* the gate failure.
#[test]
fn uncaught_oom_surfaces_as_exception() {
    let result = run_fault_fixture(
        "(function(){ const c = []; for(;;) c.push(new Array(65536).fill(1)); })()",
        FAULT_LIMITS,
        None,
    );
    match result {
        Err(RunFailure::Exception { message, .. }) => {
            // Recorded for the log only. The contract forbids *classifying*
            // OOM from this text, and this string is exactly why: it is the
            // only place the failure is visible, and JS can suppress it.
            assert!(!message.is_empty());
        }
        other => panic!("uncaught OOM should surface as an exception, got {other:?}"),
    }
}

/// Sticky deadline detection PASSES: the interrupt is raised by Rust's own
/// handler (uncatchable in the engine), the sticky flag lives in Rust, and a
/// guest try/catch returning a plausible refusal cannot intercept it.
#[test]
fn sticky_deadline_defeats_catch_masquerade() {
    let result = run_fault_fixture(DEADLINE_MASQUERADE, FAULT_LIMITS, None);
    match result {
        Err(RunFailure::Exception { signals, .. }) => {
            assert!(
                signals.deadline_exceeded,
                "sticky deadline flag must be set out-of-band"
            );
            assert!(signals.interrupt_polls > 0);
        }
        Err(RunFailure::LateResult { signals }) => {
            assert!(signals.deadline_exceeded);
        }
        other => panic!("deadline masquerade must not produce an accepted result, got {other:?}"),
    }
}

/// Sticky cancellation PASSES by the same mechanism as the deadline.
#[test]
fn sticky_cancellation_defeats_catch_masquerade() {
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancel);
    let started = Arc::new(AtomicBool::new(false));
    let observed = Arc::clone(&started);
    let handle = std::thread::spawn(move || {
        let until = std::time::Instant::now() + Duration::from_secs(30);
        while !observed.load(Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < until,
                "fault fixture never started"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        std::thread::sleep(Duration::from_millis(20));
        flag.store(true, Ordering::SeqCst);
    });
    let limits = ExperimentLimits {
        deadline: Duration::from_secs(10),
        ..FAULT_LIMITS
    };
    let result = run_fault_fixture_with_start_signal(
        DEADLINE_MASQUERADE,
        limits,
        Some(cancel),
        Some(started),
    );
    handle.join().unwrap();
    match result {
        Err(RunFailure::Exception { signals, .. }) | Err(RunFailure::LateResult { signals }) => {
            assert!(
                signals.cancelled,
                "sticky cancellation flag must be set out-of-band"
            );
        }
        other => panic!("cancelled run must not produce an accepted result, got {other:?}"),
    }
}

/// No late result may be accepted: even when the guest completes and returns a
/// plausible refusal after the deadline (interrupts only fire on loop/call
/// boundaries, so a run can also finish just past the deadline without an
/// interrupt), Rust refuses the result from the monotonic clock alone.
#[test]
fn late_result_is_refused_out_of_band() {
    let limits = ExperimentLimits {
        deadline: Duration::from_millis(200),
        ..FAULT_LIMITS
    };
    let result = run_fault_fixture(LATE_RESULT, limits, None);
    match result {
        Err(RunFailure::LateResult { signals }) => {
            assert!(signals.wall_exceeded_deadline || signals.deadline_exceeded);
        }
        Err(RunFailure::Exception { signals, .. }) => {
            // The interrupt fired first inside the busy loop; equally refused.
            assert!(signals.deadline_exceeded);
        }
        other => panic!("late result must be refused, got {other:?}"),
    }
}

/// An unresolved promise with no pending jobs is failure, not empty output.
#[test]
fn stalled_promise_is_failure() {
    let result = run_fault_fixture(STALLED_PROMISE, FAULT_LIMITS, None);
    match result {
        Err(RunFailure::StalledPromise { .. }) => {}
        other => panic!("stalled promise must fail, got {other:?}"),
    }
}

/// Stack exhaustion behaves like OOM: catchable in-guest, no out-of-band
/// signal. Documented as part of the same engine limitation.
#[test]
fn stack_overflow_is_catchable_like_oom() {
    let result = run_fault_fixture(STACK_MASQUERADE, FAULT_LIMITS, None)
        .expect("stack overflow can be caught and masked in-guest");
    let parsed: serde_json::Value = serde_json::from_str(&result.output).unwrap();
    assert_eq!(
        parsed["overflowObserved"], true,
        "fixture must actually overflow the 2 MiB stack"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            &serde_json::to_string(&parsed["refusal"]).unwrap()
        )
        .unwrap(),
        serde_json::from_str::<serde_json::Value>(PLAUSIBLE_REFUSAL).unwrap()
    );
}

/// Input and output bounds are enforced natively before/after the guest runs.
#[test]
fn native_io_bounds_are_enforced() {
    let tight = ExperimentLimits {
        input_bytes_max: 64,
        ..FAULT_LIMITS
    };
    match run_fault_fixture(&format!("\"{}\"", "x".repeat(128)), tight, None) {
        Err(RunFailure::InputBound { bytes, max }) => {
            assert!(bytes > max);
        }
        other => panic!("oversized input must be refused before intake, got {other:?}"),
    }
    let tight_out = ExperimentLimits {
        output_bytes_max: 8,
        ..FAULT_LIMITS
    };
    match run_fault_fixture("\"0123456789abcdef\"", tight_out, None) {
        Err(RunFailure::OutputBound { max }) => assert_eq!(max, 8),
        other => panic!("oversized output must be refused, not truncated, got {other:?}"),
    }
}
