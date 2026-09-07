# Native catalog runtime resource experiment

**Result: the default rquickjs0.11.0 runtime fails the required sticky OOM gate.**
Eight diagnostic tests pass because they characterize that limitation and the
working deadline/cancellation behavior. They do not approve the runtime for
catalog verification or native trust installation.

This standalone, unpublished crate is outside both shipped shells. It executes
private fault fixtures only, with no keys, devices, network, filesystem guest
APIs, product commands, catalog input or state writes. The default allocator is
used; no allocator/rust-alloc/parallel/loader features or upstream patches.

The genuine exhaustion fixture allocates until the32MiB engine cap raises a
catchable exception, releases its temporary arrays and returns the same serialized
refusal as a control run. Rust receives a completed result with neither a sticky
deadline nor cancellation flag. The engine's exposed heap sample and exception
text are not accepted as OOM evidence for a production decision. Stack exhaustion
is similarly catchable. This prevents interpreting a caught verifier exception as
a durable semantic refusal on otherwise valid history.

Deadline/cancellation use a Rust-owned sticky flag and final monotonic-clock check.
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

A1 deterministic cross-path/machine bundle, A2 genuine BEAM/TS native catalog
parity, actual host known-answer tests, Android build/link, hard host-allocation
bounds and native storage/review remain OPEN. No actual bundled catalog verifier
has run natively here. The earlier Node VM experiment was separate public-data
bundling evidence, not native isolation. C03/C14 remain OPEN.

Proceeding with a budget-enforcing allocator or another runtime needs an exact
separately reviewed amendment. This experiment does not silently enable one or
weaken the sticky failure requirement.
