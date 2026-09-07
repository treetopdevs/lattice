# Native catalog runtime resource experiment

**Result: the default rquickjs0.11.0 runtime fails the required sticky OOM gate.**
Nine diagnostic tests pass because they characterize that limitation and the
working deadline/cancellation behavior. They do not approve the runtime for
catalog verification or native trust installation.

This standalone, unpublished crate is outside both shipped shells. It executes
private fault fixtures only, with no keys, devices, network, filesystem guest
APIs, product commands, catalog input or state writes. The original mode uses the default allocator. A separately adopted private mode
uses the checked allocation wrapper described below. No rust-alloc/parallel/loader
features, upstream patches or dependencies were added.

The genuine exhaustion fixture allocates until the32MiB engine cap raises a
catchable exception, releases its temporary arrays and returns the same serialized
refusal as a control run. Rust receives a completed result with neither a sticky
deadline nor cancellation flag. The engine's exposed heap sample and exception
text are not accepted as OOM evidence for a production decision. Stack exhaustion
is similarly catchable. This prevents interpreting a caught verifier exception as
a durable semantic refusal on otherwise valid history.

Deadline/cancellation use Rust-owned sticky flags. After guest settlement and
runtime teardown, native also reads the original cancellation atomic and checks
the monotonic deadline before accepting a result. Cancellation linearizes at that
final atomic read: a request observed there refuses, while one arriving after that
acceptance point does not revise the completed result. A deterministic settlement
control covers short and Promise results cancelled after their last engine poll,
with uncancelled positive controls.
The cancellation test waits for a native start signal after acquiring the runtime
slot, avoiding cancellation of a fixture that has not started. Promise jobs are
drained outside the context borrow under the same deadline; unresolved promises
with no queued work refuse. Input is bounded before its owned source copy; output
length refusal is tested, but conversion happens first, so native output allocation
accounting remains unproven.

Run from this crate with one matching Rust toolchain for cargo, rustc and rustdoc
(the verified local toolchain is stable1.93.1):

```sh
cargo test --locked
cargo fmt --check
```

Execution evidence is under
`/tmp/lattice-treehouse-execution-20260906/`:

- `r11a-native-runtime-resource-gate.log`: interrupted implementation's8 failures,
  including nested runtime-borrow panics and an early cancellation classification.
- `r11a-native-runtime-resource-root-repair.log`:8 passing diagnostics after root
  separated context evaluation, job draining and final result inspection.
- `r11a-native-runtime-stopped-experiment-tests.log`:8 passing diagnostics in the
  final resource-only container. Unfinished host shims and placeholder probe/bundle
  files were preserved in `r11a-runtime-interrupted-snapshot/`, then excluded from
  this implementation so no placeholder can be mistaken for verifier evidence.

- `r11a-native-runtime-final-tests.log`: the eight diagnostics passed, but the
  doc-test step refused metadata because Homebrew rustdoc1.98 did not match the
  scoped rustc1.93.1. This invocation is a failed full gate.
- `r11a-native-runtime-final-toolchain-tests.log`: after setting task-local PATH,
  RUSTC and RUSTDOC to the same stable1.93.1 toolchain, the full locked Cargo test
  run passed all eight diagnostics and the empty doc-test target; fmt check passed.

- `r11a-runtime-settlement-cancel-red.log`: the real short-result cancellation
  was incorrectly accepted before the final native cancellation check (one failure).
- `r11a-runtime-settlement-cancel-green.log`: all nine diagnostics and the empty
  doc-test target passed after the repair, with formatting checked.

A1 deterministic cross-path/machine bundle, A2 genuine BEAM/TS native catalog
parity, actual host known-answer tests, Android build/link, hard host-allocation
bounds and native storage/review remain OPEN. No actual bundled catalog verifier
has run natively here. The earlier Node VM experiment was separate public-data
bundling evidence, not native isolation. C03/C14 remain OPEN.

Proceeding with a budget-enforcing allocator or another runtime needs an exact
separately reviewed amendment. This experiment does not silently enable one or
weaken the sticky failure requirement.


## Separate allocation wrapper: initialization gate failed

The private budget mode enforces charged requested engine allocations itself,
including pinned RustAllocator rounding/header bytes. The original runtime's
set_memory_limit is not used to claim this custom mode's bound. Six small trait
tests cover alignment, calloc zeroing, exact/over/overflow limits, live blocks,
grow/shrink, failed realloc preservation, null/zero behavior and sticky failure
after cleanup. An explicitly test-only injected null is not measured OS exhaustion.
Accounting bounds requested layouts, not fragmentation, RSS, host buffers or stacks.

Actual caught and uncaught allocation exhaustion and queued Promise exhaustion
now refuse through a Rust-owned sticky flag; the ordinary control succeeds and
charged blocks return to zero at teardown. This is useful partial evidence. The
mandatory tiny-budget initialization case instead terminates its child process
with SIGSEGV. The pinned rquickjs0.11 raw binding calls JS_SetDumpFlags before
checking the result of JS_NewRuntime2 for null; the pinned debug engine's setter
dereferences rt. That source path explains the observed null-budget crash; no
debugger backtrace was obtained. The attempted LLDB run made no progress and was
terminated, with its incomplete log preserved.

The stopped suite has20 passing diagnostic tests:6 allocator,5 budget-engine
(including a separate-child assertion of this failed initialization gate), and
9 original default-mode/settlement diagnostics. A passing crash-characterization
test does not turn initialization into successful resource refusal. No upstream
patch, minimum-budget workaround or weakened acceptance was added. Sanitizer/Miri
proof is unperformed; only the existing stable toolchain was used. This new mode
remains unsuitable for catalog installation. Catchable stack failure, native host
allocation, A1/A2/aggregateA3, Android and C03/C14 remain OPEN.

Additional retained execution logs:

- r11a-budget-allocator-unit-first.log:6 trait checks passed.
- r11a-budget-engine-red.log: the genuine default-engine masked OOM was accepted,
  failing the required result-refusal assertion before custom mode integration.
- r11a-budget-engine-first.log: two budget cases passed before the process crashed.
- r11a-budget-engine-promise-isolated.log: a test composition error inserted a
  newline after return and skipped its fixture. The corrected parenthesized
  composition runs real queued exhaustion; both outputs are preserved.
- r11a-budget-engine-stopped.log: final20 diagnostics and empty doc-tests passed;
  the tiny-budget failure is isolated in its own unpublished probe process.

Independent Sol review found that an AllocationFailure alone did not prove the
caught/queued guest settled to its plausible refusal. The narrow repair retains
the already bounded completed output only as private failure diagnostics (moved,
not copied). Both cases now assert the exact completed masked JSON bytes before
native refusal; the uncaught case has no completed output, and the initialization
child returns none. The real non-exhausting control retains its exact expected
bytes. Final success remains impossible after sticky allocation failure.
`r11a-budget-settlement-evidence-red.log` preserves the two missing-evidence
failures. The first attempted edit missed the formatted acceptance branch, so
`r11a-budget-settlement-evidence-green.log` still has those same two failures;
its filename is not a success claim. After the actual branch correction,
`r11a-budget-settlement-evidence-final.log` records the passing20-test gate.
