# Plan 007: Stop leaking internal authorization reasons to WebSocket clients

> **Executor instructions**: Follow step by step; run each verification. Honor STOP
> conditions. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 81b9bfd..HEAD -- apps/lattice_server/lib/lattice/transport/web_socket.ex`
> If it changed, compare "Current state" to the live code first; on a real mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW–MED (client-facing error contract changes; tests may assert on it)
- **Depends on**: none
- **Category**: security (defense-in-depth)
- **Planned at**: commit `81b9bfd`, 2026-06-20

> **Severity honesty**: the server binds to loopback by default and the threat model
> already treats the tab/carrier as untrusted for confidentiality. This is hardening
> against reconnaissance (a tab probing cap ids and reading back precise internal
> states), not a critical hole. Scope it accordingly.

## Why this matters

Every WebSocket error frame echoes `inspect(reason)` — the raw internal atom — back to
the browser client. A tab can send calls/casts with guessed cap ids and read distinct
internal states (`:wrong_owner` vs `:unknown_cap` vs `:revoked` vs `:use_limit_exceeded`),
mapping the server's capability graph and lifecycle. Returning a small set of stable,
coarse error codes (and keeping the precise reason server-side) removes that signal
without losing the client's ability to handle failures.

## Current state

`apps/lattice_server/lib/lattice/transport/web_socket.ex` — six sites send
`inspect(reason)` to the client:
- call result: lines ~236 and ~239 (`reason: inspect(reason)` and
  `%{type: "call_result", ok: false, error: inspect(reason)}`)
- cast result: lines ~256/260 and ~263 (`%{type: "cast_result", ok: false, error: inspect(reason)}`)
- liveops result: line ~289/292 (`%{type: "liveops_result", ok: false, action: action, error: inspect(reason)}`)
- generic error frame: `defp reply_error(type, reason, state)` line ~329 →
  `Envelope.encode(%{type: "error", error_type: type, reason: inspect(reason)})`

Internal reasons seen in the codebase include (non-exhaustive): `:wrong_owner`,
`:revoked`, `:parent_revoked`, `:expired`, `:use_limit_exceeded`,
`:operation_not_allowed`, `:unknown_cap`, `:tab_not_connected`, `:bridge_required`,
`:invalid_target`, `:target_down`, `:malformed_cap`, `:malformed_target`,
`:rate_limited`. Denials are already recorded server-side via `Lattice.Audit.record/2`
in `CapStore`/`Gateway`, so the detail is retained even if not returned to the client.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Find tests asserting on error content | `grep -rn "inspect(reason)\|call_result\|cast_result\|error_type\|\"error\"" apps/lattice_server/test apps/lattice_stress/test` | review matches |
| Server-app tests | `cd apps/lattice_server && ~/.asdf/shims/mix test` | all pass |
| Stress WS tests | `cd apps/lattice_stress && ~/.asdf/shims/mix test test/web_socket_abuse_test.exs` | all pass |
| Full suite | `~/.asdf/shims/mix test` | all pass |
| Format | `~/.asdf/shims/mix format` | exit 0 |

## Scope

**In scope**:
- `apps/lattice_server/lib/lattice/transport/web_socket.ex`
- Any test that asserts on the **old** leaked reason string and must be updated to the new
  coarse code (identify via the grep above) — e.g. under `apps/lattice_server/test/` or
  `apps/lattice_stress/test/`.

**Out of scope**:
- `apps/lattice_core` (Gateway/CapStore) — keep returning precise internal reasons
  internally; only the WS boundary translates them for the client.
- The static handler — investigated and found safe (allowlist-based); do not touch.
- Removing the server-side audit detail — keep it.

## Git workflow

- Branch: `advisor/007-ws-error-reason-leak`
- One commit (source + any test updates). Short imperative message.
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Add a reason→public-code mapping

In `web_socket.ex`, add a private helper that maps internal reasons to a **small, stable**
set of client-safe codes and never echoes an unknown atom verbatim. Target shape:
```elixir
defp public_error(reason) do
  case reason do
    r when r in [:wrong_owner, :revoked, :parent_revoked, :expired,
                 :use_limit_exceeded, :operation_not_allowed] -> "unauthorized"
    r when r in [:unknown_cap, :invalid_target, :malformed_cap, :malformed_target] -> "invalid_request"
    r when r in [:tab_not_connected, :target_down, :bridge_required] -> "unavailable"
    :rate_limited -> "rate_limited"
    _ -> "error"
  end
end
```
(Choose the buckets you think are right; the rule is: a fixed enumeration the client can
switch on, with a catch-all `"error"` — no `inspect/1` of internal terms.)

**Verify**: `grep -n "defp public_error" web_socket.ex` → present.

### Step 2: Replace the six `inspect(reason)` client payloads

At each of the six sites, replace `inspect(reason)` (in the client-facing map/frame) with
`public_error(reason)`. Keep `ok: false`, keep `type`/`error_type`/`action` fields as-is.
Do NOT change frames that are not client-facing.

Keep the precise reason server-side: the deny paths already call `Audit.record/2`. If a
site does not already audit, that is acceptable for this plan (the audit coverage lives
in core); do not add new audit calls here unless trivial.

**Verify**: `grep -n "inspect(reason)" apps/lattice_server/lib/lattice/transport/web_socket.ex`
→ **no matches** (all six replaced).

### Step 3: Update any tests that asserted on the leaked detail

Run the grep from "Commands". For each test asserting `error: ":wrong_owner"`-style
content, update it to assert the new coarse code (e.g. `"unauthorized"`). Tests that only
assert `ok: false` need no change.

**Verify**:
- `cd apps/lattice_server && ~/.asdf/shims/mix test` → all pass.
- `cd apps/lattice_stress && ~/.asdf/shims/mix test test/web_socket_abuse_test.exs` → all pass.

### Step 4: Format + full suite

**Verify**: `~/.asdf/shims/mix format` → exit 0; `~/.asdf/shims/mix test` (repo root) → all pass.

## Test plan

- Reuse/extend an existing WS test (e.g. in `apps/lattice_server/test/web_socket_integration_test.exs`
  or `apps/lattice_stress/test/web_socket_abuse_test.exs`): a denied call now returns a
  coarse `error` code, not the internal atom. Add one assertion that two *different*
  internal failures (e.g. unknown cap vs wrong owner) map to the **same or coarse** public
  code so the reconnaissance distinction is gone — model it after the nearest existing WS
  test's structure.
- Verification: `cd apps/lattice_server && ~/.asdf/shims/mix test` → all pass including
  the new assertion.

## Done criteria

ALL must hold:
- [ ] `grep -n "inspect(reason)" apps/lattice_server/lib/lattice/transport/web_socket.ex` → no matches.
- [ ] `public_error/1` (or equivalent) maps reasons to a fixed enumeration with a catch-all.
- [ ] All `apps/lattice_server` and `apps/lattice_stress` tests pass.
- [ ] `~/.asdf/shims/mix test` (repo root) passes; format clean.
- [ ] `git status` shows only `web_socket.ex` + any updated test files.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:
- A test asserts on the leaked reason in a way that implies a real client depends on the
  exact internal atom (e.g. the browser demo JS switches on it) — check
  `examples/*/client.js` for `error ===`/`error.includes` usage before changing the
  contract; if a client parses specific atoms, report so the mapping can preserve the
  cases that client needs.
- The six sites are not all present / have moved (drift) — reconcile against the live file.

## Maintenance notes

- Keep the public-code enumeration documented (a short `@moduledoc` note or a comment on
  `public_error/1`) so future error sites use it instead of `inspect/1`.
- If a structured logger is added later (a separate DX finding), log the precise reason +
  `request_id` there; for now the server-side `Audit` is the retained detail.
- A reviewer should confirm no internal atom is reachable in any client frame and that
  the browser demo still handles failures.
