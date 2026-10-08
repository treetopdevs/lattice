# One judge runtime spike (plan 185): decision record

**Verdict: NO-GO (2026-10-08).** Vector equality was not met because of a pre-existing core
`Lattice.Carrier.Wire` atom-vocabulary defect that also fails natively. All other desktop rows were
measured as shown below. Re-decide after that defect is fixed.

The desktop rows below contain a second, independent blocker: **the macOS Treehouse webview cannot
boot the Popcorn runtime.** Tauri does deliver COOP/COEP there (`crossOriginIsolated` is `true`), but
WKWebView exposes no `SharedArrayBuffer`, and Popcorn needs it to start its Worker. The in-app loop
therefore judged no vectors on macOS, and the cold-start and memory rows could not be met there. This
is the substance of the plan's header STOP condition. Fixing `Wire` alone would not turn this record
into a GO.

**Operator decisions needed:**

1. The fix to `Lattice.Carrier.Wire`'s atom-vocabulary-dependent decoding. This is a core change and
   belongs in its own plan.
2. Separately, whether a judge runtime that needs `SharedArrayBuffer` remains a candidate for the
   Treehouse desktop webview, given that macOS WKWebView does not expose it under Tauri 2.11.5.

The plan's thresholds were not adjusted. The reviewer overrode the step 3 STOP so that steps 4 to 6
could run; the results are below.

## What was run

- Base `442da5f07` (plan 182 policy), plus this branch's commits for plan 185 steps 1 to 7.
  - Nothing under `apps/lattice_core/lib/`, `clients/lattice-client/src/` or
    `src-tauri/tauri.conf.json` was edited.
  - The shell change consists of one new config file, one new page module, one gated branch in
    `main.ts`, and one npm script.
- Host: MacBookPro18,2, Apple M1 Max, 10 cores, 32 GiB, macOS 27.2 (build 26B5091g).
- Browser toolchain: OTP 29.0.6, Elixir 1.20.4-otp-29, Popcorn npm/Hex `0.4.0-next.0` (`crypto`
  runtime).
- Server toolchain: OTP 28.3.1, Elixir 1.19.5-otp-28.
- Tauri: CLI 2.11.4, `tauri` 2.11.5, `wry` 0.55.1, rustc 1.93.1.
- Chromium: 149.0.7827.55 (Playwright 1.61.1). Node v26.10.0.
- Android: NDK 27.1.12297006 and JDK 17.0.16 (the Gradle-provisioned Temurin).
- Commands and their evidence files (committed under `apps/lattice_popcorn_spike/evidence/`):
  - `npm run e2e:vectors` (Chromium) writes `vectors.json`.
  - `npm run tauri:build:judge-spike`, then `node test/tauri-judge-macos.mjs` (three cold launches),
    writes `tauri-macos.json`. Per-launch traces go to
    `~/Library/Application Support/dev.treetop.lattice.treehouse.judgespike/`.
  - `tauri android build --debug --apk --target aarch64` with the judge-spike config, then
    `node test/tauri-judge-android.mjs`, writes `tauri-android.json`.
  - Chromium context measurements write `chromium-context.json`.
- Regression checks:
  - Spike: `npm test` 9 passed; in `browser/`, `mix test` 6 passed and `mix format
    --check-formatted` is clean.
  - Spike Chromium gate: `npm run e2e` (8 checks) and `npm run e2e:replicas` (7 checks) passed after
    step 3.
  - Shell: `npm test` passed.
- Hosted runs: none of this branch. It was not pushed and no workflow was dispatched.

Evidence tier (plan 182 rule 1): every number here is **local**, from one Mac and one emulator.
Nothing in this record is a hosted, packaged-CI or physical-device claim.

## Thresholds

| Criterion | GO requires | Measured | Met |
|---|---|---|---|
| Vector equality | every loaded vector's quarantine and holders equal; skips not "mismatch" | **Chromium:** 63 of 68 equal on `[id, reason]` pairs, quarantine ids, holders and full state; 5 mismatch (Wire refuses their frames; also fails natively); 7 skipped (no `oracleCarrierOps`). **Tauri macOS and Android in-app loop:** 0 vectors judged, because the runtime never booted. | **No** |
| macOS cold start to first verdict | ≤ 3,000 ms, median of three | **No verdict in any of three cold launches.** Launch to judge page loaded: 1,216 / 673 / 660 ms (median 673). Popcorn boot never completed: launch 1 failed with `timeout:init` (result posted 11,491 ms after launch); launches 2 and 3 had not completed or failed within 45 s. Chromium context only: cold browser launch to first verdict 1,677 / 955 / 999 ms (median 999). | **No** |
| Memory with the 4,000-op log | ≤ 300 MB process RSS | **Not measurable in Tauri** (no boot). Peak RSS during the failed macOS boot, launches 1/2/3: WebContent 207,456 / 207,984 / 207,648 KB; app process 142,400 / 141,824 / 140,848 KB. Chromium context only, 4,004-op log: largest Chromium process RSS 332,736 KB before the verdict, peaking at 488,000 KB; BEAM `:erlang.memory(:total)` 18,277,728 bytes after it. | Not measured in Tauri; Chromium context is above the limit |
| Per-op reduce time, 4,000-op log | (recorded) | Chromium: 7,904,970 µs in-BEAM for 4,004 ops (1,974 µs per op on average; `analyze` 7,182,344 µs), 9,259 ms round trip in 88 chunks. Native OTP 28, same pipeline: 8,588,275 µs (`analyze` 7,581,131 µs). The browser verdict equals the native one: quarantine (none), holders and state. Tauri: not measurable. | Recorded (Chromium and native) |
| Bundle | ≤ 16 MB raw, ≤ 6 MB compressed | `dist/judge/` from its `build.json`: 12,950,737 bytes raw (30 assets, without the `.tar.gz` copies) and 5,591,179 bytes compressed (`.tar.gz` for OTP tarballs, gzip estimates for the rest). On disk, with both copies embedded: 16,816,432 bytes. The judge-spike `.app` is 20,216 KiB on disk, with a 20,695,888-byte executable. | **Yes** |
| CSP | boots with `'wasm-unsafe-eval'`, or operator accepts `'unsafe-eval'` | **Tauri macOS: boots with neither.** `'self' 'wasm-unsafe-eval'` gives `timeout:init` after 10 s. `'self' 'unsafe-eval'` produced neither a boot nor an error within 60 s on two activated launches. The cause is the missing `SharedArrayBuffer`, not the CSP. Isolated Chromium: `'wasm-unsafe-eval'` suffices; `'self'` alone aborts (wasm compile blocked). | **No** (blocked by `SharedArrayBuffer`) |
| Android | recorded (pass, fail or not attempted) | **Fail**, with the exact failure recorded in the Android section below. | Recorded: fail |

## Vector results (Chromium, step 3)

`evidence/vectors.json` was re-run on the final code. It records, for each vector:

- the file hash and the pass flag;
- the in-BEAM `elapsed_us`, split into decode, deliver, analyze and reduce phases;
- the structural delivery report;
- both verdicts on any mismatch.

Summary: 68 loaded, 63 passed, 5 failed, 7 skipped, and no page errors. The VM booted in 348 ms,
the first verdict arrived 490 ms after navigation, and BEAM memory was 17,553,440 bytes after the 68.

**Ed25519:** every frame of the 63 decodable vectors passed through `Lattice.Sync.deliver/2`. That
means `Op.valid?/1` (`:crypto` Ed25519) re-verified each one in the Worker. None was rejected or
quarantined as a structural signature failure.

**How the comparison works:** the `vector_verdict` Worker command runs the shared
`Authority.analyze/2` and `Reduce.reduce/3`. The harness then compares:

- the sorted quarantine `[id, reason]` pairs with `authorityQuarantine`;
- the quarantine ids;
- each role holder, mapped to its realm name;
- the whole state, shaped as the exporter's `state_json/3`.

`township_carrier_w1` has no `authorityQuarantine`, so its quarantine is compared by id only.

**Skipped (7, none for mismatch):** `township_join_w0`, `township_partial_log_lww` and
`township_random_{101,202,303,404,505}`. They carry only TS-shaped `ops`, with no signed frames for a
BEAM judge to decode. The 16 files in the vector subdirectories are not authority-verdict vectors and
were not loaded (as in `conformance.ts`).

**Mismatches (5).** In each, `Lattice.Carrier.Wire.decode_op/1` refuses one or two frames as
`malformed_op`. The frame names an atom that does not exist in the VM, and Wire never creates atoms
from input. The oracle had admitted the same op and judged it:

| Scenario | Unknown atom | Refused op (oracle verdict) | Effect in the browser judge |
|---|---|---|---|
| `township_authority_unattenuated_transfer` | `:seize_records` | `j7nS4wac` (`invalid_transfer`) | vector refused; the decodable subset has equal state and no reasons |
| `township_authority_undeclared_role_tick` | `:ghost` | `1Q6vFawA`, `t596FwFd` (`malformed_term`) | vector refused; the decodable subset has equal state |
| `township_beacon_witnessed_certificate_metadata` | `:nested` | `0nPrhWXD` (`unauthorized_beacon`) | 3 descendants stay pending; 1 of 4 reasons; state equal |
| `township_beacon_witnessed_policy_metadata` | `:nested` | `j2DzjP5s` (**honored**) | 5 descendants stay pending; **state differs** in `clerk` and `title` |
| `township_policy_target_reason_taxonomy` | `:malformed` | `lbfHvJHP` (`malformed_command`) | 10 descendants stay pending; 0 of 9 reasons; **state differs** in `events` |

The "decodable subset" columns come from a diagnostic. On refusal, the Worker re-judges only the
frames it can decode. That result is never counted as agreement.

**Cause (core, pre-existing):**

- The same five vectors fail under native OTP 29.
- They also fail under the server toolchain, in a cold OTP 28 VM with all 141 non-Mix-task
  `lattice_core` modules loaded. They decode only after `Mix.Tasks.Lattice.ExportVectors` is loaded,
  because its source is the only place those four atoms appear as literals.
- So whether a native judge admits such an op depends on which modules happen to be loaded. The
  TypeScript judge decodes names as strings and does admit them.
- The browser judge reproduces the native cold-VM behaviour exactly.

## macOS Treehouse webview (steps 4 and 5)

- **Variant:** `npm run tauri:build:judge-spike`.
  - The spike is built with base `/judge/` into `dist-judge/`, and the Tauri build copies it into the
    shell's `dist/judge/`.
  - `src-tauri/tauri.judge-spike.conf.json` sets:
    - COOP `same-origin` and COEP `require-corp`;
    - the ordinary CSP plus `worker-src 'self' blob:`, `script-src 'self' 'wasm-unsafe-eval'` and the
      loopback collector in `connect-src`;
    - its own identifier and product name, so it never shares data with an installed Treehouse.
  - `main.ts` loads `src/judge_spike.ts` by dynamic `import()` only when
    `VITE_TREEHOUSE_JUDGE_SPIKE=1`; that module navigates to `/judge/judge.html`.
  - The page calls no native command. No native code was added, so the app cannot write a file
    itself. The page fetches vectors from, and posts results to, the harness collector on
    `127.0.0.1:47185`, and the collector writes the per-launch trace into the variant's app data
    directory.
- **Ordinary build unchanged:**
  - `npm run build` emits the same `index-DCPb7iod.js` (sha256 `498d874d…`) and `index-BBoUOGW_.css`
    as a build of the base `main.ts`.
  - `grep -c -i popcorn dist/assets/*.js` returns `0`, `grep -c -i -E "judge|47185"` returns `0`, and
    `dist/` has no `judge/` directory.
  - `tsx test/packaged_bundle_variant.ts` passes, and so does the shell's full `npm test`.
- **Results across the 17 macOS launches made in this session:**
  - Every recorded page event reported `crossOriginIsolated: true`.
  - `typeof SharedArrayBuffer` was `"undefined"` wherever it was recorded: on the page, and inside a
    dedicated Worker, where `crossOriginIsolated` is `false`.
  - No launch booted Popcorn.
  - Traces are overwritten per run; the three final launches are the committed `tauri-macos.json`.
- **Why that blocks boot:** Chromium reproduces the same `timeout:init` when the page is not
  cross-origin isolated, with `DataCloneError: SharedArrayBuffer transfer requires
  self.crossOriginIsolated`, and boots in 359 ms when it is. Popcorn 0.4.0-next.0 therefore requires
  `SharedArrayBuffer`.
- **Harness notes:**
  - WebKit throttles a window that is not frontmost so hard that its boot timers stall, so the
    harness activates the app after launching it.
  - Even so, some launches neither complete nor fail within the timeout.

## Other findings

- **Popcorn bridge cap:** in Popcorn 0.4.0-next.0, one JS-to-VM message above roughly 64 KiB never
  reaches the VM. A 100-frame vector (54,766 bytes of frame JSON) went through in 86 ms. 400 frames
  (215,818 bytes) and 800 frames did not arrive within 60 s. The spike therefore sends large vectors
  as base64 chunks of 24 KiB of frame JSON (`vector_chunk`, then `vector_verdict_buffered`). A product
  judge would need that seam for any log above about a hundred ops.
- **Quadratic analysis:** `Authority.analyze/2` dominates the 4,004-op verdict both natively
  (7.58 s) and in Chromium (7.18 s). The browser runtime is not the bottleneck.
- **Compile:** the 13 domain files and the exporter fixture prefix compiled under Elixir 1.20.4
  `--warnings-as-errors` with no warnings and no errors. `Treehouse.TransportCatalog` and
  `Treehouse.MemberContinuityAuthoring` call `Jason`, so the browser project depends on `jason`
  1.4.5.

## Android (step 6)

**Fail.** The judge-spike debug APK builds for aarch64 in 192 s. It uses the judge-spike config with
the identifier pinned back to `dev.treetop.lattice.treehouse`, because the Gradle project requires
that identifier. The `.so` embeds `/judge/judge.html`, `/judge/assets/beam-CjoXtISj.wasm` and the OTP
tarballs.

The run used the existing AVD `seesend_api34`: Android 14, API 34, arm64, Android System WebView
113.0.5672.136. It was started with `-read-only -no-snapshot-save`, to avoid persisting changes to
that AVD.

- Every launch whose logcat was checked (four judge-spike launches, one ordinary launch) ended with
  the same Rust panic, about 10.4 to 11.6 s after launch on the three judge-spike launches whose start
  time was recorded:
  `wry-0.55.1/src/android/main_pipe.rs:417:26: called Result::unwrap() on an Err value: "SendError(..)"`.
  That is the `GetUrl` reply sent to a dropped receiver.
- The ordinary debug APK panics identically on the same emulator, so the crash is not caused by the
  judge spike.
- Before the crash, the collector received no events. About 2 s in, the DevTools target was still on
  `http://tauri.localhost/` (the shell page), and the renderer did not answer CDP `Runtime.enable`.
- `crossOriginIsolated`, Worker boot, time to first verdict and memory on Android: **not measured**.
- No physical device was attached.

## To re-decide

1. Fix the `Wire` atom-vocabulary admission rule in a separate core plan, then re-run
   `npm run e2e:vectors`.
2. Resolve or accept the macOS `SharedArrayBuffer` gap. Options include a Popcorn build without
   threads, a WKWebView or Tauri setting that exposes `SharedArrayBuffer`, or a different desktop
   host for the judge. Then re-run `npm run tauri:build:judge-spike` and
   `node test/tauri-judge-macos.mjs`.
3. For Android, rerun on a WebView newer than 113, or on a device, once the wry `GetUrl` panic is
   understood. That panic affects the ordinary app as well.
