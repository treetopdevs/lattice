//! Genuine engine resource failures, separate from default allocator diagnostics.
use std::time::Duration;
use treehouse_catalog_runtime_spike::{run_budget_fault_fixture, ExperimentLimits, RunFailure};

const LIMITS: ExperimentLimits = ExperimentLimits {
    memory_bytes: 32 * 1024 * 1024,
    stack_bytes: 2 * 1024 * 1024,
    deadline: Duration::from_secs(2),
    input_bytes_max: 1024 * 1024,
    output_bytes_max: 1024 * 1024,
};

#[test]
fn caught_engine_exhaustion_is_not_a_semantic_result() {
    assert_allocation_failure(run_budget_fault_fixture(
        include_str!("../fault_fixtures/oom_masquerade.js"),
        LIMITS,
        None,
    ));
}

fn assert_allocation_failure(
    result: Result<treehouse_catalog_runtime_spike::RunSuccess, RunFailure>,
) {
    match result {
        Err(RunFailure::AllocationFailure { accounting, .. }) => {
            assert!(accounting.failed);
            assert_eq!(
                accounting.live_bytes, 0,
                "runtime teardown frees all charged blocks"
            );
            assert!(accounting.peak_bytes <= LIMITS.memory_bytes);
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
    assert!(result.output.contains("malformed_catalog"));
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
    assert_allocation_failure(run_budget_fault_fixture(&script, LIMITS, None));
}

#[test]
fn uncaught_exhaustion_is_a_sticky_resource_failure() {
    assert_allocation_failure(run_budget_fault_fixture(
        "(()=>{let a=[];for(;;)a.push(new Array(65536).fill(1));})()",
        LIMITS,
        None,
    ));
}

/// Failed adoption gate: rquickjs0.11 calls JS_SetDumpFlags before checking
/// JS_NewRuntime2 for null. Characterize the real crash in a separate process;
/// no patch, minimum-budget workaround, or successful runtime claim.
#[cfg(unix)]
#[test]
fn initialization_budget_gate_fails_in_the_pinned_runtime() {
    use std::os::unix::process::ExitStatusExt;
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_tiny_budget_probe"))
        .output()
        .expect("start private initialization probe");
    assert_eq!(output.status.signal(), Some(11),
        "re-evaluate the failed initialization gate if the pinned runtime stops crashing: status={:?}, stdout={}, stderr={}",
        output.status, String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
}
