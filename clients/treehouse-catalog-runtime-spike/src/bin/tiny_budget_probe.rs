//! Private child-process diagnostic for the pinned runtime initialization failure.
use std::time::Duration;
use treehouse_catalog_runtime_spike::{
    run_budget_fault_fixture, ExperimentLimits, RunFailure,
};

fn main() {
    let result = run_budget_fault_fixture(
        "'never reached'",
        ExperimentLimits {
            memory_bytes: 64,
            stack_bytes: 2 * 1024 * 1024,
            deadline: Duration::from_secs(2),
            input_bytes_max: 1024,
            output_bytes_max: 1024,
        },
        None,
    );
    match result {
        Err(RunFailure::AllocationFailure {
            stage,
            accounting,
            completed_output,
        }) => {
            assert_eq!(stage, "runtime initialization");
            assert!(accounting.failed);
            assert_eq!(accounting.live_bytes, 0);
            assert_eq!(completed_output, None);
        }
        other => panic!("expected typed initialization refusal, got {other:?}"),
    }
}
