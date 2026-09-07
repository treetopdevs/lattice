# Root adoption: bounded native allocation experiment

Adopted 2026-09-07 UTC after actual gpt-5.6-sol review returned PASS with no
P0–P2 for the exact proposal SHA256
`6c4cd95c1edd01f60013b2f69b6fd3097a6fc33396af6c0ab99739032ecf0cf8`.
The complete proposal below is adopted as a resource-only implementation contract;
its proposed status records review-time provenance. This supersedes only the
prior experiment's prohibition on an explicitly selected private allocator mode.
The default allocator diagnostics and failed sticky OOM result remain intact.
The cancellation repair at `fc37a0e8b2c0a3b2979f4e1aad129ac75cc90c0f`
passed a separate independent Sol review and nine actual diagnostic tests.
No aggregate A3, runtime eligibility, native installation or C03/C14 result is implied.

---

# R11a sticky allocation experiment amendment proposal

Proposal only, 2026-09-07 UTC. The default-engine experiment at303ddac8 and its cancellation repairfc37a0e8 do not approve native catalog verification. This amendment would authorize only an additional resource experiment inside clients/treehouse-catalog-runtime-spike. Actual catalog bundling/host/parity, Android and native installation remain open. No shipped dependency, product API, existing verifier, vector, toolchain or upstream source may change.

## Exact addition

Retain rquickjs exactly0.11.0 and its existing lock/checksums. Add a private BudgetAllocator implementing the already exposed unsafe rquickjs::allocator::Allocator trait, wrapping that version's RustAllocator with checked bounds. Use Runtime::new_with_alloc only for an explicit new private budget experiment mode; retain the existing Runtime::new default-mode diagnostics byte-identically except shared harness plumbing. No rust-alloc global feature, parallel/loader feature, dynamic code, allocator crate, upstream patch or new dependency. Feature admission is unnecessary if the pinned public trait/API builds under the existing manifest, as its locally installed0.11.0 source indicates; if it does not, stop with the exact compiler evidence before altering features.

The relevant pinned source was read locally: rquickjs-core0.11.0/src/allocator.rs, allocator/rust.rs and runtime/{base,raw}.rs. Runtime::set_memory_limit is not effective for custom allocation; the budget allocator itself must enforce the limit. Do not claim its invocation supplies the bound.

## Accounting and unsafe boundary

Use a separate allocator instance per runtime. The allocator owns current charged bytes and an external Rust-owned sticky allocation-failed AtomicBool. The observer survives runtime creation failure and destruction; JavaScript cannot clear or obtain it. Charge actual requested allocator layout bytes, including rounded usable storage plus RustAllocator's header. On the supported 64-bit targets, derive the8-byte alignment/header from the pinned implementation and compile-time assert the layout assumptions. Unsupported pointer-width/layout targets fail compilation rather than guessing. Do not call into the wrapped allocator with arithmetic that its implementation can overflow or panic on.

Every allocation calculates checked size rounding, header addition, Layout representability and checked total against the cap before calling RustAllocator. calloc checks count*size before rounding. Overflow/invalid layout/budget refusal or a nonzero system-allocation null sets the sticky flag before returning null. No panic, format/log allocation, mutex wait, guest call or unwind in allocator callbacks. Zero-sized calloc returns null without flagging failure, matching the wrapped allocator's defined zero case. Ordinary alloc(0) may use the checked minimum header layout. Neither zero case supplies an usable object to guest code beyond the engine's own API.

Handle realloc(null,n) as alloc(n), and realloc(p,0) as dealloc(p) then null, without passing those forms into RustAllocator's unchecked pointer arithmetic. For nonnull realloc, compute old usable/header charge from the owned block, preflight the new layout and projected total using checked arithmetic, then call the underlying realloc. A failed realloc preserves the original block, contents and old charge; set sticky failure. Only successful realloc replaces charge and ownership. Shrink frees accounting capacity. dealloc uses the same allocator and exact owned pointer and releases its actual charge. Track cumulative peak only as diagnostics, never failure evidence. Never call usable_size with null.

The cap bounds charged requested engine allocation bytes, not allocator arena fragmentation, process RSS, Rust host copies, worker stack or a whole-process memory budget. The external observer and allocator wrapper metadata are bounded fixed native overhead outside that cap and must be described accurately. Native input/output/host primitives remain separately unproven. The wrapper's accounting and pointer preconditions are safety-critical and require independent exact-source review before any integration claim.

After an allocation failure, allow frees and necessary within-budget cleanup allocations, but never clear the sticky flag during that invocation. Even if guest catches, frees memory, a GC retry succeeds, or the original operation returns an ordinary refusal, final native acceptance must refuse when the flag is set. A new runtime starts a fresh observer. A runtime creation/context initialization failure is a resource failure; it must not become a semantic catalog verdict. Integrate the observer with the existing final cancellation/deadline check after teardown. Do not infer failure from error strings or a heap sample.

## Required evidence

1. Allocator-level public trait tests: alignment/usable capacity; calloc zeroing and checked overflow; exact boundary and one-over; multiple live blocks; successful grow/shrink; failed grow preserves bytes and accounting; null/zero realloc semantics; deallocation restores zero; fresh observer resets only for a new runtime. Deterministic resource-denial injection covers underlying null without attempting a machine-exhausting allocation. The test mode must be private to the spike and never report injected failure as measured OS behavior. Use checked small allocations and ASan/Miri only where this exact local toolchain supports them; unavailable sanitizer proof stays open and does not trigger a toolchain install.
2. Genuine native engine runs using the original fixed private OOM masquerade/control and uncaught fixtures at the32MiB cap. Record actual sticky failure and refuse caught OOM before returning even a plausible semantic refusal. The uncancelled, non-exhausting control succeeds. Preserve deadline, settlement cancellation and Promise-drain controls. Include exhaustion during queued Promise work and initialization refusal with an intentionally tiny cap. No new catalog verdict implementation or copied semantic result may substitute for running these fixtures.
3. Report the default runtime still fails sticky OOM and the new allocation mode's separate actual result. The existing catchable-stack diagnostic remains a known limitation; this allocator supplies no sticky stack-failure signal and does not close the aggregate A3 gate or permit catalog installation. Any proposal to address that limitation or host allocation separately requires explicit reviewed scope.
4. Record exact code/lock SHA, commands, RED/GREEN outputs and failures. Full Cargo tests and format must pass before source freeze; get an independent Sol/Claude review. No package/CI/pilot eligibility or R11 C03/C14 closure follows from these resource-only diagnostics.

If accounting, callback safety, memory-limit enforcement or sticky detection cannot be proved within this bounded wrapper, stop and report the failed subgate without introducing an allocator workaround or weakening acceptance.
