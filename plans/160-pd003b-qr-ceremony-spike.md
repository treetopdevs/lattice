# Plan 160: PD-003-B — Toolshed QR ceremony physics spike

## Status

PROPOSED — a bounded research spike under Plan 158's parallel-research allowance ("the arrows are
merge dependencies, not a ban on research in parallel"). It merges no product code, changes no
Plan 158 sequencing, and widens nothing in Plans 150–152. Its only deliverable is measured
evidence for the "Toolshed QR Co-Signing" ticket, produced *before* the three tickets ahead of it
(Custody v2 Semantic Repair → Isolated Shell → Product Workflows) absorb their investment.

Authored 2026-07-22 against `codex/plan077-ios-hardware` @ `764a1945` (main @ PR #34 merge
`a5db3ba3`, flagship `29866991551` green — the Wave A1 baseline pinned by Plan 159).

## Context — brainstorm capture (PD-003-B session, 2026-07-22)

The session asked what "the real Toolshed mobile app" is and converged on:

1. **The tap carries the op bytes.** The QR exchange at the door transports the actual signed
   consent and transfer bytes device-to-device — the handoff needs zero connectivity, ever. The
   carrier is later convergence, never the first durable copy. (Plan 158's "Toolshed QR
   Co-Signing" ticket independently pins exactly this: offer QR A → response QR B → receipt QR C,
   airplane-mode gate.)
2. **T0–T4 are one primitive.** Join-by-vouch, borrow, return, and steward transfer are all
   "two phones physically together exchange signed bytes" — one ceremony state machine with
   payload variants, plus a read-only inventory screen, *is* the minimal whole app.
3. **The receipt-now / converge-later model.** Ops are self-certifying, so the receiving phone
   verifies signatures at the door even when it lacks causal ancestors, durably stores the bytes,
   and renders "pending integration" until sync supplies the deps. What the tap hands you is a
   cryptographic receipt, not a promise.
4. **Riskiest assumption = gate ⑤ physics.** The one-pager makes sub-ten-seconds a hard product
   gate. Nothing currently scheduled ahead of the QR Co-Signing ticket tests whether three
   camera scans of real-payload QR codes between two phones can fit inside it. If the physics
   fail, the correct response is a transport decision (multi-part/animated QR, BLE-assist, NFC),
   and that decision reshapes the Product Workflows and Isolated Shell tickets — so it must be
   learned first, not last.

Parked ideas from the session (out of this spike, recorded for later): NFC transport, photos on
listings, multi-shed membership, reminder ergonomics, iOS ceremony timing (sequenced behind the
Android candidate per Plan 158).

## Objective

Retire the gate-⑤ physics risk with a throwaway two-phone harness: measure whether the complete
network-free three-QR borrow ceremony, carrying **real canonical bytes at custody-v2-projected
sizes**, completes in under ten seconds phone-to-phone — and produce the payload-size and
scan-reliability tables the QR Co-Signing ticket needs, before upstream tickets commit to a
QR-only transport.

## Scope

- A spike harness under `spikes/qr-ceremony/` (new top-level directory, clearly non-product):
  a minimal camera+QR web/Tauri page per phone role, importing `clients/lattice-client` for real
  canonical encoding, Ed25519 signing/verification, and consent payload construction. In-memory
  keys are acceptable — the spike claims nothing about custody.
- Payloads at **v2-projected sizes**: today's v1 consent shape is known-insufficient (Plan 158
  names the P0 binding failures), and v2 binds more fields (request kind/ref/body, direction,
  parties, tool, loan terms, grant ID, due epoch). The spike pads each QR payload to a
  conservative v2 estimate derived from the frozen field list in Plan 158's Custody v2 section,
  so the timing is not optimistically small. A generated size table (payload → CBOR bytes →
  QR-encoded bytes → QR version/error-correction level) is a deliverable.
- The three-QR ceremony exactly as the QR Co-Signing ticket defines it: offer A (grant +
  offer), response B (request + canonical consent), receipt C (final transfer); both devices
  durably store bytes (harness-local storage suffices) before rendering success.
- Timing protocol verbatim from Plan 158: airplane mode, both apps warm, terms pre-reviewed;
  clock starts when the borrower confirms response B, stops when both phones have durably stored
  and rendered the identical final transfer after C; three consecutive camera-only runs; setup
  and human reading time recorded separately.
- The stale-device path: one phone artificially missing causal ancestors verifies signatures
  structurally, stores durably, and renders a "pending integration" state — proving the
  receipt-now/converge-later model is implementable, with no semantic-integration claim.
- Adversarial smoke only (not the full v2 matrix, which belongs to the Semantic Repair ticket):
  a tampered payload and a replayed QR B must refuse at the harness layer.
- Hardware: two unrelated physical Android phones. An emulator run is permitted for development
  but is labeled engineering evidence and satisfies no exit criterion (Plan 158 discipline).
- Deliverable: `docs/research/pd003b_qr_ceremony_spike.md` with the size tables, the three
  timing records, scan-failure/retry counts, camera/screen conditions, and a written
  recommendation (QR-only viable / QR with mitigations / escalate transport decision).

## Out of scope — the spike fence

- No merge of harness code into `clients/township-tauri-shell`, `clients/lattice-client`, or any
  product path; the spike branch is deletable after its evidence doc lands.
- No custody v2 implementation, no consent-shape changes, no new op kinds — v2 sizes are
  *estimated*, and the estimate's field list cites Plan 158, not new design.
- No NFC, BLE, or animated-QR implementation. If plain QR fails the gate, the spike's output is
  the measured evidence for that transport decision, not the alternative itself.
- No native key custody, secure-store, deep-link, or permission work (Plan 158 has owned tickets
  for all of these).
- No security or product claim of any kind from spike artifacts; the evidence doc must carry the
  same "engineering evidence, not a beta verdict" language Plan 158 uses.

## STOP conditions

- If the v2-projected payload for any single QR exceeds practical single-code capacity
  (~2.9 KB binary at version 40, realistically ≤ ~1.8 KB for reliable phone-to-phone scanning),
  STOP timing runs and record the multi-part/animated-QR fork as the finding — do not shrink the
  payload below the Plan 158 v2 field list to force a pass.
- If three consecutive sub-ten-second runs are unachievable after reasonable UX iteration
  (auto-advance on decode, no manual shutter), STOP and write the transport-decision
  recommendation; do not relax the timing protocol.
- If the spike starts needing real key custody, carrier connectivity, or product schema changes
  to proceed, it has left spike territory — STOP and hand the requirement to the owning
  Plan 158 ticket.

## Method

1. RED-ish first: generate the payload size table from `lattice-client` canonical encoding with
   a script (`spikes/qr-ceremony/sizes.ts`) before building any UI — if sizes already violate
   the capacity STOP condition, the spike ends there for the price of a script.
2. Build the two-role harness page (display + scan loop, jsQR-or-equivalent vendored locally —
   the harness must run in airplane mode, so no CDN assets).
3. Dry-run the ceremony phone-to-phone with v1-size payloads to shake out camera/UX friction;
   then run the measured protocol at v2-projected sizes.
4. Run the stale-device and adversarial-smoke variants.
5. Write the evidence doc, including the recommendation and the exact harness commit SHA.

## Verification

- `spikes/qr-ceremony/sizes.ts` output committed alongside the evidence doc and reproducible
  from the pinned `lattice-client` version.
- Three timing records with per-scan breakdowns (display→decode latency per QR) and a photo or
  short capture of the physical setup, redacted per Plan 158's camera-evidence practice.
- The evidence doc cross-references the Plan 158 "Toolshed QR Co-Signing" exit text and states
  plainly which parts of that exit this spike does and does not pre-satisfy (it pre-satisfies
  none — it de-risks them).

## Remaining work after the spike

- Feed the size table and timing evidence into the Custody v2 Semantic Repair ticket (payload
  budget is now a design input, not an afterthought) and the QR Co-Signing ticket.
- If the recommendation is "QR with mitigations" or "escalate," schedule the transport decision
  as its own short ADR before the Toolshed Isolated Shell ticket starts UI work.
- Delete the spike branch once the evidence doc is merged; the doc, not the code, is the asset.
