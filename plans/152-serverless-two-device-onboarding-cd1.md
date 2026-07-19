# Plan 152: Serverless two-device onboarding — the CD1 gate (composes 150 + 151)

## Status

TODO (proposed draft — not yet reviewed or resumed by the operator). BLOCKED on Plans 150
and 151.

## Un-parking record (requires explicit operator sign-off before execution)

`TOWNSHIP_BUILD_MAP.md` §4a parks LAN discovery, QR camera onboarding, cross-device pairing
state exchange, physical-device behavior, and iOS, and `plans/README.md` forbids new work
there. This plan **narrowly un-parks two items for the desktop-packaged composition only**:

- LAN pairing discovery/advertise (Plans 072-075 artifacts), and
- cross-device pairing state exchange (Plans 110-114 artifacts),

because CD1 — the operator's stated centerless-demo goal — is unreachable without a way for
two devices to find each other and exchange pairing material with no server. iOS, physical
Android devices, new Android release probes, and live-camera QR variants **stay parked**; the
composition runs on desktop packaged apps (QR image import and deep links suffice). Per the
build map's own rule, the requirement was questioned first: the boundary being crossed is
recorded here, scoped to exactly these two items, and this section must be countersigned in
the §4a text when this plan starts.

## Objective

Compose the existing pairing pieces plus Plans 150/151 into one founder-and-guest ceremony
that discharges **CD1**:

> On one LAN, with no Phoenix and no operator-hosted server: a founder's packaged app
> originates a Township community root, enables host mode, and issues a pairing offer (QR
> image / deep link / LAN advert). A guest's packaged app on a second machine imports the
> offer under the armed confirmation policy, authenticates to the founder's device, pulls
> genesis, and exchanges its keys. The founder admits the guest's transport key and grants a
> v5 delegation through the in-app ceremony; the guest posts; W0-W3 beats run from both
> devices; both apps and the founder-hosted source converge to `Lattice.Sim`; both apps
> restart and converge again; the exported bundle replays green for an outsider.

Planned at commit `ba4d4eff` on `codex/township-build-map`.

## Why this increment

- Plans 150 and 151 remove the two centers (server operator, Phoenix) but still assume
  pairing material moves out-of-band. Onboarding is the last server-shaped dependency:
  today's ceremonies either originate from a LiveView or presume an already-configured
  stable endpoint.
- Nearly every ingredient is `DONE` and idle: QR render/import (067-068), deep-link ingress
  with armed confirmation and no-side-effect trace guard (069-070, 094-097), LAN advert
  receive/advertise (072-075), pairing state exchange (110-114), bounded root authority
  origination (115-116), the v5 grant ceremony (138), and desktop onboarding convergence
  (118-120). They were proven as isolated probes and never composed into one serverless
  join. Composition — with the trust rules below — is the remaining work.

## Critical trust separation

- **The pairing offer is rendezvous material, not authority.** It carries the carrier
  endpoint (host LAN address, port), replica id, wire/session versions, transport mode, and
  the trust-anchor set needed to verify pulled frames — public facts only. Possession of an
  offer yields, at most, an authenticated read of already-public signed bytes once the
  founder admits the guest's transport key. Capability still arrives only as an in-log v5
  delegation signed by the founder's resident key through the full review/sign/Sync
  ceremony. Three distinct admission moments — offer issued, transport key admitted,
  delegation granted — must stay separate in code, UI copy, and tests.
- **Key exchange is public-key exchange.** The guest generates its own transport and
  resident keys in its own native custody; only public keys travel (guest→founder via the
  pairing state-exchange channel; founder→guest inside the offer's trust anchors). Stop-grade
  rule: no private key, seed, or capability secret ever enters an offer, advert, deep link,
  QR, or exchange payload.
- **Imported offers are untrusted input.** The armed confirmation policy (094-095) and
  no-side-effect trace guard (097) govern every ingress path including LAN adverts: an
  advert may only *surface a candidate*; import requires explicit user confirmation; nothing
  is stored, connected, or trusted before that. LAN adverts are unauthenticated hints by
  construction — the offer's trust anchors, confirmed by the human channel (reading the QR /
  link from the founder's screen), are what the guest actually trusts. The plan must not
  claim advert authenticity.
- **Founder admission is deliberate.** The guest's exchanged transport key appears in the
  founder's host UI as a pending admission; the founder explicitly admits it to the
  allowlist (Plan 150's admission seam) and separately, optionally, grants the v5
  delegation (Plan 151's in-app producer). Auto-admission is a STOP condition.
- Everything else — frame verification, local authority, quarantine, explicit Sync,
  restart durability — is inherited unchanged from Plans 147/148/150/151.

## Architecture

### Offer construction and ingress

- Extend the existing pairing payload (`township_pairing_qr.ts`,
  `township_pairing_deeplink.ts`, `township_pairing_discovery.ts` and their `_source`
  modules) with the host-endpoint variant: a versioned offer schema whose decoder rejects
  unknown versions, extra fields, and any secret-shaped material. One schema serves QR
  image, deep link, and LAN advert; the advert carries only enough to render a candidate
  card plus fetch nothing.
- The founder's host UI (Plan 150) renders the offer QR, copies the deep link, and toggles
  the LAN advertiser; the guest's onboarding UI lists LAN candidates alongside the existing
  import paths, all funneling into the armed confirmation policy.

### Join sequence (all existing seams, one order)

1. Founder: in-app root origination (115/116 desktop path) → host mode on (150) → offer out.
2. Guest: import + confirm offer → transport key generated → state-exchange payload
   (110-114 artifacts) delivered to the founder (QR/deep-link back-channel, symmetric with
   the offer).
3. Founder: admit guest transport key (150 admission seam) → guest authenticates, pulls
   genesis, verifies against offer anchors, saves pairing.
4. Founder: prepare/review/sign/Sync v5 grant to the guest's resident key (151 producer,
   138 ceremony); guest pulls, persists evidence, authors its first post, Syncs.
5. Both devices run the remaining storyline beats via the 151 instrument.

### The CD1 packaged gate

- Primary: two packaged apps in two isolated OS user accounts on one macOS host (the
  hosted-CI approximation of two machines), loopback-plus-LAN binding, driving the full
  ceremony above with `Lattice.Sim` as the oracle at every beat, both-app restart
  convergence, and the outsider bundle replay. A documented manual two-machine LAN run
  (founder on one Mac, guest on another) is recorded as evidence but CI does not depend on
  physical second hardware.
- Refusal matrix: unconfirmed advert does nothing; tampered offer (version, replica,
  anchor) refuses at decode or at first verified pull; unadmitted guest cannot
  authenticate; admitted-but-ungranted guest can read and cannot author
  (`no_capability` quarantine on attempt, per the Plan 130 control pattern); a second
  community's offer cannot cross-pair a saved replica.

## Public TDD seams

1. Offer schema seam: encode/decode round trip across QR/deep-link/advert carriers;
   secret-material rejection; unknown-version and extra-field refusal; advert renders a
   candidate only.
2. Join-sequence seam (headless): founder-side origination + host + admission and
   guest-side confirm + exchange + pull + verify against fixtures, each stage refusing on
   the matrix above, with the three admission moments independently observable.
3. Grant-and-first-post seam: the admitted guest's v5 grant, evidence persistence, first
   authored post, and Sim equality across founder source, founder app, and guest app.
4. CD1 packaged seam: the full two-account ceremony, storyline beats, both-app restart
   convergence, and bundle replay, wired as the CD1 hard CI step.

## Scope

- The versioned host-endpoint offer schema and its three carriers; guest candidate UI; the
  back-channel state-exchange composition; founder pending-admission UI.
- The four seams and the CD1 packaged gate in CI; the documented manual two-machine run.
- §4a countersigned un-parking edit; plan index, build map (CD1 closure), status and
  non-claim updates.

## Non-goals

- No iOS, physical-device, or new Android-probe claim; no live-camera QR work.
- No offer distribution beyond QR image, deep link, and LAN advert; no Internet rendezvous,
  TLS, NAT traversal, or public deployment.
- No advert authentication claim; no multi-founder, host-migration, or federation (M6)
  surface; no cross-device private-key or capability transfer.
- No new action version; no succession/v7; no E2EE/M3; no compaction; no receipt-free W4.
  CD1 is a demo gate: it does not claim G1/Phase G completion, production readiness, or any
  security property beyond those already proven by its constituent plans.

## STOP conditions

- Stop if any private key, seed, or capability secret appears in an offer, advert, link,
  QR, or exchange payload, or if pairing import stores/connects/trusts anything before
  explicit confirmation.
- Stop if guest admission becomes automatic, or if the offer/admission/grant moments merge
  in code or UI.
- Stop if an unauthenticated LAN advert is treated as trusted, or docs claim advert
  authenticity.
- Stop if the CD1 gate passes with any Phoenix process, operator-run server, or in-process
  founder shortcut in the loop.
- Stop if the §4a edit widens beyond the two named items, or any parked mobile/iOS work is
  reopened.
- Stop if any constituent plan's gate (150 host seams, 151 storyline, v1-v6, 146 seams) is
  weakened to make composition pass.

## TDD plan

1. SCHEMA RED/GREEN: the offer schema seam across all three carriers.
2. SEQUENCE RED/GREEN: the headless join-sequence seam and its refusal matrix.
3. GRANT RED/GREEN: the grant-and-first-post seam with Sim equality on three surfaces.
4. CD1 RED/GREEN: the packaged two-account ceremony + storyline + restarts + bundle
   replay; then the documented manual two-machine LAN run.
5. DOCS RED/GREEN: §4a countersign, CD1 closure text, index, build map, non-claims.
6. VERIFY: focused suites, both typechecks, full `npm run app:convergence`, OTP 28
   `mix verify`/`mix check`, Sobelow boundaries, xref baseline, formatting/diff, hosted
   three-job green at the exact tip.
7. REVIEW: written-plan, un-parking sign-off, per-seam, packaged, docs, and release-diff
   reviews with no unresolved P0-P2 finding.
