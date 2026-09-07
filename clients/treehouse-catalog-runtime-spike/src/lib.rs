//! R11a standalone native catalog verifier feasibility experiment.
//!
//! This stopped experiment characterizes catchable resource failures in
//! rquickjs 0.11.0 with its default allocator and a separately adopted budget mode. It executes private fault
//! fixtures only. It does not execute the catalog verifier or ship in a product.
//! The default missing sticky OOM signal and budget initialization crash block
//! runtime adoption; see README.md.

#[doc(hidden)]
pub mod budget_allocator;

use budget_allocator::{BudgetAllocator, BudgetObserver, BudgetSnapshot};
use rquickjs::{Context, Runtime, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Experiment measurement stop bounds only; not pilot/shipping capacity policy.
#[derive(Clone, Copy, Debug)]
pub struct ExperimentLimits {
    /// JS heap limit enforced by the engine's default allocator accounting.
    pub memory_bytes: usize,
    /// JS stack limit.
    pub stack_bytes: usize,
    /// Monotonic deadline covering evaluation plus all promise-job draining.
    pub deadline: Duration,
    /// Acceptance bound on private fault-fixture source before its owned copy.
    pub input_bytes_max: usize,
    /// Result acceptance bound, checked after string conversion. This is not
    /// a proved bound on the allocation performed by that conversion.
    pub output_bytes_max: usize,
}

/// Contract measurement limits: 512 MiB heap, 2 MiB stack, 30 s deadline.
/// Recorded proposal limits only; this stopped probe ingests no catalog history.
pub const CONTRACT_LIMITS: ExperimentLimits = ExperimentLimits {
    memory_bytes: 512 * 1024 * 1024,
    stack_bytes: 2 * 1024 * 1024,
    deadline: Duration::from_secs(30),
    input_bytes_max: 24 * 1024 * 1024,
    output_bytes_max: 64 * 1024 * 1024,
};

/// Out-of-band sticky signals owned by Rust, never observable or clearable by
/// the guest. `deadline_exceeded`/`cancelled` are set by the interrupt handler
/// (an uncatchable engine interrupt). There is deliberately no `oom` member:
/// the default engine exposes no out-of-band OOM signal - that absence is the
/// documented result of the sticky-OOM gate, not an oversight.
#[derive(Debug, Default)]
pub struct StickySignals {
    pub deadline_exceeded: AtomicBool,
    pub cancelled: AtomicBool,
    pub interrupt_polls: AtomicU64,
}

/// Snapshot of every out-of-band signal the harness can observe after a run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignalSnapshot {
    pub deadline_exceeded: bool,
    pub cancelled: bool,
    pub interrupt_polls: u64,
    pub wall_exceeded_deadline: bool,
    /// Engine heap sample at completion. Reported for measurement only; the
    /// contract forbids using it as OOM proof and this crate never does.
    pub memory_used_size_sample: i64,
}

#[derive(Clone, Debug)]
pub enum RunFailure {
    AllocationFailure {
        stage: &'static str,
        accounting: BudgetSnapshot,
        /// Private bounded provisional guest output; never a successful verdict.
        completed_output: Option<String>,
    },
    /// Input exceeded the recorded native input bound; refused before intake.
    InputBound {
        bytes: usize,
        max: usize,
    },
    /// Output exceeded the recorded native output bound; refused, not truncated.
    OutputBound {
        max: usize,
    },
    /// The guest raised an exception that reached the harness.
    Exception {
        message: String,
        signals: SignalSnapshot,
    },
    /// The entry promise is unresolved with no pending jobs: failure, not
    /// successful empty output.
    StalledPromise {
        signals: SignalSnapshot,
    },
    /// A result was produced but an out-of-band sticky signal or the monotonic
    /// deadline invalidates it. Late/flagged results are never accepted.
    LateResult {
        signals: SignalSnapshot,
    },
    Internal(String),
}

#[derive(Clone, Debug)]
pub struct RunSuccess {
    pub output: String,
    pub allocation: Option<BudgetSnapshot>,
    pub signals: SignalSnapshot,
}

/// One outstanding evaluation across the process, per the experiment limits.
static EVALUATION_GATE: Mutex<()> = Mutex::new(());

struct Guest<'a> {
    limits: ExperimentLimits,
    cancel: Option<Arc<AtomicBool>>,
    started_signal: Option<Arc<AtomicBool>>,
    script: &'a str,
    before_acceptance: Option<Box<dyn FnOnce() + Send>>,
    budget_allocator: bool,
}

fn exception_text(ctx: &rquickjs::Ctx<'_>, error: rquickjs::Error) -> String {
    match error {
        rquickjs::Error::Exception => {
            let caught: Value = ctx.catch();
            if let Some(exception) = caught.as_exception() {
                format!(
                    "{}: {}",
                    exception
                        .get::<_, Option<String>>("name")
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| "Error".into()),
                    exception.message().unwrap_or_default()
                )
            } else if let Some(s) = caught.as_string() {
                s.to_string()
                    .unwrap_or_else(|_| "<non-utf8 exception>".into())
            } else {
                format!("<non-error exception: {:?}>", caught.type_of())
            }
        }
        other => format!("{other:?}"),
    }
}

fn allocation_failure(
    observer: &Option<Arc<BudgetObserver>>,
    stage: &'static str,
) -> Option<RunFailure> {
    let accounting = observer.as_ref()?.snapshot();
    accounting.failed.then_some(RunFailure::AllocationFailure {
        stage,
        accounting,
        completed_output: None,
    })
}

fn run_guest(guest: Guest<'_>) -> Result<RunSuccess, RunFailure> {
    let _gate = EVALUATION_GATE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let input_bytes = guest.script.len();
    if input_bytes > guest.limits.input_bytes_max {
        return Err(RunFailure::InputBound {
            bytes: input_bytes,
            max: guest.limits.input_bytes_max,
        });
    }

    let allocator = guest
        .budget_allocator
        .then(|| BudgetAllocator::new(guest.limits.memory_bytes));
    let allocation_observer = allocator.as_ref().map(BudgetAllocator::observer);
    let runtime_result = match allocator {
        Some(allocator) => Runtime::new_with_alloc(allocator),
        None => Runtime::new(),
    };
    let runtime = runtime_result.map_err(|error| {
        allocation_failure(&allocation_observer, "runtime initialization")
            .unwrap_or_else(|| RunFailure::Internal(format!("runtime: {error:?}")))
    })?;
    if !guest.budget_allocator {
        runtime.set_memory_limit(guest.limits.memory_bytes);
    }
    runtime.set_max_stack_size(guest.limits.stack_bytes);

    let signals = Arc::new(StickySignals::default());
    let started = Instant::now();
    let deadline = guest.limits.deadline;
    {
        let signals = Arc::clone(&signals);
        let cancel = guest.cancel.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            signals.interrupt_polls.fetch_add(1, Ordering::Relaxed);
            if started.elapsed() >= deadline {
                signals.deadline_exceeded.store(true, Ordering::SeqCst);
                return true;
            }
            if let Some(cancel) = &cancel {
                if cancel.load(Ordering::SeqCst) {
                    signals.cancelled.store(true, Ordering::SeqCst);
                    return true;
                }
            }
            false
        })));
    }

    let context = match Context::full(&runtime) {
        Ok(context) => context,
        Err(error) => {
            drop(runtime);
            return Err(
                allocation_failure(&allocation_observer, "context initialization")
                    .unwrap_or_else(|| RunFailure::Internal(format!("context: {error:?}"))),
            );
        }
    };

    // Phase 1: evaluate a private fault fixture inside the context borrow.
    let evaluated: Result<rquickjs::Persistent<Value<'static>>, RunFailure> = context.with(|ctx| {
        if let Some(started_signal) = &guest.started_signal {
            started_signal.store(true, Ordering::SeqCst);
        }
        let result_value: Result<Value, rquickjs::Error> = ctx.eval(guest.script);
        match result_value {
            Err(error) => {
                let message = exception_text(&ctx, error);
                Err(RunFailure::Exception {
                    message,
                    signals: SignalSnapshot {
                        deadline_exceeded: signals.deadline_exceeded.load(Ordering::SeqCst),
                        cancelled: signals.cancelled.load(Ordering::SeqCst),
                        interrupt_polls: signals.interrupt_polls.load(Ordering::Relaxed),
                        wall_exceeded_deadline: started.elapsed() >= deadline,
                        memory_used_size_sample: -1,
                    },
                })
            }
            Ok(value) => Ok(rquickjs::Persistent::save(&ctx, value)),
        }
    });

    // Phase 2 (outside any context borrow): drain every pending promise job
    // under the same monotonic deadline. The interrupt handler fires inside
    // jobs as well.
    let mut job_error: Option<String> = None;
    if evaluated.is_ok() {
        loop {
            if started.elapsed() >= deadline {
                signals.deadline_exceeded.store(true, Ordering::SeqCst);
                break;
            }
            match runtime.execute_pending_job() {
                Ok(true) => continue,
                Ok(false) => break,
                Err(_job) => {
                    job_error.get_or_insert_with(|| "job exception".to_string());
                    continue;
                }
            }
        }
    }

    let snapshot = || SignalSnapshot {
        deadline_exceeded: signals.deadline_exceeded.load(Ordering::SeqCst),
        cancelled: signals.cancelled.load(Ordering::SeqCst),
        interrupt_polls: signals.interrupt_polls.load(Ordering::Relaxed),
        wall_exceeded_deadline: started.elapsed() >= deadline,
        memory_used_size_sample: -1,
    };

    // Phase 3: settle the result value.
    let outcome: Result<String, RunFailure> = match evaluated {
        Err(failure) => Err(failure),
        Ok(persistent) => context.with(|ctx| {
            let value: Value = persistent
                .restore(&ctx)
                .map_err(|e| RunFailure::Internal(format!("restore: {e:?}")))?;
            let settled: Value = if let Some(promise) = value.as_promise() {
                match promise.state() {
                    rquickjs::promise::PromiseState::Pending => {
                        return Err(RunFailure::StalledPromise {
                            signals: snapshot(),
                        });
                    }
                    _ => match promise.result::<Value>() {
                        Some(Ok(v)) => v,
                        Some(Err(error)) => {
                            let message = exception_text(&ctx, error);
                            return Err(RunFailure::Exception {
                                message,
                                signals: snapshot(),
                            });
                        }
                        None => {
                            return Err(RunFailure::StalledPromise {
                                signals: snapshot(),
                            })
                        }
                    },
                }
            } else {
                value
            };
            if let Some(job_error) = job_error {
                return Err(RunFailure::Exception {
                    message: job_error,
                    signals: snapshot(),
                });
            }
            let text = if settled.is_undefined() || settled.is_null() {
                String::new()
            } else if let Some(s) = settled.as_string() {
                let owned = s
                    .to_string()
                    .map_err(|e| RunFailure::Internal(format!("result string: {e:?}")))?;
                if owned.len() > guest.limits.output_bytes_max {
                    return Err(RunFailure::OutputBound {
                        max: guest.limits.output_bytes_max,
                    });
                }
                owned
            } else {
                return Err(RunFailure::Internal(format!(
                    "non-string result: {:?}",
                    settled.type_of()
                )));
            };
            Ok(text)
        }),
    };

    let memory_used_size_sample = runtime.memory_usage().memory_used_size;
    // Context destroyed here with the runtime; nothing (including the module's
    // route WeakMap) survives the invocation.
    drop(context);
    drop(runtime);

    if let Some(control) = guest.before_acceptance {
        control();
    }

    // Cancellation linearizes at this final native read after guest settlement
    // and teardown. A request observed here refuses even without an interrupt;
    // one arriving after this acceptance point does not revise this result.
    if guest
        .cancel
        .as_ref()
        .is_some_and(|cancel| cancel.load(Ordering::SeqCst))
    {
        signals.cancelled.store(true, Ordering::SeqCst);
    }
    let final_signals = SignalSnapshot {
        deadline_exceeded: signals.deadline_exceeded.load(Ordering::SeqCst),
        cancelled: signals.cancelled.load(Ordering::SeqCst),
        interrupt_polls: signals.interrupt_polls.load(Ordering::Relaxed),
        wall_exceeded_deadline: started.elapsed() >= deadline,
        memory_used_size_sample,
    };

    // Out-of-band acceptance rule: sticky signals and the monotonic clock are
    // checked by Rust after completion. A caught-and-masked in-guest failure
    // cannot influence this check; a late result is refused even if plausible.
    if final_signals.deadline_exceeded
        || final_signals.cancelled
        || final_signals.wall_exceeded_deadline
    {
        return Err(RunFailure::LateResult {
            signals: final_signals,
        });
    }
    if let Some(RunFailure::AllocationFailure {
        stage, accounting, ..
    }) = allocation_failure(&allocation_observer, "guest evaluation or teardown")
    {
        // Diagnostic data only: move the already bounded provisional result.
        // The sticky allocation failure still prevents successful acceptance.
        return Err(RunFailure::AllocationFailure {
            stage,
            accounting,
            completed_output: outcome.ok(),
        });
    }
    let output = outcome?;
    Ok(RunSuccess {
        output,
        allocation: allocation_observer
            .as_ref()
            .map(|observer| observer.snapshot()),
        signals: final_signals,
    })
}

/// Test-only entry for private fault fixtures (resource-stickiness gates).
/// Not part of any product API; arbitrary script input never ships.
#[doc(hidden)]
pub fn run_fault_fixture(
    script: &str,
    limits: ExperimentLimits,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<RunSuccess, RunFailure> {
    run_fault_fixture_with_start_signal(script, limits, cancel, None)
}

/// Private experiment control: signal only after engine initialization and just
/// before executing the selected fault fixture. Never exposed by either shell.
#[doc(hidden)]
pub fn run_fault_fixture_with_start_signal(
    script: &str,
    limits: ExperimentLimits,
    cancel: Option<Arc<AtomicBool>>,
    started_signal: Option<Arc<AtomicBool>>,
) -> Result<RunSuccess, RunFailure> {
    run_fixture_with_controls(script, limits, cancel, started_signal, None, false)
}

/// Private deterministic settlement control for the stopped experiment. It runs
/// after all guest work and runtime destruction, before final native acceptance.
#[doc(hidden)]
pub fn run_fault_fixture_with_settlement_control(
    script: &str,
    limits: ExperimentLimits,
    cancel: Option<Arc<AtomicBool>>,
    control: Box<dyn FnOnce() + Send>,
) -> Result<RunSuccess, RunFailure> {
    run_fixture_with_controls(script, limits, cancel, None, Some(control), false)
}

/// Separately selected private allocation mode; never used by a shipped shell.
#[doc(hidden)]
pub fn run_budget_fault_fixture(
    script: &str,
    limits: ExperimentLimits,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<RunSuccess, RunFailure> {
    run_fixture_with_controls(script, limits, cancel, None, None, true)
}

fn run_fixture_with_controls(
    script: &str,
    limits: ExperimentLimits,
    cancel: Option<Arc<AtomicBool>>,
    started_signal: Option<Arc<AtomicBool>>,
    before_acceptance: Option<Box<dyn FnOnce() + Send>>,
    budget_allocator: bool,
) -> Result<RunSuccess, RunFailure> {
    if script.len() > limits.input_bytes_max {
        return Err(RunFailure::InputBound {
            bytes: script.len(),
            max: limits.input_bytes_max,
        });
    }
    let script = script.to_owned();
    let handle = std::thread::Builder::new()
        .name("fault-fixture".into())
        .stack_size(8 * 1024 * 1024)
        .spawn(move || {
            run_guest(Guest {
                limits,
                cancel,
                started_signal,
                before_acceptance,
                budget_allocator,
                script: &script,
            })
        })
        .map_err(|e| RunFailure::Internal(format!("worker spawn: {e}")))?;
    handle
        .join()
        .map_err(|_| RunFailure::Internal("worker panicked".into()))?
}
