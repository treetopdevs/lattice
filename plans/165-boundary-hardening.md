# Plan 165: Harden three boundaries — the WebView signing oracle, the committed dev secret, and relay growth

> **Executor instructions**: Follow this plan step by step. Run every verification command
> and confirm the expected result before moving to the next step. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 764a1945..HEAD -- clients/township-tauri-shell/src-tauri config apps/lattice_carrier_server apps/lattice_core/lib/lattice/log.ex
> ```
> If any in-scope file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 — none of these is a live exploit today, but each is a boundary that is one small
  change away from mattering, and two of them contradict claims the repo makes about itself.
- **Effort**: M total (Part B is S; Parts A and C are each S–M)
- **Risk**: MED — a strict CSP can break the Vite dev server; domain-tag gating the signing oracle
  requires enumerating every payload the shell legitimately signs; debouncing relay persistence
  touches the crash-durability contract.
- **Depends on**: none technically. `plans/161-close-verification-gaps.md` will surface Part B's
  finding through Sobelow and is blocked on it — land this first if 161 stops there.
- **Category**: security
- **Planned at**: commit `764a1945`, 2026-07-29
- **Part B: DONE 2026-08-08.** Committed as `8ab09e9e` on branch `plan165-partb-work`
  (worktree `.claude/worktrees/plan165-partb-work`, based on `origin/main` @ `b1e6b88a`).
  **Not merged — merging is the operator's call.** Reviewer re-verified in the worktree:
  `mix check` exit 0 with 0 failures across all apps (27 properties, ~600 tests); prod raises by
  name for a missing `SECRET_KEY_BASE` and for a missing `LIVE_VIEW_SIGNING_SALT` independently;
  dev/test/unknown-env paths all resolve correctly; no literal remains in `config/`. The executor
  additionally verified `scripts/township_instrument_server.sh` boots and serves 200 under
  `MIX_ENV=test`, and `npm run township:instrument:e2e` passed 6/6.
  **Parts A and C remain TODO** and are unaffected by this.
- **Part C refreshed**: 2026-08-06 against `91bb6ca6` — six commits moved `holder.ex` line
  references after the original planned-at commit. Defects unchanged, locations corrected.
- **Sequencing**: land `plans/173-bounded-carrier-transport.md` **before** Part C. 173 bounds
  carrier *reads* (paged pulls, connect deadlines) on the same two files; Part C bounds *writes*
  (relay rate, quarantine growth). Rate limiting is easier to reason about once reads are bounded,
  and the two would otherwise collide in `web_socket.ex`.

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

**B. A predictable `secret_key_base` is committed, and `PHX_SERVER` starts a live endpoint in every
env.** `config/config.exs:22-23` holds literal `signing_salt` and `secret_key_base` values.

> **Severity corrected 2026-08-08 during execution review.** Both committed values are *placeholders*,
> not generated credentials — the `secret_key_base` carries an explicit change-for-production marker
> and zero padding, and the salt is a short constant word. **No rotation and no re-keying of any
> deployment is required**, and the original "treat it as burned" framing in this plan was wrong.
> The defect that is real: a *predictable, publicly-known constant* signs LiveView sessions and
> tokens on a live endpoint in **every** environment, and `config_env() == :prod` is the only gate. A
> known constant is as forgeable as a leaked secret, so the fix stands — only the incident-response
> advice changes.
`config/runtime.exs:11-17` requires `SECRET_KEY_BASE` only under `config_env() == :prod`, but the
`PHX_SERVER` branch at `config/runtime.exs:3-9` — the one that flips `server: true` — runs in **every**
env. So `MIX_ENV=dev PHX_SERVER=1` starts a live endpoint signing LiveView sessions and tokens with a
value that is public in git history. The endpoint binds loopback, which limits blast radius to local
processes and anything fronting it. Because the value is committed, deleting it is insufficient — it
is burned and must be rotated.

**C. Relay has no rate limit and rewrites the entire log on every relayed op.**
`Holder.handle_call({:relay, ...})` accepts one op, then `persist_relay/3` calls `atomic_dump/2`,
which does a full `Log.dump` (serializing the whole op map) plus `:file.sync` plus rename — inside
the GenServer call, blocking every concurrent `frontier`/`pull`/`subscribe`. Appending op *k* writes
O(k) bytes, so relaying N ops writes Θ(N²) total: roughly 200 MB of writes and 1,000 fsyncs to build
a 400 KB log. Meanwhile `Log.quarantine` is an uncapped list that survives restart, and its same-id
idempotency guard is defeated by varying one byte of the body. An authenticated relay realm — trusted
for transport, not for behavior — can fill the disk and stall the server. `LatticeCarrierServer.WebSocket`
has a 64 KB frame cap and a 120 s idle timeout, but no message rate limit.

After this plan: the WebView can only ask for signatures over recognized payload shapes and runs
under a CSP; the committed secret is rotated out of the tracked config and cannot be the default for
a running server; and a relay peer cannot drive unbounded disk growth.

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

> **Refreshed 2026-08-07 against `91bb6ca6`.** `config/` drifted since the original planned-at
> commit (`764a1945`): the Round 5 pilot-carrier work added +18 lines to `config.exs` and +24 to
> `runtime.exs`. **The defect is unchanged** — the literals are still in the base endpoint block and
> the `PHX_SERVER` branch still sets `server: true` without requiring a key — but the excerpts and
> the target code below are the *current* content. Two consequences for the fix:
> the repo has **no `config/dev.exs` or `config/test.exs`** and does not use `import_config` (only
> `config.exs` and `runtime.exs` exist), and `runtime.exs` now carries a `carrier_release?` guard
> that must be preserved verbatim.

`config/config.exs` — the base endpoint block, with the two literals at lines 22–23 (a LiveView
`signing_salt` and an endpoint `secret_key_base`). **Do not copy either value into any file, commit
message, or report.**

```elixir
config :township_web, TownshipWeb.Endpoint,
  url: [host: "localhost"],
  http: [ip: {127, 0, 0, 1}, port: 4100],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [formats: [html: TownshipWeb.ErrorHTML], layout: false],
  pubsub_server: TownshipWeb.PubSub,
  live_view: [signing_salt: "<REDACTED — line 22>"],
  secret_key_base: "<REDACTED — line 23>",
  server: false
```

**The repo's env-scoping convention is inline `config_env()` guards inside `config.exs`, not separate
env files.** Two already exist and are the pattern to match:

```elixir
if config_env() == :dev do
  config :township_web, TownshipWeb.Endpoint,
    watchers: [
      esbuild: {Esbuild, :install_and_run, [:township_web, ~w(--sourcemap=inline --watch)]}
    ]
end

# ... (a long comment block explaining the darwin-sync opt-in) ...
if config_env() == :test do
  config :lattice_carrier_server, allow_approximate_darwin_sync: true
  config :lattice_carrier_server, storage_check_ttl_ms: 0
end
```

Note both carry a comment explaining *why* the value is env-scoped. Match that.

`config/runtime.exs` in full, as it exists now:

```elixir
import Config

# Pilot carrier runtime (plan 158): the release selects its deployment
# manifest through this environment variable. The manifest names secret
# identity files; no identity material passes through the environment itself.
# Inside the pilot release the manifest is mandatory — a missing manifest
# refuses startup rather than booting an instanceless carrier. The umbrella
# defines only this release, so RELEASE_ROOT is the stable release marker;
# RELEASE_NAME is operator-overridable and cannot identify the pilot safely.
carrier_release? = is_binary(System.get_env("RELEASE_ROOT"))

case System.get_env("LATTICE_CARRIER_MANIFEST") do
  nil when carrier_release? ->
    raise "LATTICE_CARRIER_MANIFEST is required for the pilot carrier release"

  nil ->
    :ok

  carrier_manifest ->
    config :lattice_carrier_server, manifest: carrier_manifest
end

if System.get_env("PHX_SERVER") do
  port = String.to_integer(System.get_env("PORT", "4100"))

  config :township_web, TownshipWeb.Endpoint,
    http: [ip: {127, 0, 0, 1}, port: port],
    server: true
end

# The Township web requirement does not apply inside the carrier-only
# release, which does not include :township_web.
if config_env() == :prod and not carrier_release? do
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise "SECRET_KEY_BASE is required for the Township web endpoint"

  config :township_web, TownshipWeb.Endpoint, secret_key_base: secret_key_base
end
```

The `PHX_SERVER` branch is still env-independent and still does not require a key; the
`SECRET_KEY_BASE` requirement is still bound to `config_env()`. That is the defect.

`AGENTS.md:84` documents `PHX_SERVER=true PORT=4100 ~/.asdf/shims/mix run --no-halt` as a safe local
command — so the dev path genuinely is used and must keep working.

### Part C — relay growth

> **REFRESHED 2026-08-06 (Round 5).** The line references below were re-verified against
> `91bb6ca6`. Six commits touched these files after this plan's original planned-at commit
> `764a1945` — `369b58bc`, `e592274f`, `51ea0b60`, `adfa06c8`, `b05741f8`, `c8466216` — and
> `holder.ex`'s line numbers moved by roughly 35–70 lines. The **defects are unchanged**; only
> the locations moved. Re-run the drift check before starting and compare these excerpts.

`apps/lattice_carrier_server/lib/lattice_carrier_server/web_socket.ex:9-12`:

```elixir
  @max_frame_size 64_000
  @availability_coalesce_ms 50
  @authentication_timeout_ms 5_000
  @authenticated_idle_timeout_ms 120_000
```

No rate limit. The relay handler at `web_socket.ex:185-205` calls `Holder.relay/3` per frame.

`apps/lattice_carrier_server/lib/lattice_carrier_server/holder.ex:167-174` is the relay entry
point, which gates on `relay_realms` and then delivers unconditionally:

```elixir
  def handle_call({:relay, peer_realm, op}, _from, state) do
    if MapSet.member?(state.relay_realms, peer_realm) do
      {log, report} = Sync.deliver(state.log, [op])
      persist_relay(log, report, state)
    else
      {:reply, {:error, :read_only}, state}
    end
  end
```

`holder.ex:205-220` is `persist_relay/3`. Its no-op fast path matches only when the log struct is
**unchanged**:

```elixir
  defp persist_relay(log, report, %{log: log} = state) do
    {:reply, {:ok, report}, state}
  end

  defp persist_relay(log, report, %{source: {:path, path}} = state) do
```

A quarantine append changes the struct, so every invalidly-signed relayed op falls through to the
full dump → `:file.sync` → rename → directory sync. That is the write-amplification path Part C
bounds.

`apps/lattice_core/lib/lattice/log.ex:203-215` — `dump/2` serializes the entire op map via
`:erlang.term_to_binary(..., [:deterministic])`, and `downgrade_structs/1` rebuilds every op with
`Map.new/2` on each call.

`apps/lattice_core/lib/lattice/log.ex:34` — `quarantine` is a plain list on the persisted struct.
`:189` — `quarantine_op/3` prepends with no cap. `:141-153` — a bad-signature op is quarantined
(mutating the log) unless an op with the **same id** is already quarantined:

```elixir
  @spec structurally_quarantined?(t(), Op.id()) :: boolean()
  def structurally_quarantined?(%__MODULE__{quarantine: q}, id),
    do: Enum.any?(q, &(&1.op.id == id))
```

Two things follow, and Part C must address both. The dedup keys on the **attacker-supplied**
`op.id`, and an op that fails `Op.valid?` is by definition one whose id does not match its
content — so varying the claimed id yields a fresh entry every time and defeats the guard
entirely. And `Enum.any?` is a linear scan run per admitted invalid op, making the growth
quadratic in CPU as well as unbounded on disk.

**An existing rate limiter to reuse rather than reinvent**:
`apps/lattice_server/lib/lattice_server/rate_limiter.ex`. Read it first and follow its shape.

`Holder`'s moduledoc (`holder.ex:5-9`) states the durability contract: acknowledged only after a
complete temporary dump has been synced and atomically renamed. Any batching weakens that claim, so
it must be **restated honestly**, not silently dropped.

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
  `clients/township-tauri-shell/src-tauri/tests/native_commands.rs`
- **Part B**: `config/config.exs`, `config/runtime.exs` — **those two files only**. Do **not** create
  `config/dev.exs` or `config/test.exs` (this repo scopes config with inline `config_env()` guards
  and has no `import_config`), and do **not** edit `AGENTS.md:84` or `apps/township_web/README.md:13`:
  with the ephemeral-key approach in B2 the documented `PHX_SERVER` command keeps working verbatim.
- **Part C**: `apps/lattice_carrier_server/lib/lattice_carrier_server/web_socket.ex`,
  `apps/lattice_carrier_server/lib/lattice_carrier_server/holder.ex`,
  `apps/lattice_core/lib/lattice/log.ex` (quarantine cap only),
  `apps/lattice_carrier_server/test/**`
- `plans/README.md` (status row)

**Out of scope**:

- **The key-custody implementation itself.** Custody is correct — no command returns key material,
  the governance/carrier alias fence works, probe writers are sanitized. Do not restructure it.
- **`clients/township-tauri-shell/src/**` (the JS/Vue side).** Part A adds a native-side constraint.
  If the constraint breaks a legitimate JS caller, that is a STOP condition to report, not a JS
  change to make.
- **Any change to canonical encoding or the wire format.** The domain tags are read-only inputs to
  Part A's allowlist.
- **Replacing `atomic_dump` with an append-only journal.** That is the right long-term fix for Part
  C's Θ(N²) and it is explicitly deferred — it changes the on-disk format and needs `Log.restore/1`
  to grow a replay path. This plan bounds the *growth* and the *rate*; it does not redesign
  persistence.
- **`apps/lattice_server/lib/lattice_server/rate_limiter.ex`** — read it, reuse its shape, do not
  modify it.
- Any change to `Lattice.Op`, `Lattice.Authority`, or the TypeScript client.

## Git workflow

- Branch: `advisor/165-boundary-hardening`
- **Three separate commits, one per part.** They are independent and a reviewer should be able to
  take them separately: `fix(shell): constrain the native signing oracle and set a CSP`,
  `fix(config): stop shipping signing material in tracked config`,
  `fix(carrier): bound relay rate and quarantine growth`.
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

## Part B — rotate the committed secret and stop shipping signing material in tracked config

### Step B1: Delete both literals from tracked config

In `config/config.exs`, remove the `secret_key_base:` entry and the `live_view: [signing_salt: ...]`
entry from the base `config :township_web, TownshipWeb.Endpoint` block (lines 22–23). Leave every
other key in that block (`url`, `http`, `adapter`, `render_errors`, `pubsub_server`, `server: false`)
exactly as it is.

**No literal signing material may remain in any tracked config file, in any environment.** Do not
re-add the values behind a `config_env()` guard — a guarded literal is still a committed secret, it
still trips Sobelow's `Config.Secrets` check, and it would leave plan 161 step 3 blocked. Step B2
supplies the values instead.

Treat the previously-committed values as compromised: they are in git history and cannot be removed
by deletion. Note in your report that rotation has happened and that any deployment which ever used
them must be re-keyed. Do not attempt to rewrite git history. **Never copy the old values anywhere.**

### Step B2: Supply the signing material at boot — env first, ephemeral in dev/test, raise otherwise

The endpoint still needs a `secret_key_base` and a `signing_salt`. Supply both from
`config/runtime.exs`, which is evaluated at boot rather than compile time.

The rule, in one sentence: **use `SECRET_KEY_BASE` when it is set; in `:dev` and `:test` generate an
ephemeral one per boot; otherwise raise.** That removes the public-key problem at its root (there is
no longer a known key to abuse) while keeping the documented developer workflow working with no new
environment variable.

**Preserve the `carrier_release?` assignment and the `LATTICE_CARRIER_MANIFEST` case statement above
verbatim** — they are Round 5 pilot-carrier work and are out of this plan's scope. Also leave the
`if config_env() == :prod and not carrier_release? do` block at the bottom as it is: it is the
existing production requirement and it stays.

Add a block, placed **after** the `carrier_release?`/manifest section and **before** the
`PHX_SERVER` branch, along these lines:

```elixir
# Signing material for the Township endpoint. Nothing is committed: production
# supplies SECRET_KEY_BASE from the environment, and dev/test mint an ephemeral
# value at boot. Ephemeral is correct for dev/test — the instrument is a
# loopback-bound read-only surface with no login, so the only consequence of a
# fresh key per boot is that a stale browser session is re-established.
# The carrier-only pilot release does not include :township_web.
if not carrier_release? do
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      case config_env() do
        env when env in [:dev, :test] -> Base.encode64(:crypto.strong_rand_bytes(48))
        _ -> nil
      end

  signing_salt =
    System.get_env("LIVE_VIEW_SIGNING_SALT") ||
      case config_env() do
        env when env in [:dev, :test] -> Base.encode64(:crypto.strong_rand_bytes(16))
        _ -> nil
      end

  if secret_key_base && signing_salt do
    config :township_web, TownshipWeb.Endpoint,
      secret_key_base: secret_key_base,
      live_view: [signing_salt: signing_salt]
  end
end
```

Two things to get right, and to **verify rather than assume**:

- **Keyword deep-merge.** Elixir's `Config` deep-merges keyword lists, so setting `live_view:` here
  should merge into (not replace) any `live_view:` list from `config.exs`. After step B1 there is no
  base `live_view:` key left, so this is the only source — but confirm the endpoint boots and a
  LiveView actually mounts, which is what the B3 verification does.
- **`:prod` still raises.** With the literals gone, a `:prod` non-carrier boot without
  `SECRET_KEY_BASE` must still fail loudly via the existing block at the bottom of the file. If the
  shape above would let a `:prod` boot proceed with `nil`, fix it so it cannot — a silently-`nil`
  `secret_key_base` is a worse outcome than the bug this plan is fixing.

You may restructure the block if a cleaner formulation gives the same three-way behavior. What must
hold: no literal in tracked config; dev/test boot with no environment variable; `:prod` non-carrier
without `SECRET_KEY_BASE` raises.

**Known `PHX_SERVER` call sites — surveyed 2026-08-07, no action needed.** The ephemeral-key
approach was chosen precisely so that adding a `SECRET_KEY_BASE` requirement does not break the
existing callers. All four executable ones run under `MIX_ENV=test` and therefore take the ephemeral
branch with no environment variable:

- `scripts/township_instrument_server.sh:11`
- `scripts/township_stable_server_live.sh:16`
- `scripts/township_live_instrument_server.sh:16`
- `clients/township-tauri-shell/test/support/beam_peer.ts:228`

plus two documentation references (`AGENTS.md:84`, `apps/township_web/README.md:13`) that stay
correct as written. None sets `RELEASE_ROOT`, so `carrier_release?` is `false` in every case.

If a **new** call site appears that runs under `MIX_ENV=prod`, it will hit the existing `:prod`
requirement and raise — which is the intended behavior, not a regression.

### Step B3: Verify the three behaviors

**Dev boots with no environment variable** (this is `AGENTS.md:84`'s documented workflow, and it must
keep working unchanged):

```sh
PHX_SERVER=true PORT=4100 ~/.asdf/shims/mix run --no-halt
```

→ the endpoint starts. Confirm it serves: in another shell,
`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4100/township` → a 2xx or 3xx, not a
connection error. Then stop it with Ctrl-C.

**An explicit key is honored**:

```sh
SECRET_KEY_BASE="$(~/.asdf/shims/mix phx.gen.secret)" PHX_SERVER=true PORT=4100 ~/.asdf/shims/mix run --no-halt
```

→ starts. Stop with Ctrl-C.

**Prod without a key still raises**:

```sh
MIX_ENV=prod ~/.asdf/shims/mix loadconfig 2>&1 | tail -5
```

→ raises `SECRET_KEY_BASE is required for the Township web endpoint`. (If `loadconfig` is not the
right vehicle in this umbrella, use whatever minimal command evaluates `runtime.exs` under
`MIX_ENV=prod` and say which you used.)

**No literal remains**:

```sh
grep -rn 'secret_key_base\|signing_salt' config/
```

→ the only hits are the variable names in `runtime.exs`, never a literal value.

**Full gate**:

```sh
~/.asdf/shims/mix check
cd apps/township_web && ~/.asdf/shims/mix sobelow --exit ; echo "exit=$?" ; cd ../..
```

→ `mix check` exits 0. Record the Sobelow result. **If Sobelow's `Config.Secrets` check was firing on
`config/config.exs` before this change and no longer is, say so explicitly** — that is the evidence
Part B worked, and it is what unblocks plan 161 step 3.

---

## Part C — bound relay rate and quarantine growth

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

### Step C2: Cap `Log.quarantine` growth

In `apps/lattice_core/lib/lattice/log.ex`, bound the quarantine list. The current structure
(`:34` a plain list, `:189-190` unbounded prepend) grows without limit from forged-signature ops whose
ids differ by one body byte.

Choose a bounded policy and document it in the `@moduledoc`:

- keep the most recent N entries (N as a module attribute with a stated rationale), and
- keep a monotonic **count** of total quarantined ops so the evidence surface does not lie about how
  many were seen — dropping entries silently would corrupt an audit claim.

**This is the highest-risk edit in the plan.** `Log.quarantine/1` and `verified_quarantine/1` feed the
audit bundle, the instrument's ledger, and the structural-quarantine assertions in the Township
tests. Before changing anything, find every consumer:

```sh
grep -rn 'Log.quarantine\|verified_quarantine\|structurally_quarantined' apps clients --include=*.ex --include=*.exs --include=*.ts | grep -v '_build'
```

If any consumer requires the *complete* list rather than a bounded window, STOP and report — the
correct fix may be an eviction policy with an explicit "truncated" marker in the evidence surface,
which is a bigger design decision than this plan should make alone.

**Verify**:

```sh
~/.asdf/shims/mix test
```

→ all pass. Plus a new test asserting: N+K forged ops leave exactly N entries and a count of N+K.

### Step C3: Restate the durability contract honestly

If — and only if — you also debounce or batch `atomic_dump` (optional in this plan; the rate limit
alone may be sufficient), you **must** update `Holder`'s moduledoc at `holder.ex:5-9` to state
precisely what is now guaranteed: what an acknowledgement means, and what window of relayed ops can
be lost on an unclean shutdown.

If you do not change the persistence timing, leave the moduledoc alone and say so in your report.

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
  `rate_limited`; a normal drain is unaffected; N+K forged ops leave N quarantine entries and a count
  of N+K.
- **Config**: dev boots with no environment variable and `/township` responds; an explicit
  `SECRET_KEY_BASE` is honored; `:prod` non-carrier without one still raises; the `:test`-env
  `scripts/township_instrument_server.sh` still boots and serves.
- **Sobelow**: `apps/township_web` scan result recorded before and after Part B.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n '"csp": null' clients/township-tauri-shell/src-tauri/tauri.conf.json` → no output
- [ ] `cd clients/township-tauri-shell/src-tauri && cargo test` passes, including the new signing-oracle and advert-target cases
- [ ] `cd clients/township-tauri-shell/src-tauri && cargo test --features township-dev-trace --test dev_trace_commands` passes
- [ ] `npm --prefix clients/township-tauri-shell run native:contract` exits 0
- [ ] The two packaged macOS smokes exit 0 under the new CSP (or the plan is reported as stopping at A3 with a stated reason)
- [ ] `grep -rn 'secret_key_base\|signing_salt' config/` returns only variable names in `runtime.exs`, never a literal value
- [ ] `PHX_SERVER=true PORT=4100 ~/.asdf/shims/mix run --no-halt` starts the endpoint with **no** environment variable set, and `/township` responds
- [ ] `MIX_ENV=prod` config evaluation without `SECRET_KEY_BASE` still raises
- [ ] `cd apps/township_web && ~/.asdf/shims/mix sobelow --exit` exits 0, and the report states whether `Config.Secrets` stopped firing
- [ ] `~/.asdf/shims/mix check` exits 0
- [ ] `~/.asdf/shims/mix test apps/lattice_carrier_server/` passes, including the rate-limit and quarantine-cap cases
- [ ] Both Sobelow scans exit 0
- [ ] `npm --prefix clients/lattice-client run carrier:relay`, `carrier:relay-sync`, `carrier:township:live` exit 0
- [ ] Your report contains the complete step-A1 domain-tag survey
- [ ] Your report states whether `Holder`'s durability moduledoc changed and why
- [ ] Your report characterizes the removed values without reproducing them, and does **not** claim rotation or re-keying is required (they were placeholders — see the severity correction in "Why this matters")
- [ ] `:prod` non-carrier raises by name for a missing `SECRET_KEY_BASE` **and** for a missing LiveView signing salt; neither can be `nil` at boot (verified with actual command output, not by reading the code)
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
- **Any `Log.quarantine` consumer needs the complete, unbounded list.** The audit bundle and the
  instrument ledger both read it; if either requires completeness, the bounded-window design is wrong
  and needs the operator's decision.
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
- **Reviewer focus, Part B**: that no literal signing material survives anywhere in `config/`, in any
  environment — a value scoped behind `config_env()` is still a committed secret and still trips
  Sobelow. And that `:prod` cannot boot with a `nil` `secret_key_base`: check the fallback shape, not
  just the happy path. A silently-`nil` key would be worse than the bug being fixed.
  (History note: the first draft of this step required `SECRET_KEY_BASE` whenever `PHX_SERVER` was
  set. That would have broken four existing `MIX_ENV=test` callers. Ephemeral-in-dev/test removes the
  public key at its root *and* leaves every documented workflow working — prefer it.)
- **Reviewer focus, Part C**: whether the quarantine count is preserved separately from the bounded
  window. Silently truncating an evidence surface is a claim violation, not an optimization.
- **The signing oracle remains powerful even after A2.** A domain-tag allowlist stops signing
  *arbitrary* bytes; it does not stop signing a *well-formed but attacker-chosen* delegation. The
  durable fix is per-signature user presence for high-authority payload shapes (delegation issuance,
  revocation), mirroring what `use_action_intent.ts:229-231` already does with `event.isTrusted`.
  That is a UX change and is deliberately out of this plan — flag it for the roadmap.
- **Found during Part B execution review, NOT fixed here** (out of scope — Part B is `config/` only):
  `apps/township_web/lib/township_web/endpoint.ex:7` hardcodes `signing_salt: "township-session"` in
  the `@session_options` — a third piece of predictable signing material, this one in a `.ex` source
  file and therefore untouched by Part B. It signs the **session cookie**, distinct from the LiveView
  salt this plan moves to runtime. Same finding class, same fix shape (read from runtime config,
  ephemeral in dev/test, required in prod). Worth a small follow-up plan; note that a Sobelow
  `Config.Secrets` scan will not flag it because it is not in `config/`.
- **Deferred out of this plan, all real**: replacing `atomic_dump` with an append-only journal plus
  periodic snapshot, which is the actual fix for the Θ(N²) relay write amplification (`holder.ex:170-196`
  + `log.ex:203-215`) and needs `Log.restore/1` to grow a replay path; the seven high-severity npm
  advisories in the shell's devDependencies (all build/test tooling — `js-beautify`, `@vue/test-utils`,
  `postcss` — with no path into the shipped app); and per-signature user presence as described above.
