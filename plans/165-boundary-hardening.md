# Plan 165: Harden three boundaries — the WebView signing oracle, the committed dev secret, and relay rate

> **Executor instructions**: Follow this plan step by step. Run every verification command
> and confirm the expected result before moving to the next step. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 91bb6ca6..HEAD -- clients/township-tauri-shell/src-tauri config apps/lattice_carrier_server
> ```
> If any in-scope file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 — none of these is a live exploit today, but each is a boundary that is one small
  change away from mattering, and two of them contradict claims the repo makes about itself.
- **Effort**: M total (Part B is S; Parts A and C are each S–M)
- **Risk**: MED — a strict CSP can break the Vite dev server; domain-tag gating the signing oracle
  requires enumerating every payload the shell legitimately signs; rate limiting must not break a
  legitimate outbox drain.
- **Depends on**: none technically. `plans/161-close-verification-gaps.md` will surface Part B's
  finding through Sobelow and is blocked on it — land this first if 161 stops there.
- **Category**: security
- **Planned at**: commit `764a1945`, 2026-07-29
- **Reconciled at**: commit `91bb6ca6`, 2026-07-29, after Wave A1 carrier runtime merged
- **Round 4 execution split**: land Part B before plan 161 so Sobelow starts from the corrected
  secret boundary. Land Parts A and C after plans 162–163. Keep the three commits independently
  reviewable on the shared Round 4 integration branch.

## Execution evidence

Recorded on `codex/round4-security-reliability` during the reviewed execution:

- **Part B** landed first. Township development/test secrets now live only in environment-specific
  config, and every `PHX_SERVER` start requires `SECRET_KEY_BASE` without weakening the carrier-only
  release or mandatory manifest contract. The previously committed secret is treated as burned.
- **Part C** installs a per-connection token bucket on relay frames only: a 120-frame burst and
  12-frame-per-second refill match the existing server budget, allow a participant to drain a
  120-operation outbox immediately, and bound a sustained flood. A 121-frame burst test proves the
  refusal is `rate_limited`; reads remain available, and a fresh connection drains three dependent
  operations normally. The existing `relay_failure` telemetry event describes persistence failure,
  so no misleading telemetry event is reused for rate refusal.
- Part C does not edit `Lattice.Log`, `Township.AuditBundle`, `Holder`, or the persistence path.
  Structural quarantine remains complete inside `matter.log`, which remains the audit bundle's only
  trusted root. Holder's persist-before-ack, locking, timeout, durability rehearsal, and moduledoc
  are unchanged. Bounded structural-quarantine storage remains explicitly deferred to a durable
  archive/journal design rather than represented as complete.
- **Part A signing survey** found five live shapes:
  - `carrier-session-v2`: the fixed nine-element carrier handshake transcript, signed by
    `signCarrierChallenge/2`;
  - `lattice-op-v2`: the seven-element canonical operation payload, signed by
    `authorCarrierOp/1`;
  - `lattice-delegation-v2` and `lattice-delegation-v3`: the unleased and leased delegation
    payloads, signed by `authorCarrierDelegation/1`;
  - the exact 21-byte `township-native-probe` readiness challenge from
    `probeTownshipNativeWorkflow/1`.
  Governance succession witnesses use the separate `lattice_sign_governance_witness` command and
  protected governance key, so they are not carrier-signing permissions. The signing ceiling is
  64,000 decoded bytes, matching the carrier connection's complete frame cap; every signable object
  must fit inside such a frame, while session/probe payloads are much smaller.
- Part A also restricts pairing adverts to IPv4 broadcast, private, loopback, or link-local
  destinations. The shipped CSP keeps scripts self-only without `unsafe-eval`; a separate dev CSP
  admits Vite's localhost origin and HMR websocket without weakening the packaged policy. Both CSPs
  admit only the loopback HTTP origins required by the build-time state-exchange probe seam, keeping
  Plans 110–112 functional without a scheme-wide `http:` source. Carrier endpoints remain runtime
  configurable, so `ws:` and `wss:` are intentionally scheme sources; origin pinning requires a
  fixed endpoint and remains a documented residual. The signing prefix allowlist constrains which
  protocol may be signed, not the semantics of a valid delegation or carrier-session transcript; a
  WebView compromise could still request authority-bearing signatures inside those allowed domains.
  Reviewer feedback narrowed both build-time state-exchange validators to the same loopback-only
  HTTP origins as the CSP; `https:` and IPv6 loopback now fail at configuration instead of later at
  WebView fetch time. After that validator alignment and `form-action 'none'` landed, both packaged
  macOS smokes were rebuilt, rerun, and passed functionally. The harness does not capture the WebView
  console, so absence of CSP violation reports is not evidenced. This macOS host has no attached
  Android device or emulator, so the on-device
  `tauri:android:release:browser-state-exchange` gate remains explicitly unrun; the loopback-only
  CSP contract is pinned statically here and must be reverified on an Android host.

## Why this matters

Three independent boundary weaknesses, one per part. They are grouped because each is small and each
is "the control that isn't there yet", not "the bug that is firing."

**A. The participant key never leaves Rust — but its signing authority is fully exposed to the
WebView, and there is no CSP.** Custody itself is correct: no `#[tauri::command]` returns key
material, governance seeds are presence-gated, and the carrier alias is fenced off from the
governance key. But `sign_carrier` signs *arbitrary bytes* with no domain-tag check and no length
check, `lattice_kv_set` accepts arbitrary keys and values, and `tauri.conf.json` sets
`"csp": null`. So any script execution inside the WebView is equivalent to key compromise: it can
sign a delegation granting an attacker key full ops and roles, sign the resulting op, sign a
carrier-session transcript to impersonate the participant to any carrier, and persist all of it —
with no user gesture, unlike the action-intent path, which correctly requires `event.isTrusted`.
There is no reachable injection sink in the shell today (the one `v-html` renders a locally-generated
QR SVG built from a boolean matrix). This is defense-in-depth. The cost if one appears is total.

**B. A dev `secret_key_base` is committed, and `PHX_SERVER` starts a live endpoint in every env.**
`config/config.exs:22-23` holds literal `signing_salt` and `secret_key_base` values.
`config/runtime.exs:11-17` requires `SECRET_KEY_BASE` only under `config_env() == :prod`, but the
`PHX_SERVER` branch at `config/runtime.exs:3-9` — the one that flips `server: true` — runs in **every**
env. So `MIX_ENV=dev PHX_SERVER=1` starts a live endpoint signing LiveView sessions and tokens with a
value that is public in git history. The endpoint binds loopback, which limits blast radius to local
processes and anything fronting it. Because the value is committed, deleting it is insufficient — it
is burned and must be rotated.

**C. Relay has no per-connection rate limit.** Wave A1 replaced the old direct dump path with
`bounded_atomic_dump/3`, a persistence timeout, target locking, durability rehearsal, and explicit
persist-before-ack sequencing. Those controls bound one persistence attempt and protect concurrent
instances, but an authenticated relay realm can still submit relay frames continuously.
`LatticeCarrierServer.WebSocket` has a 64 KB frame cap and a 120 s idle timeout, but no message
rate limit.

After this plan: the WebView can only ask for signatures over recognized payload shapes and runs
under a CSP; the committed secret is rotated out of the tracked config and cannot be the default for
a running server; and a relay peer cannot submit an unbounded burst on one connection.

## Current state

### Part A — the shell's native boundary

`clients/township-tauri-shell/src-tauri/tauri.conf.json:22-24`:

```json
    "security": {
      "csp": null
    }
```

`clients/township-tauri-shell/src-tauri/src/lib.rs:503-518` — the signing implementation:

```rust
    pub fn sign_carrier(&self, key_id: &str, bytes_base64: &str) -> Result<String, String> {
        reject_governance_carrier_alias(key_id)?;
        let bytes = BASE64
            .decode(bytes_base64)
            .map_err(|error| format!("invalid carrier bytes: {error}"))?;
        let signing_keys = self
            .signing_keys
            .lock()
            .map_err(|_| "signing key store lock poisoned".to_string())?;
        let signing_key = signing_keys
            .get(key_id)
            .ok_or_else(|| format!("missing signing key: {key_id}"))?;

        Ok(BASE64.encode(signing_key.sign(&bytes).to_bytes()))
    }
```

`reject_governance_carrier_alias` correctly fences the governance key from the carrier alias — that
guard stays. What is missing is any constraint on **what** is being signed.

The exposed commands (`src-tauri/src/lib.rs`, `#[tauri::command]` fns around `:1237-1320`):
`lattice_kv_get`, `lattice_kv_set`, `lattice_ensure_carrier_key`, `lattice_public_key`,
`lattice_sign_carrier`, `lattice_ensure_governance_witness_key`,
`lattice_governance_witness_public_key`, `lattice_sign_governance_witness`,
`lattice_advertise_pairing_handoff`, and others.

The domain tags the shell legitimately signs, from `clients/lattice-client/src/codec.ts:91-93`:

```ts
const opTag = "lattice-op-v2";
const delegationPayloadTag = "lattice-delegation-v2";
const delegationV3PayloadTag = "lattice-delegation-v3";
```

plus the carrier session transcript tag (`carrier-session-v2` — confirm the exact literal by reading
`apps/lattice_core/lib/lattice/carrier/session.ex` and its TS counterpart in
`clients/lattice-client/src/carrier.ts` around `:260-380` before writing the allowlist). Governance
witness signing goes through a **separate** command with its own key, so it does not need to be in
`sign_carrier`'s allowlist — verify that before assuming it.

`lattice_advertise_pairing_handoff` (`src-tauri/src/lib.rs:1308-1316` → `advertise_township_pairing_handoff`
at `:838-859`) takes a JS-supplied `target_addr` and sends a JS-supplied payload to it over UDP, with
no validation that the address is the broadcast address.

The contrasting good pattern — `clients/township-tauri-shell/src/use_action_intent.ts:229-231`
requires `event.isTrusted` before accept and before sign.

### Part B — the committed dev secret

`config/config.exs:22-23` — two literal values (a LiveView `signing_salt` and an endpoint
`secret_key_base`). **Do not copy either value into any file, commit message, or report.**

`config/runtime.exs` now also contains the Wave A1 carrier-release contract:

```elixir
carrier_release? = is_binary(System.get_env("RELEASE_ROOT"))

case System.get_env("LATTICE_CARRIER_MANIFEST") do
  nil when carrier_release? -> raise "LATTICE_CARRIER_MANIFEST is required for the pilot carrier release"
  nil -> :ok
  carrier_manifest -> config :lattice_carrier_server, manifest: carrier_manifest
end
```

The Part B edit must merge with this live structure. It must not delete or weaken
`carrier_release?`, the mandatory manifest check, or the carrier-only release exemption from
Township configuration. Attach the `SECRET_KEY_BASE` requirement directly to the `PHX_SERVER`
branch in every environment.

`AGENTS.md:84` documents `PHX_SERVER=true PORT=4100 ~/.asdf/shims/mix run --no-halt` as a safe local
command — so the dev path genuinely is used and must keep working.

### Part C — relay rate

`apps/lattice_carrier_server/lib/lattice_carrier_server/web_socket.ex:1-13`:

```elixir
  @max_frame_size 64_000
  @availability_coalesce_ms 50
  @authentication_timeout_ms 5_000
  @authenticated_idle_timeout_ms 120_000
```

No rate limit. The relay handler at `web_socket.ex:185-205` calls `Holder.relay/3` per frame.

`Holder.handle_call({:relay, ...})` still accepts one op per frame, but Wave A1 now persists a
changed path-backed log through `bounded_atomic_dump/3`. That path uses `Durability.secure_temp/1`,
`Durability.with_target_lock/2`, a four-second task timeout, file sync, atomic rename, directory
sync, and startup durability rehearsal. Preserve that entire contract.

**An existing rate limiter to reuse rather than reinvent**:
`apps/lattice_server/lib/lattice_server/rate_limiter.ex`. Read it first and follow its shape.

`Holder`'s moduledoc states that acknowledgement follows the complete persist-before-ack sequence.
This plan does not debounce, batch, or otherwise weaken that claim.

`Lattice.Log` also promises that structurally rejected operations are retained and auditable, while
`Township.AuditBundle` treats `matter.log` as its only trusted root. A bounded in-memory quarantine
window would violate that complete-evidence invariant. The earlier cap proposal is therefore
deferred to a separate append-only archive/journal design; this plan does not change `Lattice.Log`.

### Repo conventions to follow

- Every claim in this repo is stated with its non-claims. If you weaken the durability contract in
  Part C, the moduledoc must say exactly what is now guaranteed and what is not — see
  `plans/142-carrier-auth-replay-and-durability.md`'s precedent ("explicitly claim process-crash
  rather than power-loss durability").
- Rust code has tests in `clients/township-tauri-shell/src-tauri/tests/` (`native_commands.rs`,
  `governance_witness_custody.rs`, `governance_release_binding.rs`) plus inline `#[cfg(test)]` modules.
- Elixir modules carry `@moduledoc`/`@spec`; all code is `mix format`-clean.

## Commands you will need

**Toolchain**: invoke mix as `~/.asdf/shims/mix`.

| Purpose | Command | Expected on success |
|---|---|---|
| Elixir gate | `~/.asdf/shims/mix check` | exit 0 |
| Carrier server tests | `~/.asdf/shims/mix test apps/lattice_carrier_server/` | all pass |
| Sobelow (lattice_server) | `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit` | exit 0 |
| Sobelow (township_web) | `cd apps/township_web && ~/.asdf/shims/mix sobelow --exit` | exit 0 after Part B |
| Rust tests | `cd clients/township-tauri-shell/src-tauri && cargo test` | all pass |
| Rust dev-trace tests | `cd clients/township-tauri-shell/src-tauri && cargo test --features township-dev-trace --test dev_trace_commands` | all pass |
| Shell typecheck | `npm --prefix clients/township-tauri-shell run typecheck` | exit 0 |
| Shell native contract | `npm --prefix clients/township-tauri-shell run native:contract` | exit 0 |
| Packaged smoke (macOS, needs a built app) | `npm --prefix clients/township-tauri-shell run tauri:stable-relay:onboarding:smoke` | exit 0 |
| Generate a fresh secret | `~/.asdf/shims/mix phx.gen.secret` | prints a new 64-byte base64 value |

## Scope

**In scope**:

- **Part A**: `clients/township-tauri-shell/src-tauri/tauri.conf.json`,
  `clients/township-tauri-shell/src-tauri/src/lib.rs`,
  `clients/township-tauri-shell/src-tauri/tests/native_commands.rs`,
  `clients/township-tauri-shell/test/runtime_wiring_contract.mjs`, and the reviewer-driven
  CSP-alignment changes in `src/township_release_pairing_probe.ts`,
  `src/township_release_onboarding_probe.ts`, and their focused contract tests
- **Part B**: `config/config.exs`, `config/dev.exs` and `config/test.exs` (create if absent),
  `config/runtime.exs`
- **Part C**: `apps/lattice_carrier_server/lib/lattice_carrier_server/web_socket.ex`,
  `apps/lattice_carrier_server/test/**`
- `plans/README.md` (status row)

**Out of scope**:

- **The key-custody implementation itself.** Custody is correct — no command returns key material,
  the governance/carrier alias fence works, probe writers are sanitized. Do not restructure it.
- **Other `clients/township-tauri-shell/src/**` JS/Vue behavior.** The reviewer-driven exception
  above only makes the build-time state-exchange validators match the CSP. If a native constraint
  breaks any other legitimate JS caller, that remains a STOP condition to report, not a JS change
  to make.
- **Any change to canonical encoding or the wire format.** The domain tags are read-only inputs to
  Part A's allowlist.
- **Replacing the Wave A1 persistence path with an append-only journal or bounding
  `Lattice.Log.quarantine`.** Preserving complete audit evidence requires a durable archive design,
  an on-disk format decision, and a replay path. This plan bounds the per-connection relay rate; it
  does not redesign persistence or truncate evidence.
- **`apps/lattice_server/lib/lattice_server/rate_limiter.ex`** — read it, reuse its shape, do not
  modify it.
- Any change to `Lattice.Op`, `Lattice.Authority`, or the TypeScript client.

## Git workflow

- Branch: `advisor/165-boundary-hardening`
- **Three separate commits, one per part.** They are independent and a reviewer should be able to
  take them separately: `fix(shell): constrain the native signing oracle and set a CSP`,
  `fix(config): move the dev secret out of tracked config and fail closed on PHX_SERVER`,
  `fix(carrier): bound the per-connection relay rate`.
- Do NOT push or open a PR unless the operator instructed it.

---

## Part A — constrain the native signing oracle and set a CSP

### Step A1: Enumerate every payload the shell legitimately signs

Before adding any constraint, establish ground truth. Search the shell and client for every call site
that reaches `lattice_sign_carrier`, and for every domain tag that can precede signed bytes:

```sh
grep -rn 'sign_carrier\|signCarrier' clients/township-tauri-shell/src clients/lattice-client/src
grep -rn 'lattice-op-v2\|lattice-delegation-v2\|lattice-delegation-v3\|carrier-session' clients/lattice-client/src apps/lattice_core/lib/lattice
```

Produce a written list: tag literal, what signs it, and the maximum plausible payload length. Confirm
the carrier-session transcript tag's exact literal from
`apps/lattice_core/lib/lattice/carrier/session.ex` — do not guess it.

**Verify**: your report contains the complete list. If any signing call site passes bytes whose
leading tag you cannot identify, STOP — an allowlist built on an incomplete survey will break a real
flow at runtime.

### Step A2: Gate `sign_carrier` on a domain-tag allowlist and a length cap

In `clients/township-tauri-shell/src-tauri/src/lib.rs`, after the base64 decode in `sign_carrier`
(`:505-508`) and before the key lookup, require the decoded payload to begin with one of the tags
from step A1, and to be under a generous cap (pick from the observed maximum in A1, rounded up —
state the number and its basis).

Return a distinct, non-leaking error string for each refusal (`"unrecognized signing payload"`,
`"signing payload too large"`) — never echo the payload bytes into the error.

Keep `reject_governance_carrier_alias` first, exactly as it is.

**Verify**:

```sh
cd clients/township-tauri-shell/src-tauri && cargo test && cd ../../..
npm --prefix clients/township-tauri-shell run native:contract
```

→ both exit 0. Add Rust tests in `tests/native_commands.rs` covering: each allowlisted tag is
accepted; an unrecognized prefix is refused; an over-cap payload is refused; the governance alias is
still refused.

### Step A3: Validate the pairing-advert target address

In `advertise_township_pairing_handoff` (`src-tauri/src/lib.rs:838-859`), constrain `target_addr` so
JS cannot use it as an arbitrary UDP egress primitive. The correct constraint is whatever the feature
actually needs — read the callers first. If it only ever targets the LAN broadcast address, require
exactly that. If it needs a configurable port, allow the address family but restrict the host to
broadcast/loopback/private ranges.

**Verify**: `cargo test` passes with a new test asserting a public-internet address is refused and
the legitimate target is accepted.

### Step A4: Set a Content-Security-Policy

Replace `"csp": null` in `clients/township-tauri-shell/src-tauri/tauri.conf.json:23` with a policy
that at minimum sets `default-src 'self'`, forbids `'unsafe-eval'`, and restricts `connect-src` to
`'self'` plus the `ws:`/`wss:` origins the app must reach.

Two known hazards:

- **Inline styles.** Vue's scoped styles and any `style=` bindings may need `style-src 'self' 'unsafe-inline'`.
  Prefer keeping `'unsafe-inline'` for styles over dropping the CSP entirely — script restriction is
  the load-bearing part.
- **The dev server.** `vite dev` needs its own origin and websocket for HMR. Tauri supports
  environment-specific CSP via `tauri.conf.json` overrides; if the packaged config must differ from
  dev, use that mechanism rather than loosening the shipped policy.

**Verify**: build and launch the packaged app and confirm it still works end to end:

```sh
npm --prefix clients/township-tauri-shell run tauri:stable-relay:onboarding:smoke
npm --prefix clients/township-tauri-shell run tauri:action-handoff:smoke
```

→ both exit 0. Also check the WebView console output the smokes capture for CSP violation reports.
**A CSP that silently blocks a resource and degrades a feature is worse than no CSP** — if you cannot
confirm the packaged smokes are green, STOP and report rather than shipping an unvalidated policy.

(These smokes require macOS and a built `.app`. If you are not on macOS, STOP after A3 and report
that A4 needs a macOS run — do not land an unverified CSP.)

---

## Part B — rotate the committed secret and fail closed on `PHX_SERVER`

### Step B1: Move the dev values out of tracked config into env-specific config

Remove the `secret_key_base` and `signing_salt` literals from `config/config.exs:22-23`. Put
freshly-generated development values in `config/dev.exs` and `config/test.exs` (creating them and the
`import_config "#{config_env()}.exs"` line if the repo does not already have them — check
`config/config.exs`'s tail first).

Generate new values with `~/.asdf/shims/mix phx.gen.secret`. **Never copy the old values anywhere.**

Treat the previously-committed values as compromised: they are in git history and cannot be removed
by deletion. Note in your report that rotation has happened and that any deployment which ever used
them must be re-keyed. Do not attempt to rewrite git history.

### Step B2: Require `SECRET_KEY_BASE` whenever a server is actually started

In `config/runtime.exs`, make the requirement follow the server, not the env. The `PHX_SERVER` branch
at `:3-9` is what makes the endpoint live, so that is where the key must be mandatory:

```elixir
import Config

if System.get_env("PHX_SERVER") do
  port = String.to_integer(System.get_env("PORT", "4100"))

  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      SECRET_KEY_BASE is required whenever PHX_SERVER is set — the endpoint is live and
      signs session cookies and LiveView tokens. Generate one with `mix phx.gen.secret`.
      """

  config :township_web, TownshipWeb.Endpoint,
    http: [ip: {127, 0, 0, 1}, port: port],
    server: true,
    secret_key_base: secret_key_base
end

if config_env() == :prod do
  # ... keep the existing :prod requirement
end
```

This changes a documented developer workflow: `AGENTS.md:84`'s
`PHX_SERVER=true PORT=4100 ~/.asdf/shims/mix run --no-halt` now needs `SECRET_KEY_BASE` set. Update
that line in `AGENTS.md` to show the variable, and make the raise message tell the developer exactly
how to generate one (as above).

**Verify**:

```sh
PHX_SERVER=true PORT=4100 ~/.asdf/shims/mix run --no-halt
```

→ raises with the new message. Then:

```sh
SECRET_KEY_BASE="$(~/.asdf/shims/mix phx.gen.secret)" PHX_SERVER=true PORT=4100 ~/.asdf/shims/mix run --no-halt
```

→ starts the endpoint. (Stop it with Ctrl-C.)

```sh
~/.asdf/shims/mix check
cd apps/township_web && ~/.asdf/shims/mix sobelow --exit ; echo "exit=$?" ; cd ../..
```

→ `mix check` exits 0; record the Sobelow result. If Sobelow's `Config.Secrets` check was firing on
`config/config.exs` before this change and no longer is, say so — that is the evidence Part B worked,
and it unblocks plan 161's step 3.

**Verify no literal remains**:

```sh
grep -n 'secret_key_base\|signing_salt' config/config.exs
```

→ no output.

---

## Part C — bound the per-connection relay rate

### Step C1: Add a per-connection relay rate limit

Read `apps/lattice_server/lib/lattice_server/rate_limiter.ex` and follow its shape. Add a per-connection
token bucket to `LatticeCarrierServer.WebSocket`, applied to `"relay"` frames specifically (not to
`frontier`/`pull`/`subscribe`, which are cheap reads).

Add the limit as a module attribute next to the existing ones at `web_socket.ex:9-12`, with a comment
giving the reasoning for the number chosen. Pick a rate that is generous for a real participant
device draining an outbox (which sends one op per frame) and hostile to a flood — state your
reasoning.

On refusal, reply with the existing error shape used elsewhere in the handler
(`%{type: "error", reason: ...}`) using a new reason such as `"rate_limited"`, and emit the existing
telemetry event if one fits.

**Verify**: add a carrier-server test asserting that a burst beyond the limit is refused with
`rate_limited` and that a normal drain rate is unaffected.

```sh
~/.asdf/shims/mix test apps/lattice_carrier_server/
```

→ all pass, including the new cases.

### Step C2: Record the complete-evidence boundary

Do not edit `Lattice.Log`. Confirm that `Log` still retains structural quarantine in `matter.log`
and that `Township.AuditBundle` still names that file as its only trusted root. Record in the
execution report that bounded structural-quarantine storage needs a durable archive/journal design
and remains deferred rather than falsely completed.

### Step C3: Restate the durability contract honestly

Do not debounce or batch persistence. Leave `Holder`'s persist-before-ack moduledoc unchanged and
state in the execution report that Wave A1's durability contract remains intact.

**Do not silently weaken the durability claim.** This repo's distinguishing discipline is that its
claims match its code.

### Step C4: Full gate

```sh
~/.asdf/shims/mix check
~/.asdf/shims/mix test apps/lattice_carrier_server/
cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit && cd ../..
cd apps/township_web && ~/.asdf/shims/mix sobelow --exit && cd ../..
npm --prefix clients/lattice-client run carrier:relay
npm --prefix clients/lattice-client run carrier:relay-sync
npm --prefix clients/lattice-client run carrier:township:live
```

→ all exit 0. The relay contract tests are the ones most likely to notice a rate limit — if
`carrier:relay-sync` starts failing, your limit is too tight for a legitimate drain.

## Test plan

- **Rust** (`clients/township-tauri-shell/src-tauri/tests/native_commands.rs`): each allowlisted
  domain tag signs; an unrecognized prefix refuses; an over-cap payload refuses; the governance alias
  still refuses; a public-internet advert target refuses; the legitimate target accepts.
- **Packaged smokes** (macOS): `tauri:stable-relay:onboarding:smoke` and `tauri:action-handoff:smoke`
  green under the new CSP — this is the only real proof the CSP does not break the app.
- **Elixir** (`apps/lattice_carrier_server/test/`): a relay burst beyond the limit is refused with
  `rate_limited`; a normal drain is unaffected; Wave A1 durability tests remain green.
- **Config**: `PHX_SERVER=true` without `SECRET_KEY_BASE` raises; with it, the endpoint starts.
- **Sobelow**: `apps/township_web` scan result recorded before and after Part B.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n '"csp": null' clients/township-tauri-shell/src-tauri/tauri.conf.json` → no output
- [ ] `cd clients/township-tauri-shell/src-tauri && cargo test` passes, including the new signing-oracle and advert-target cases
- [ ] `cd clients/township-tauri-shell/src-tauri && cargo test --features township-dev-trace --test dev_trace_commands` passes
- [ ] `npm --prefix clients/township-tauri-shell run native:contract` exits 0
- [ ] The two packaged macOS smokes exit 0 under the new CSP (or the plan is reported as stopping at A3 with a stated reason)
- [ ] `grep -n 'secret_key_base\|signing_salt' config/config.exs` → no output
- [ ] `PHX_SERVER=true PORT=4100 ~/.asdf/shims/mix run --no-halt` raises without `SECRET_KEY_BASE`, and starts with it
- [ ] `~/.asdf/shims/mix check` exits 0
- [ ] `~/.asdf/shims/mix test apps/lattice_carrier_server/` passes, including the rate-limit and Wave A1 durability cases
- [ ] Both Sobelow scans exit 0
- [ ] `npm --prefix clients/lattice-client run carrier:relay`, `carrier:relay-sync`, `carrier:township:live` exit 0
- [ ] Your report contains the complete step-A1 domain-tag survey
- [ ] Your report states whether `Holder`'s durability moduledoc changed and why
- [ ] Your report notes that the previously-committed secret is rotated and must be treated as burned
- [ ] `git status` shows no modified file outside the In-scope list
- [ ] `plans/README.md` status row for 165 updated

## STOP conditions

Stop and report back (do not improvise) if:

- **The step-A1 survey is incomplete** — you find a signing call site whose leading domain tag you
  cannot identify. An allowlist built on a partial survey breaks a real flow at runtime, and the
  symptom (a refused signature deep inside a packaged smoke) is expensive to diagnose.
- **The new CSP breaks a packaged smoke and you cannot make it pass without dropping to
  `default-src *` or re-enabling `'unsafe-eval'`.** Report what broke. A weak CSP that ships is worse
  than a documented gap, because it reads as protection.
- **You are not on macOS** and therefore cannot verify A4. Land A1–A3, report that A4 is unverified,
  and do not commit the CSP change.
- **The relay rate limit breaks `carrier:relay-sync` or a packaged smoke.** That means a legitimate
  outbox drain exceeds your limit — report the observed rate rather than raising the limit blindly.
- **You find yourself editing `clients/township-tauri-shell/src/**`** to satisfy the native
  constraint. That means a legitimate JS caller signs something outside the allowlist — a survey gap,
  and a finding.
- Sobelow on `township_web` reports something beyond the `Config.Secrets` finding this plan fixes.

## Maintenance notes

- **Reviewer focus, Part A**: the domain-tag allowlist. Every entry should trace to a call site in
  the step-A1 survey. An allowlist entry with no caller is dead permission; a caller with no entry is
  a runtime break waiting for the packaged smoke.
- **Reviewer focus, Part B**: that the `SECRET_KEY_BASE` requirement is attached to `PHX_SERVER`
  rather than to `config_env()`. Env-based gates are exactly how the original hole appeared.
- **Reviewer focus, Part C**: the rate limit must be per connection and must not weaken Wave A1's
  persist-before-ack, timeout, locking, or durability-rehearsal behavior.
- **The signing oracle remains powerful even after A2.** A domain-tag allowlist stops signing
  *arbitrary* bytes; it does not stop signing a *well-formed but attacker-chosen* delegation. The
  durable fix is per-signature user presence for high-authority payload shapes (delegation issuance,
  revocation), mirroring what `use_action_intent.ts:229-231` already does with `event.isTrusted`.
  That is a UX change and is deliberately out of this plan — flag it for the roadmap.
- **Deferred out of this plan, all real**: replacing the Wave A1 full-log persistence with an
  append-only journal plus periodic snapshot, including durable preservation of every structural
  quarantine entry and a replay-compatible on-disk format; the seven high-severity npm
  advisories in the shell's devDependencies (all build/test tooling — `js-beautify`, `@vue/test-utils`,
  `postcss` — with no path into the shipped app); and per-signature user presence as described above.
