# Lattice Multi-App Demo Ecosystem (Assisted Local Shortcut)

This guide runs **all three Lattice products** (**Treehouse**, **Township**, and **Toolshed**) live against a **single shared `LatticeCarrierServer` relay**, mixing native desktop, Phoenix LiveView, and browser clients on one signed op-log substrate.

> **Honesty & scope notice:** This is an **assisted local demo**. It uses a plaintext loopback relay, static route configuration, and browser IndexedDB demo custody (`clients/lattice-browser-starter`). It does **not** claim production E2EE, catalog replacement trust (R11c), native mobile custody, or physical-device evidence.

---

## Prerequisites

Prepare the shared TypeScript packages once:

```sh
npm --prefix clients/lattice-client ci
npm --prefix clients/lattice-client run build
npm --prefix clients/lattice-browser-starter install
```

## One-Command Launch

Start the shared relay (`127.0.0.1:4200..4205`), the live **Township Phoenix LiveView** instrument (`http://localhost:4120/township`), and the **Lattice Browser Starter** (`http://127.0.0.1:5180/`):

```sh
scripts/demo_ecosystem_up.sh --reset
```

Then open:

- **Tab 1 (Founder — root / clerk / steward / custody holder):** `http://127.0.0.1:5180/?role=founder`
- **Tab 2 (Neighbor — member / resident / borrower):** `http://127.0.0.1:5180/?role=neighbor`
- **Tab 3 (Township Phoenix LiveView + Vue Causal Replay):** `http://localhost:4120/township`

### Optional: Connect the Native Treehouse Desktop App

While the relay is running, launch a Treehouse desktop demo instance wired to the exact same `founder` or `neighbor` identity and routes:

```sh
scripts/demo_ecosystem_treehouse.sh founder
# or in another terminal:
scripts/demo_ecosystem_treehouse.sh neighbor
```

Paste the printed `treehouse-routes-<role>.json` into Treehouse's Enrollment panel to interoperate live with the browser tabs.

---

## Things to Try Live

1. **Offline Authoring & Partition/Heal (Treehouse):**
   - In the `neighbor` tab, click **Online (Live Push)** to switch to **Offline (Local Outbox)**.
   - Post a message in Treehouse — notice `outbox pending: 1`.
   - Switch back to **Online** — watch the outbox drain and the `founder` tab converge immediately via `ops_available` push.
2. **Cross-Surface Real-Time Audit (Township → Phoenix LiveView):**
   - Post a comment or toggle **Close Matter** in the Township tab.
   - Watch `http://localhost:4120/township` update automatically via `TownshipWeb.CarrierProjection` (`feed: :server_push`).
   - Click **Test Unauthorized Close (Quarantine)** as `neighbor` and observe the quarantine verdict in both the browser DAG Inspector and LiveView.
3. **Dual-Signed Tool Custody, Leases & Overdue Computation (Toolshed):**
   - In the `neighbor` tab under **Toolshed**, click **Request Borrow (:inbox)**, then click **Sign Borrow Consent (Recipient)** and copy the base64 ADR 0007 consent signature.
   - In the `founder` tab, click **Test Unconsented (Quarantine)** first to see `missing_consent` quarantine live.
   - Paste the consent signature, set a due epoch (e.g. `4`), and click **Complete Dual-Signed Handoff**.
   - Click **Advance Beacon Epoch (+1)** past epoch 4 to watch **OVERDUE** compute deterministically from the DAG.
   - Have `neighbor` click **Request Return (:inbox)** and `founder` click **Resolve Return (Tool Home)**.

---

## Automated Verification

```sh
# Fast unit checks (IndexedDB/memory custody, Toolshed ADR 0007 + leases, Township/Shed quarantine)
npm --prefix clients/lattice-browser-starter test

# Full live multi-app gate (real BEAM carrier server + Phoenix LiveView push + 2 TS hosts + BEAM oracle)
npm --prefix clients/lattice-browser-starter run test:live

# Typecheck + production Vite bundle
npm --prefix clients/lattice-browser-starter run build
```
