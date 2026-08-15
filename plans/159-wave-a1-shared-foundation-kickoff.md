# Plan 159: Wave A1 kickoff — shared beta foundation (DRAFT)

## Status

DRAFT — execution kickoff for Plan 158 "Wave A1: shared foundation". This document adds no new
scope; every ticket boundary, exit gate, and stop condition is Plan 158's. It pins the baseline,
the worktree/branch layout, per-ticket file ownership, the first RED tests, and the operator
checklist so three subagents can start without touching each other's seams.

## Baseline

- **Fork point:** `origin/main` at `a5db3ba358beb959ed2fe046caab106d62e693b9`
  (PR #34 merge, witness-branch cleanup). Flagship workflow run `29866991551` is green at exactly
  that SHA (verified 2026-07-22). This satisfies Plan 158 merge-protocol step 1 for all three
  Wave A1 tickets, whose only dependency is the Shared Beta Contract (Plan 158 itself, merged).
- **Drift note:** Plan 158 was planned at `9b14bc8e`. The delta since (PRs #31–#34: instrument
  evidence, witness seam 10, witness cleanup) touches none of the Wave A1 seams. No re-plan needed.
- **Main checkout state:** `/Users/nicholas/develop/lattice` currently holds the uncommitted
  Plan 077 iOS-hardware probe work on `codex/plan077-ios-hardware`. **Decision required before
  kickoff:** land or park that branch (commit + push the WIP at minimum). The main checkout is the
  root integrator's seat and must be clean to run the merge queue. Worktree 2 extracts seams from
  the same shell tree Plan 077 edits — do not run both concurrently against different bases.

## Coordination rules (root integrator)

- Root owns: dependency decisions, shared-interface freezes, PR publication, review closure,
  merges, hosted CI evidence, and the stale Toolshed/Treehouse M2 language update from the
  Shared Beta Contract ticket.
- **One agent per hot file:** `.github/workflows/flagship.yml` (Worktree 3), lockfiles
  (`package-lock.json`, `mix.lock` — coordinate through root), generated mobile projects
  (`src-tauri/gen/android`, `src-tauri/gen/apple` — Worktree 2), `carrier.ts` / vector exporters
  (frozen this wave; nobody edits), `src-tauri/src/lib.rs` native state (Worktree 2).
- Merge order: Worktrees 1 and 2 are independent and may merge in either order. Worktree 3's CI
  job addition to `flagship.yml` merges last in the wave, after root review, to keep the workflow
  file serialized.
- Every PR follows Plan 158's ten-step merge protocol verbatim, including RED evidence
  preservation and exact merge-SHA green on `main`.

## Toolchain invocations (all worktrees)

Per `AGENTS.md`: never bare `mix` — the mise shim is broken and default Erlang is 27.

```bash
PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix verify
```

Node-side: invoke tools via `node_modules/.bin/` directly (the npm shell wrapper recurses), and
run `mix compile` before mix tasks that might use a stale `_build/dev`.

## Worktree 1 — Pilot Carrier Runtime

- **Branch:** `codex/beta-carrier-runtime` · **Dir:** `../lattice-beta-carrier` · **Owner:** carrier agent

```bash
git -C /Users/nicholas/develop/lattice worktree add ../lattice-beta-carrier -b codex/beta-carrier-runtime a5db3ba358beb959ed2fe046caab106d62e693b9
```

**Scope (Plan 158 §Pilot Carrier Runtime):**

1. Production Mix release + manifest-driven supervisor around existing `LatticeCarrierServer`
   instances (`apps/lattice_carrier_server/lib/…/{application,holder,listener,web_socket}.ex`).
2. Replace the seed-in-command-line entrypoint with fail-closed secret-file loading. No identity
   material in argv, env dumps, or logs.
3. Unauthenticated `/livez`; content-free `/readyz` requiring identity load, complete source
   restore, listener availability, writable durable storage. `/carrier` auth unchanged.
4. Persist-before-ack durability on the supported Linux path: write temp file, `fsync` file,
   atomic rename, `fsync` containing directory, only then acknowledge a relay.
5. Missing/corrupt identity, manifest, or log ⇒ refuse startup; never create a new community.

**File ownership:** `apps/lattice_carrier_server/**`, its `mix.exs` release definition, new
`rel/` + runtime config. Touches nothing under `clients/` or workflow YAML.

**First RED tests (write before implementation, preserve RED evidence):**

- acknowledged relay op survives `kill -9` + restart from the same paths (RED today: ack is not
  fsync-ordered);
- startup with a missing/corrupt identity file refuses rather than minting a fresh identity;
- service seed passed via argv is rejected / no longer supported.

**Gates:** `mix verify`, `mix check`, both boundary Sobelow checks (boundary change). Full test
list and exit wording: Plan 158. **Non-claims:** no HA, no multiplexed protocol, no E2EE.

## Worktree 2 — Product Isolation and Migrations

- **Branch:** `codex/beta-product-isolation` · **Dir:** `../lattice-beta-isolation` · **Owner:** shared mobile-runtime agent

```bash
git -C /Users/nicholas/develop/lattice worktree add ../lattice-beta-isolation -b codex/beta-product-isolation a5db3ba358beb959ed2fe046caab106d62e693b9
```

**Scope (Plan 158 §Product Isolation and Migrations):**

1. Extract only the product-neutral seams from `clients/township-tauri-shell`: native signer,
   database, outbox, carrier client, pairing, QR. Township stays behaviorally green throughout.
2. Introduce the product manifest carrying the Plan 158 isolation table (app ID
   `dev.treetop.lattice.township`, scheme `township://`, key service
   `dev.treetop.lattice.township.carrier`, database `township-v1.sqlite3`, alias
   `township-pilot-v1`) plus the Toolshed/Treehouse rows, and the collision test.
3. Native, transactional SQLite storage: per-product file, migration ledger, product marker.
   Fail closed on marker mismatch, interrupted migration, future schema.
4. Migrate Township's supported JSON state once; private seeds never leave the platform key store.

**File ownership:** `clients/township-tauri-shell/**` including `src-tauri/src/lib.rs` and the
generated `gen/android` / `gen/apple` projects; any new shared package (e.g.
`clients/lattice-mobile-core`). This is why Plan 077's dirty tree must be resolved first.

**First RED tests:** the migration matrix as failing contracts — fresh install, current-schema
reopen, interrupted-migration rollback, one N-1→N upgrade, future-schema refusal, cross-product
file refusal. Start with future-schema refusal and product-marker mismatch (both RED today: no
database exists).

**Exit (Plan 158):** Township green; three unique product manifests; cross-product scheme/db/key
access refuses; migration matrix passes on desktop and Android.

## Worktree 3 — Signed Android Internal Distribution + Device A harness baseline

- **Branch:** `codex/beta-android-distribution` · **Dir:** `../lattice-beta-android` · **Owner:** device/CI agent

```bash
git -C /Users/nicholas/develop/lattice worktree add ../lattice-beta-android -b codex/beta-android-distribution a5db3ba358beb959ed2fe046caab106d62e693b9
```

**Scope (Plan 158 §Signed Android Internal Distribution + non-destructive harness baseline):**

1. Replace debug signing on `tauri:android:build:release` with an external pilot keystore
   supplied only through CI secrets; alias `township-pilot-v1`; cross-product signing refused.
2. Monotonic version codes; signed universal-or-ARM64 APK; emit SHA-256, signing fingerprint,
   git SHA, machine-readable build manifest.
   Main distribution uses a disjoint high band; branch/throwaway builds use a low band monotonic
   along each first-parent branch, with git SHA + APK SHA-256 as the exact build identity.
3. Hosted Android build + signature verification + artifact upload + install/upgrade smoke as a
   new `flagship.yml` job (hot file — root reviews the YAML diff before merge).
4. Release hardening: real CSP; WSS-only non-loopback peers; compile out dev traces, environment
   probes, seeded-key paths (the existing `*:release:*probe*` script family stays dev-only).
5. Harness baseline (non-destructive only this wave): `ANDROID_SERIAL`-selected install, launch,
   force-stop, structured launch/process outcomes, network class, and a JSON/Markdown
   evidence bundle keyed by git SHA + APK hash + capture/run identity; release run requires an explicit non-debug pilot-cert
   pin and fails if any `adb reverse` mapping exists; never persist raw screenshots/general logcat,
   delete a mapping it did not create, or retain serials, keys, capability payloads, QR contents, or
   user content. Post-install evidence requires the signed `base.apk` signer and exact SHA-256 to
   match the pre-install artifact; unreadable OEM app paths are a distinct result.

**Device A signer-mismatch protocol (verbatim constraint):** Device A carries the exact-main
debug-signed baseline. The harness must detect the signer mismatch, capture only the
baseline signing/device metadata without capturing user-visible pixels or general logcat, **stop**,
and request explicit operator approval before uninstalling only
`dev.treetop.lattice.township`. Uninstall/`pm clear` is never automatic.

**First RED tests:** `apksigner` on the release artifact must report the pinned pilot
certificate — RED today (`CN=Android Debug`); release APK string-scan finds no probe/env-seed
markers — capture current state first.

**Exit (Plan 158):** pinned pilot cert; clean install + signed N→N+1 upgrade on Device A;
artifact downloadable by testers; no secret in logs or artifacts.

## Operator checklist — external inputs to start chasing now

Code starts immediately; these block **exit gates**, not kickoff. Report missing items as
external prerequisites; never paper over with localhost, self-signed TLS, or an emulator.

| Input | Blocks | Status |
|---|---|---|
| Pilot keystore: 3 aliases, cert fingerprints, keystore/password CI secrets, encrypted backup, named custodian | Worktree 3 exit | ☐ |
| Linux host + admin access + fsync-honest filesystem, DNS name, inbound 443, cert-renewal egress, patch/alert owner | Wave A2 (WSS Deployment) | ☐ |
| Encrypted off-host backup destination, scoped creds, separately held recovery key, clean restore host, 24 h RPO sign-off | Wave A2 | ☐ |
| Carrier secrets: service identity, per-product catalog signer, TLS/ACME material, admission manifests — secret files with inventory + rotation record | Wave A2 | ☐ |
| Device B (unrelated physical Android) | Township two-phone gate | ☐ |
| Apple Developer / App Store Connect authority + physical iPhone | Wave E only — **not** this wave | ☐ |

## Explicitly out of scope this wave

WSS deployment, replica catalog, application-policy context (`command_op_status/3`), Township
empty-boot, post-edit parity, anything iOS (Plan 077 probe work parks; per Plan 158, iOS archive
work starts only after the Township Android candidate), Toolshed/Treehouse code.

## Wave A2 trigger

When all three Wave A1 tickets have exact merge-result `main` CI green: operations agent starts
WSS Deployment and Recovery; BEAM policy + TS parity agents start the parity-atomic
`command_op_status/3` PR; first free worker takes Replica Catalog and Lifecycle.
