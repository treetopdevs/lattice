# Plan 296: Treehouse Mobile (React Native / Expo — iOS First, Android Next)

## Status

IN PROGRESS (M0 started 2026-11-25). Focuses on the small-group chat UI/UX over the existing
Lattice 2.0 substrate (`@treetopdevs/lattice-client` + `@treetopdevs/lattice-shell-kit`) against
the live WSS testbed (`https://lattice-demo-wss.fly.dev`).

## Objective

Build a native-feeling small-group chat mobile app for **Treehouse** (`clients/treehouse-mobile/`)
using **React Native (Expo Prebuild / Dev Client)**, shipping **iOS first** and **Android next**,
that solves the real UX tensions of a capability-attested, offline-first, no-central-authority
messenger without duplicating any cryptographic or protocol logic.

## Honesty & Contract Boundaries

- Follows [Plan 178](178-treehouse-contract-correction.md): text-only posts (no media, reactions,
  polls, or attachments in v1), recipient-bound invitations (never bearer links), and calm D1 relay
  disclosure (*"The relay holds a plaintext copy and can go offline, but cannot forge messages or
  change membership"*).
- Does **not** claim E2EE, production log compaction (D3 thread rollover is the stand-in), catalog
  replacement trust (R11c), or physical-device evidence until tested on real hardware.
- Every milestone claims only the evidence tier it actually ran (Core / Simulator / Physical).

## The 6 UX Problems This Plan Solves

1. **Identity without accounts:** Device-bound Ed25519 key in iOS Keychain / Android Keystore
   (`expo-secure-store`), paired with local petnames and deterministic color identicons so users
   see *"Sarah"*, not raw base64 pubkeys.
2. **Recipient-bound invites without friction:** Turn the 4-step handshake
   (`JoinRequest -> Invite -> Acceptance -> Admit+Grant`) into a guided 2-scan in-person QR wizard
   with Share Sheet fallback and crash-safe resume for interrupted handshakes.
3. **Honest delivery & offline states:** Show 3 truthful states (**Saved on phone** →
   **Queued offline** → **On relay**), never a fake "Delivered to Sarah."
4. **Capabilities & quarantine without jargon:** Only surface actions the user's current grant
   allows; explain lapsed/revoked grants calmly; tuck the full **Verify & Audit** DAG/quarantine
   inspector into a progressive-disclosure sheet.
5. **Group lifecycle honesty:** Thread rollover (archived read-only thread linking cleanly to its
   successor) and honest member removal (*"Removed from future posts; they keep messages already on
   their phone"*).
6. **Calm relay disclosure (D1):** One plain-English trust card in onboarding and Group Info.

## Technical Architecture

- **Package:** `clients/treehouse-mobile/` (Expo + TypeScript + `expo-router`).
- **Direct repo reuse (3rd shell on the shared kit):**
  - `@treetopdevs/lattice-client` — canonical CBOR, Ed25519 (`@noble/curves` + `react-native-get-random-values` Hermes polyfill), `Treehouse.Space`/`Thread` reducers, authority judge, `CarrierWebSocketClient`.
  - `@treetopdevs/lattice-shell-kit` — `createRouteValidators`, `createRelayConnector`, `syncRoutes`, `createFeedController`.
  - `@treetopdevs/lattice-mobile-core` — QR/deep-link/handoff helpers (`pairing_qr.ts`, `pairing_deeplink.ts`, `pairing_handoff.ts`).
- **Native mobile custody (`src/native/`):**
  - **Keys:** `expo-secure-store` (iOS Keychain `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, excluded from iCloud backup; Android Keystore in M4).
  - **Storage:** `expo-sqlite` (WAL mode, serialized writes — prevents Plan 141 outbox/log overwrite races) for frames, outbox, acks, routes, and local petnames, with an in-memory fallback for Node/unit tests.
  - **Sync lifecycle:** Foreground `ops_available` WebSocket push via `createFeedController`; clean socket teardown on `AppState` background + immediate `syncNow()` on foreground resume.
  - **QR & Sharing:** `expo-camera` + `react-native-qrcode-svg` + native Share Sheet / `treehouse://` deep links.

## Information Architecture (iOS-First)

1. **Onboarding:** Welcome & Honest Trust Card → **Start a Group** or **Join a Group** (shows Join QR + Share).
2. **Tab 1 — Threads (Home):** Group header with live connection pill (`Live` / `Offline · N queued` / `Reconnecting`), active threads list, collapsible Archived Threads, `+ New Thread` (gated on `caps.canCreateThread`).
3. **Thread Chat Screen:** Native inverted `FlatList`, grouped text bubbles, local petname + identicon, honest delivery pills, long-press sheet (**Copy**, **Edit**, **Hide**, **Verify Signature**), archived read-only banner.
4. **Tab 2 — People & Invites:** Member list with role pills (`Founder`, `Moderator`, `Member`), editable local petnames, guided 2-scan QR Invite Wizard, **In-Progress Invites** recovery list, and admin member controls (Transfer Moderator, Remove Member).
5. **Tab 3 — Group Info & Safety:** Relay status (`wss://`, per-route `gen#`, Sync Now, Offline test toggle), **Verify & Audit** DAG/quarantine sheet, and Space frame export.

## Phased Milestones

| Milestone | Scope | Exit Proof |
|---|---|---|
| **M0 — Expo Shell & WSS Foundation** | Scaffold `clients/treehouse-mobile`, wire `lattice-client` + `lattice-shell-kit`, `expo-secure-store` + `expo-sqlite` (WAL), Hermes crypto polyfill, and live WSS connection screen. | Typecheck + unit/WSS gate green against `https://lattice-demo-wss.fly.dev`; iOS Simulator boots and syncs live. |
| **M1 — Core Chat Loop on iOS** | Onboarding, Threads list, Thread Chat screen (post, offline queue + heal, edit, tombstone, archive, signature receipt). | Live iOS Simulator ↔ Browser (`lattice-demo-wss.fly.dev`) real-time chat + offline/online convergence. |
| **M2 — In-Person QR Invite & People UX** | 2-step QR + Share Sheet enrollment wizard, interrupted-ceremony resume, member list, local petnames, moderator transfer, honest removal. | End-to-end invite/accept/admit flow without manual config editing. |
| **M3 — iOS Polish & Audit UX** | Thread rollover UX, lease-expiry warnings, Verify & Audit drawer, dark mode, haptics, keyboard polish, TestFlight build. | Usable on 2+ real iPhones over `wss://`. |
| **M4 — Android Parity** | Android Keystore via `expo-secure-store`, camera/QR permissions, Android insets/back gesture, APK build. | Real iPhone ↔ Android in-person QR join + offline/online chat over `wss://`. |
