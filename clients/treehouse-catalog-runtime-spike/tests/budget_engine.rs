//! Genuine engine resource failures, separate from default allocator diagnostics.
use std::time::Duration;
use treehouse_catalog_runtime_spike::{run_budget_fault_fixture, ExperimentLimits, RunFailure};

const MASKED_OUTPUT: &str = r#"{"oomObserved":true,"refusal":{"kind":"reject","reason":"malformed_catalog","detail":{"ids":[],"coreReason":null,"pendingProofIds":[]}}}"#;
const CONTROL_OUTPUT: &str = r#"{"oomObserved":false,"refusal":{"kind":"reject","reason":"malformed_catalog","detail":{"ids":[],"coreReason":null,"pendingProofIds":[]}}}"#;

const LIMITS: ExperimentLimits = ExperimentLimits {
    memory_bytes: 32 * 1024 * 1024,
    stack_bytes: 2 * 1024 * 1024,
    deadline: Duration::from_secs(2),
    input_bytes_max: 1024 * 1024,
    output_bytes_max: 1024 * 1024,
};

#[test]
fn caught_engine_exhaustion_is_not_a_semantic_result() {
    let completed = assert_allocation_failure(run_budget_fault_fixture(
        include_str!("../fault_fixtures/oom_masquerade.js"),
        LIMITS,
        None,
    ));
    assert_eq!(completed.as_deref(), Some(MASKED_OUTPUT));
}

fn assert_allocation_failure(
    result: Result<treehouse_catalog_runtime_spike::RunSuccess, RunFailure>,
) -> Option<String> {
    match result {
        Err(RunFailure::AllocationFailure {
            accounting,
            completed_output,
            ..
        }) => {
            assert!(accounting.failed);
            assert_eq!(
                accounting.live_bytes, 0,
                "runtime teardown frees all charged blocks"
            );
            assert!(accounting.peak_bytes <= LIMITS.memory_bytes);
            completed_output
        }
        other => panic!("expected genuine sticky allocation refusal, got {other:?}"),
    }
}

#[test]
fn non_exhausting_control_succeeds_with_zero_live_charge_after_teardown() {
    let result = run_budget_fault_fixture(
        include_str!("../fault_fixtures/oom_control.js"),
        LIMITS,
        None,
    )
    .unwrap();
    let accounting = result.allocation.unwrap();
    assert!(!accounting.failed);
    assert_eq!(accounting.live_bytes, 0);
    assert!(accounting.peak_bytes > 0 && accounting.peak_bytes <= LIMITS.memory_bytes);
    assert_eq!(result.output, CONTROL_OUTPUT);
}

#[test]
fn queued_promise_exhaustion_cannot_mask_the_native_failure() {
    let script = format!(
        "Promise.resolve().then(() => {{ return (
{}
); }})",
        include_str!("../fault_fixtures/oom_masquerade.js")
            .trim()
            .trim_end_matches(';')
    );
    let completed = assert_allocation_failure(run_budget_fault_fixture(&script, LIMITS, None));
    assert_eq!(completed.as_deref(), Some(MASKED_OUTPUT));
}

#[test]
fn uncaught_exhaustion_is_a_sticky_resource_failure() {
    assert_eq!(
        assert_allocation_failure(run_budget_fault_fixture(
            "(()=>{let a=[];for(;;)a.push(new Array(65536).fill(1));})()",
            LIMITS,
            None
        )),
        None
    );
}

/// The 64-byte cap must reach the real runtime constructor and return a typed
/// resource refusal without producing guest output or crashing the process.
#[cfg(unix)]
#[test]
fn initialization_budget_refuses_without_crashing() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_tiny_budget_probe"))
        .output()
        .expect("start private initialization probe");
    assert!(
        output.stdout.is_empty(),
        "initialization must not return a guest result"
    );
    assert!(
        output.status.success(),
        "initialization must return a typed refusal: status={:?}, stdout={}, stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "successful refusal must not emit diagnostics: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
