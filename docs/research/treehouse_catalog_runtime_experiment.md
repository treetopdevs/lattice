# R11a native catalog verifier experiment

Root adopted 2026-09-07 UTC under the authorized unified implementation program.
Only slice A below is adopted. The native storage, install, review and transport
slices B/C in the original proposal remain unadopted and C03/C14 remain OPEN.

## Exact scope and independent review

Actual Claude Fable reviewed the original proposal, SHA256
`2e6789056c7146363d24de0bc351f6dae704aa02810b6f0d66b27653541dc3ad`.
Its result accepted the bounded native experiment with three sharpenings, all
adopted here. The source composition is `08085f696f6b94288a5b9550ed88311b7f525e92`:
reviewed TS catalog recovery at `40263ce98ad00314628b6ca4e3c9cc264e601a93`
plus root R11a wiring. The separate BEAM repair is still under review.

The original proposal and review are archived with the execution evidence at
`/tmp/lattice-treehouse-execution-20260906/r11a-durable-installed-adapter-proposal.md`
and `fable-r11a-native-adapter-proposal-result.md`. This document is the standalone
implementation contract; those temporary artifacts are provenance only.

## Implementation container and dependency admission

Use only a new standalone `clients/treehouse-catalog-runtime-spike/` containing
its Rust Cargo manifest/lock, source/tests, fixed TS entrypoint, deterministic
bundle builder and generated source manifest/bundle, README and local fixtures.
This location deliberately keeps the experiment outside both shipped shells.
Do not add a runtime, dependency, command, generic script evaluator or success
status to either product. Do not change existing TS/BEAM production files, existing
vectors, native custody, SQLite, carrier transport, CI or global toolchains.

Admit `rquickjs = "=0.11.0"` with a checked-in Cargo.lock and the exact transitive
QuickJS-NG source/checksums. Default allocator only: no `allocator`, `rust-alloc`,
`parallel`, loader, filesystem/network/system modules or downloaded bytecode.
Android-only `bindgen` may be evaluated and recorded in the spike, not a claim of
Android support. Other dependencies must reuse exact versions already locked in
the repository (sha2, serde/serde_json, url and base64 where needed), or first
propose an exact addition. Bundle with esbuild exactly `0.28.1` and the current
client dependency lock; admit it directly only inside the spike's package/lock.
No package upgrade or new trusted authority implementation is authorized.

The versioned upstream Runtime documentation and README were independently
opened by root on 2026-09-07 UTC. They confirm the custom-allocator memory-limit
caveat and omit Android from shipped/tested target rows:
[Runtime API](https://docs.rs/rquickjs/0.11.0/rquickjs/struct.Runtime.html),
[versioned README](https://raw.githubusercontent.com/DelSkayn/rquickjs/v0.11.0/README.md).

## Fixed execution and host boundary

Load only the compiled-in bundle of the actual existing catalog preparation,
evaluation and route-candidate functions. Native selects the entrypoint and
passes public JSON as data, never executable interpolation. No caller scripts,
keys, randomness, signing callbacks, webview, Tauri commands, dynamic imports or
native object lookup. One invocation/runtime on its own worker; drain all Promise
jobs under the same monotonic deadline and destroy the context on termination.
Unresolved promises with no pending jobs fail. Resolve transient WeakMap-backed
routes in the same invocation; they remain installation-required candidates.

Supply the exact primitives used by the bundle: strict TextEncoder/TextDecoder
(UTF-8, fatal errors, BOM and lone surrogate behavior), typed arrays and standard
collections, browser atob/btoa with Buffer absent, SHA-256 digest returning an
owned ArrayBuffer/Promise, WHATWG URL behavior through the already pinned native
url implementation, and structured clone for the actual closed values. Do not
substitute an ad-hoc relaxed URL parser or generic JSON stringify/parse clone.

Startup uses behavioral known-answer probes, not merely property presence.
Assert Buffer is absent. Compare UTF-8/BOM/surrogates, malformed UTF-8, numeric
IPv4 aliases/userinfo/ports/whitespace, base64 invalid inputs, SHA-256 and clone
independence/type behavior against the real Node/browser paths. A missing or
present-but-divergent primitive is runtime startup failure, never a persisted
semantic verdict on valid history.

## Measurement limits and mandatory failure proof

Experiment limits only: 512 MiB JS heap, 2 MiB JS stack, 30-second monotonic
deadline, one outstanding evaluation, up to 8,192 signed operations and 16 MiB
raw public history. Record exact separate native input/output/copy allocation
bounds before accepting data. These are measurement stop bounds, not pilot,
healing, native witness or shipping capacity policy. Never truncate evidence.

Prove out-of-band sticky OOM/deadline/cancellation detection even when JavaScript
catches an exception and returns a plausible semantic refusal. No late result may
be accepted. If the default engine cannot expose reliable sticky OOM status,
record that gate as failed and stop at an honest partial experiment. Do not enable
a custom allocator, patch upstream, classify OOM from error text, use a heap
high-water sample as proof, or weaken the requirement without a separately
reviewed exact amendment. No durable intake fence exists in this spike.

## Executable acceptance

1. A1: bundle the same source from two distinct absolute checkout paths with
   repository-relative resolution. Require byte-identical output, stable relative
   source manifest and dependency/source hashes. A second machine remains a named
   hosted gate until executed. Reject dynamic imports and Node/system modules.
2. A2: run genuine independent BEAM and TS fixtures through actual native bundle
   execution; compare exact bytes, IDs, cutoffs, authority/application/trust and
   route/refusal results in both delivery orders. Port the existing trust negative
   corpus without replacing its verifier or manufacturing verdicts. Retain raw
   duplicate-dependency, malformed, invalid-signature and high-epoch controls.
3. A3: run the behavioral host probes and sticky resource tests above. Compile
   and link Android arm64 with the exact existing NDK/toolchain as a separate
   gate; local native execution is not Android runtime or handset evidence.
4. Preserve every existing signed fixture and production source byte. Capture
   commands, source hashes, failures and final outcomes. No Mix runs needed for a
   standalone Rust/TS experiment; root schedules integration checks separately.

A1/A2/A3 begin OPEN. No result closes C03/C14, install freshness, founder migration,
review/custody, carrier readiness or physical/pilot evidence. Independent review
is required before incorporating any successful experiment into shipped code.
