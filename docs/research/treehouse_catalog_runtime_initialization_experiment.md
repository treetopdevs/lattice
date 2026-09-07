# Root adoption: isolated runtime initialization repair

Adopted 2026-09-07 UTC under the user-authorized unified Treehouse program after independent Sol review passed with no P0-P2. Exact proposal SHA-256: `fc6378b86a12817bcd4fa7d96ec0d18720127fe651ce84908e9973b0eefed1b0`; review SHA-256: `0be184dc7e84725fc1e96308f75f875bac39eabd4986cefeee4479d58c411a91`. The retained proposal-only wording records review-time provenance; this adoption authorizes its bounded experiment and exact upstream source patch, subject to implementation review and its mandatory gates. Baseline `7c6dc7d4048f42a2bab98453279589ae058e623a` remains preserved.

The 4096-attempt safety ceiling is a stop with partial evidence if reached, never permission to truncate a sweep and call it complete. No catalog runtime, native installation, whole-process resource bound or pilot eligibility is approved here.

---

# Proposed isolated runtime initialization repair

Proposal only; no repository, registry source or dependency has changed. The immutable resource-only baseline is `7c6dc7d4048f42a2bab98453279589ae058e623a` in `/Users/nicholas/develop/lattice-treehouse-r11a-runtime-20260907`. Its 20 diagnostics and independent Sol review pass as characterization; the mandatory initialization gate still fails with SIGSEGV. This packet is for independent review and root adoption under the unified program before implementation.

## Exact repair and provenance

The pinned `rquickjs-core` 0.11.0 calls `JS_SetDumpFlags` before checking the result of `JS_NewRuntime` or `JS_NewRuntime2` for null. The engine debug setter dereferences that pointer. It also returns early if `Opaque::initialize` fails after runtime creation, leaving runtime allocations unfreed. The latter is source-grounded and requires a separate fault-injection RED; it has not been measured yet.

Vendor only the exact core crate archive within the unpublished experiment at `clients/treehouse-catalog-runtime-spike/vendor/rquickjs-core-0.11.0/`, retaining every archive file exactly before the stated raw.rs patch. The exact core archive has 78 files totaling 632,108 bytes and declares MIT but omits LICENSE. Add only `LICENSE` from the exact same upstream VCS commit, downloaded from `https://raw.githubusercontent.com/DelSkayn/rquickjs/c99675e50201d74554d0f667094f800e1287001b/LICENSE`; SHA-256 `0517c7f76916dcc6557b3c0e1c077f14dd05bfe8e0d7d2a2fa298fe0d49a790a`. Record this sole additive license file separately from the archive manifest, preserving its copyright and permission text. The retained original license artifact is `/tmp/lattice-treehouse-execution-20260906/r11a-rquickjs-upstream-LICENSE`. The registry archive SHA-256 must be `b8bf7840285c321c3ab20e752a9afb95548c75cd7f4632a0627cea3507e310c1`; its VCS record is `c99675e50201d74554d0f667094f800e1287001b`, path `core`. Do not edit the shared Cargo registry or external source. Record an exact original per-file manifest and an applied-patch SHA; every archived vendored file except `src/runtime/raw.rs` must remain byte-identical to the archived source; the sole additional LICENSE must match its separately pinned upstream source. Include no registry-generated `.cargo-ok` marker.

Use a `[patch.crates-io]` override for `rquickjs-core` only in this standalone crate's Cargo.toml. The Cargo.lock core package becomes the same 0.11.0 path package; every other package version, checksum, dependency edge and activated feature remains exact. Keep the rquickjs top-level version exactly 0.11.0 and the existing QuickJS sys/C engine untouched. No shipped-shell manifest, lock, source, build script or feature is modified. Do not claim this as an upstream release or fix.

The exact two-hunk patch is preserved below. Both constructors validate NonNull before any runtime use. If class metadata initialization fails, call JS_FreeRuntime while the allocator holder and stack-owned Opaque are still alive, then return the existing error unchanged. There is no installed runtime opaque pointer and no Rust class instance at this construction stage; do not run the normal RawRuntime Drop implementation, which expects an installed opaque. Successful constructors keep the existing initialization order, opaque installation and ownership transfer. Review the full pinned Opaque initialization and engine cleanup paths before accepting the patch; if an additional ownership or callback requirement appears, stop for a revised packet.

## Required evidence and bounded testing

1. Preserve the actual unpatched 64-byte child SIGSEGV artifact and immutable baseline; before applying the patch, add a genuine expected-refusal regression that fails on that child exit. The repaired child must exit successfully after asserting typed AllocationFailure, sticky allocation failure, zero live charged bytes and no completed guest output. It must not silently raise the minimum allocation cap or skip runtime creation.
2. Add private `cfg(test)` fail-on-N allocation-attempt controls around the existing budget allocator, with checked fixed counters and no production fault mode. Record actual successful Runtime::new_with_alloc and Context::full allocation-attempt counts with an ordinary control first; bound each sweep by that measured count plus one, with an absolute safety ceiling of 4096 attempts. One fresh observer/runtime per failure index. Do not generate machine-wide exhaustion. A failure injection is simulated allocator refusal, distinct from genuine 64-byte budget failure and 32MiB exhaustion.
3. Sweep each constructor/context allocation boundary using the real public Runtime/Context APIs, not direct fabricated private runtime objects. Null constructor failures must return an error, not crash, and release all charged blocks. Any successful retry after an injected failure still has a sticky failure and cannot be a harness success. Drop every returned context/runtime before asserting zero live charge. Cover a failure after a nonnull raw runtime when Opaque class registration allocates; record a real pre-patch failure/leak when reachable, or explicitly report it unexercised if no allocation boundary reaches it rather than claiming dynamic coverage. Use subprocess isolation for crash-prone initial RED and sweep runs; do not let one process crash erase remaining cases.
4. Constructor success, context success, genuine caught/uncaught/queued OOM, exact plausible completed-output diagnostics, default missing-sticky OOM characterization, deadline, cancellation-at-settlement and stack characterization must retain their results. Keep all fault fixture bytes unchanged. Test repaired debug and release build modes under the matching installed Rust toolchain; this is not sanitizer, Android, x86 or device proof.
5. Run locked full Cargo tests including empty doctests and format, compare dependency/features and vendor hashes, and obtain independent exact-source review of both raw constructors, allocator lifetime and the diagnostic tests. No upstream crate tests or new test dependencies are required for this narrow experiment; unavailable sanitizer/Miri proof stays open.

The experiment remains resource-only. Even if this gate passes, caught stack exhaustion, hard native input/output/host-allocation bounds, deterministic actual catalog bundle A1, native catalog parity A2, aggregate A3, Android and native C03/C14 remain OPEN. The patch does not authorize catalog installation, a verifier bundle, host primitives, production compaction or participant custody. Original failed results remain recorded; a passing patched gate must identify the patched dependency explicitly.

## Source boundary

Only standalone experiment Cargo.toml/Cargo.lock, its new vendor source/provenance/patch, private budget allocator test controls, constructor probes/tests and experiment documentation may change after adoption. Existing library execution plumbing may change only to expose accurate private initialization-failure diagnostics needed by these tests, with review if that needs a new public seam. Do not change the default fault fixtures, product files, Core, TS, shared vectors, CI, pilot plans or global toolchains. Root owns the adoption document and final ledger.

## Exact proposed patch

```diff
--- a/src/runtime/raw.rs
+++ b/src/runtime/raw.rs
@@ -145,11 +145,16 @@
     pub unsafe fn new_base(mut opaque: Opaque<'static>) -> Result<Self> {
         let rt = qjs::JS_NewRuntime();
 
-        Self::add_dump_flags(rt);
-
         let rt = NonNull::new(rt).ok_or(Error::Allocation)?;
 
-        opaque.initialize(rt.as_ptr())?;
+        Self::add_dump_flags(rt.as_ptr());
+
+        if let Err(error) = opaque.initialize(rt.as_ptr()) {
+            // No runtime opaque or Rust class instances have been installed yet.
+            // Keep the allocator holder alive until all runtime blocks are freed.
+            qjs::JS_FreeRuntime(rt.as_ptr());
+            return Err(error);
+        }
 
         let opaque = Box::into_raw(Box::new(opaque));
         unsafe { qjs::JS_SetRuntimeOpaque(rt.as_ptr(), opaque as *mut _) };
@@ -173,11 +178,16 @@
 
         let rt = qjs::JS_NewRuntime2(&functions, opaque_ptr as _);
 
-        Self::add_dump_flags(rt);
-
         let rt = NonNull::new(rt).ok_or(Error::Allocation)?;
 
-        opaque.initialize(rt.as_ptr())?;
+        Self::add_dump_flags(rt.as_ptr());
+
+        if let Err(error) = opaque.initialize(rt.as_ptr()) {
+            // No runtime opaque or Rust class instances have been installed yet.
+            // Keep the allocator holder alive until all runtime blocks are freed.
+            qjs::JS_FreeRuntime(rt.as_ptr());
+            return Err(error);
+        }
 
         let opaque = Box::into_raw(Box::new(opaque));
         unsafe { qjs::JS_SetRuntimeOpaque(rt.as_ptr(), opaque as *mut _) };
```
