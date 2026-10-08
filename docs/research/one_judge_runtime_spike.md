# One judge runtime spike (plan 185): decision record

**Verdict: NO-GO (2026-10-08).** The vector-equality threshold was not met: 5 of the 68 signed
vectors do not match. That mismatch is a plan 185 STOP condition, so the spike stopped at step 3.
Steps 4 to 6 (the Tauri webview, the macOS measurements, Android) were **not run**. Every row that
depends on them reads "not measured" below. The plan's thresholds were not adjusted.

**Operator decision needed.** Either accept this NO-GO and its consequence from the plan (the index
records a freeze: no new TypeScript semantic module without an operator decision, and plan 188
carries `authority.ts` in lockstep), or rule on the finding below and resume. The finding is a
`Lattice.Carrier.Wire` admission rule that the native server shares. Resuming would mean a separate
core plan for that rule, or an operator adjustment of the vector-equality threshold or the corpus,
followed by steps 4 to 6 on this branch. This spike does neither.

## What was run

- Base `442da5f07` (plan 182 policy), plus this branch's commits for plan 185 steps 1 to 3.
  Nothing under `apps/lattice_core/lib/`, `clients/lattice-client/src/` or
  `clients/treehouse-tauri-shell/` was edited.
- Host: MacBookPro18,2, Apple M1 Max, 10 cores, 32 GiB, macOS 27.2 (build 26B5091g).
- Browser toolchain: OTP 29.0.6, Elixir 1.20.4-otp-29, Popcorn npm/Hex `0.4.0-next.0` with the
  `crypto` runtime, and Vite 7.3.6.
- Server toolchain (cold-VM check only): OTP 28.3.1 and Elixir 1.19.5-otp-28.
- Browser: Playwright 1.61.1, headless Chromium 149.0.7827.55. Node v26.10.0.
- Spike baseline, browser toolchain, in `apps/lattice_popcorn_spike`:
  - `npm ci`, `npm run prepare:shared`
  - in `browser/`: `mix deps.get`, `mix test` (6 passed), `mix format --check-formatted` (clean)
  - `npm test` (9 passed), `npm run build` (succeeds)
- Vector harness: `npm run e2e:vectors` writes `apps/lattice_popcorn_spike/evidence/vectors.json`,
  which is committed. The run started at 2026-10-08T04:03:22Z and took about 4 s.
- Regression check after step 3: `npm run e2e` and `npm run e2e:replicas` both passed (8 and 7
  checks). They ran against the proof Gateway (`scripts/server.exs`, server toolchain) and the built
  preview.
- Hosted runs: none of this branch. It was not pushed and no workflow was dispatched. The latest
  green hosted `popcorn-spike.yml` `browser-proof` run is
  [37718664268](https://github.com/treetopdevs/lattice/actions/runs/37718664268) on `81a712360`. That
  run predates the vector harness.

Evidence tier (plan 182 rule 1): every number here is **local**, from one Mac. Nothing in this
record is a hosted, packaged or physical claim.

## Thresholds

| Criterion | GO requires | Measured | Met |
|---|---|---|---|
| Vector equality | every loaded vector's quarantine and holders equal; skips not "mismatch" | 63 of 68 equal on `[id, reason]` pairs, quarantine ids, holders and full state. 5 mismatch (frames refused at decode). 7 skipped because they have no `oracleCarrierOps`. | **No** |
| macOS cold start to first verdict | ≤ 3,000 ms, median of three | Not measured: STOP at step 3, so the Tauri variant was never built. Context only, not a criterion value: headless Chromium on this Mac, one run, 607 ms from navigation to first verdict (VM boot 443 ms). | Not measured |
| Memory with the 4,000-op log | ≤ 300 MB process RSS | Not measured: STOP at step 3, so the synthetic log was never generated. Context only: BEAM `:erlang.memory(:total)` was 17,618,416 bytes in Chromium after the 68 vectors. That is BEAM accounting, not RSS. | Not measured |
| Bundle | ≤ 16 MB raw, ≤ 6 MB compressed | `dist/judge/` was never built. The spike `dist/` it would copy, from `dist/build.json`: 12,944,260 bytes raw (30 assets, without the `.tar.gz` copies); 5,588,302 bytes compressed (`.tar.gz` for OTP tarballs, gzip estimates for the rest) | Spike `dist/` is under both limits; `dist/judge/` not measured |
| CSP | boots with `'wasm-unsafe-eval'`, or operator accepts `'unsafe-eval'` | Not tested in Tauri. The Chromium harness ran only under the spike's research CSP, which includes `'unsafe-eval'`; `crossOriginIsolated` was `true`. | Not measured |
| Android | recorded (pass, fail or not attempted) | Not attempted (STOP at step 3). The toolchain is present; see below. | Recorded |

## Vector results

`evidence/vectors.json` records, for each vector, the file hash, the pass flag, in-BEAM `elapsed_us`
with decode/deliver/analyze/reduce phases, the structural delivery report, and both verdicts on any
mismatch. In summary: 68 loaded, 63 passed, 5 failed, 7 skipped, and no page errors.

**Ed25519:** every frame in the 63 decodable vectors went through `Lattice.Sync.deliver/2`, so
`Op.valid?/1` (`:crypto` Ed25519) re-verified it inside the Worker. Not one was rejected or
quarantined as a structural signature failure. The STOP condition about `:crypto.verify/5` did
not occur.

**How the comparison works:** the `vector_verdict` Worker command runs the shared
`Authority.analyze/2` and `Reduce.reduce/3` over the decoded frames. The harness compares:

- quarantine `[id, reason]` pairs with `expectAtFullFrontier.authorityQuarantine`, sorted;
- quarantine ids with `expectAtFullFrontier.quarantine`;
- each role holder, as a realm name, with the vector's state field of that name;
- the whole state with `expectAtFullFrontier.state`.

The state comparison reproduces the exporter's `state_json/3` shaping in `browser/lib/judge.ex`.
`township_carrier_w1` has no `authorityQuarantine`, so its quarantine is compared by id only.

**Skipped (7, none for mismatch):** `township_join_w0`, `township_partial_log_lww` and
`township_random_{101,202,303,404,505}`. They carry only TS-shaped `ops`, with no signed frames for a
BEAM judge to decode. The 16 files in the vector subdirectories are not authority-verdict vectors and
were not loaded (as in `conformance.ts`).

**Mismatches (5).** In each, `Lattice.Carrier.Wire.decode_op/1` refuses one or two frames as
`malformed_op`. The frame names an atom that does not exist in the browser VM, and Wire never creates
atoms from input. The oracle had admitted the same op and judged it:

| Scenario | Unknown atom | Refused op (oracle verdict) | Effect in the browser judge |
|---|---|---|---|
| `township_authority_unattenuated_transfer` | `:seize_records` | `j7nS4wac` (`invalid_transfer`) | vector refused; the decodable subset has equal state and no reasons |
| `township_authority_undeclared_role_tick` | `:ghost` | `1Q6vFawA`, `t596FwFd` (`malformed_term`) | vector refused; the decodable subset has equal state |
| `township_beacon_witnessed_certificate_metadata` | `:nested` | `0nPrhWXD` (`unauthorized_beacon`) | 3 descendants stay pending; 1 of 4 reasons; state equal |
| `township_beacon_witnessed_policy_metadata` | `:nested` | `j2DzjP5s` (**honored**) | 5 descendants stay pending; **state differs** in `clerk` and `title` |
| `township_policy_target_reason_taxonomy` | `:malformed` | `lbfHvJHP` (`malformed_command`) | 10 descendants stay pending; 0 of 9 reasons; **state differs** in `events` |

The "decodable subset" columns come from a diagnostic. On refusal, the Worker re-judges only the
frames it can decode. That result is never counted as agreement.

**Cause.** The cause is not specific to Popcorn. The same five vectors fail under native OTP 29
(`mix run` in `browser/`). They also fail under the **server** toolchain: in a cold OTP 28 VM with
all 141 non-Mix-task `lattice_core` modules loaded, `Wire.decode_ops/1` returns `malformed_op` for
all five. They decode only after `Mix.Tasks.Lattice.ExportVectors` is loaded, because its source is
the only place these four atoms appear as literals. So the oracle verdicts depend on the exporter
module being resident. Whether a native judge admits such an op depends on which modules happen to be
loaded. The TypeScript judge decodes names as strings and does admit them. The browser judge
reproduces the native BEAM's cold-VM behaviour exactly. On these adversarial inputs it disagrees
with both the oracle and the TypeScript judge: on log membership in all five, and on materialized
state in two.

**Timing context (Chromium, not a threshold):** across the 63 passing vectors (354 frames), the
in-BEAM total was 200,723 µs. The median per vector was 2,639 µs. The maximum was 17,550 µs, for
`toolshed_custody_consent`, the first vector judged, of which 8,420 µs was decode. The median page
round trip was 6 ms. These logs are 1 to 21 ops. Do not extrapolate them to the 4,000-op threshold.

## Compile findings

- The domain set compiled under Elixir 1.20.4 with `--warnings-as-errors`, with **no warnings and no
  hard errors**. That set is 13 files copied byte-for-byte from `apps/lattice_core/lib/`:
  - `lattice/demo/thread.ex`, `lattice/authority/consent.ex`
  - `township/matter.ex`, `township/election_board.ex`
  - `toolshed/shed.ex`, `toolshed/tool.ex`
  - `treehouse/space.ex`, `thread.ex`, `invitation.ex`, `transport_catalog.ex`,
    `member_continuity.ex`, `member_continuity_certificate.ex`, `member_continuity_authoring.ex`
- The domain set also includes the byte prefix of `lib/mix/tasks/lattice.export_vectors.ex` that
  defines `DualAuthorityFixture` and `PolicyFixture`. The prefix is trimmed of its trailing blank
  line so `mix format --check-formatted` passes.
- `dist/build.json` records the hash of every added file, of the prefix, and of the full exporter.
- `Jason` is needed by `Treehouse.TransportCatalog` (`Jason.decode/1`) and
  `Treehouse.MemberContinuityAuthoring` (`Jason.encode!/1`). `{:jason, "~> 1.4"}` resolved to 1.4.5,
  the server lock's version. It packs as `jason.tar`: 155,648 bytes, 42,959 bytes as `.tar.gz`.
- The other schemas pull in no further modules. No core module failed to compile, so that STOP
  condition did not occur.

## CSP

Not tested in the Treehouse webview. Step 4 was not reached, and no
`src-tauri/tauri.judge-spike.conf.json` exists. Whether Popcorn boots under `'wasm-unsafe-eval'`
alone, and whether Tauri delivers COOP/COEP on macOS, remain open. Chromium was crossOriginIsolated
under the spike's own headers, but it says nothing about WebKit or Tauri.

## Android

Not attempted, because of the STOP at step 3. The toolchain is present on this host:

- NDK `27.1.12297006`
- Rust targets `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android` and
  `x86_64-linux-android`
- AVD `seesend_api34`
- no attached device (`adb devices` is empty)

## To resume (only after an operator decision)

1. Decide how a BEAM judge admits an op that names an atom it has never loaded. Today the native
   server and the browser both refuse it, while the exporter VM and TypeScript admit it. That
   decision is a core change and belongs in its own plan, not here. Alternatively, adjust the
   threshold or corpus and record the adjustment.
2. Re-run `npm run e2e:vectors`.
3. Then run steps 4 to 6 as written:
   - the judge-spike Tauri variant and its COOP/COEP and CSP check;
   - three cold macOS launches;
   - the 4,000-op Thread log;
   - the Android attempt.
