# Plan 173: Bounded carrier transport — connect deadlines, and paged pulls before history outgrows the frame budget

> **Executor instructions**: Follow this plan step by step. Run every verification command
> and confirm the expected result before moving to the next step. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 91bb6ca6..HEAD -- apps/lattice_web_socket/lib apps/lattice_carrier_server/lib/lattice_carrier_server/web_socket.ex apps/lattice_carrier_server/lib/lattice_carrier_server/holder.ex clients/lattice-client/src/carrier.ts
> ```
> If any in-scope file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Execution**: local PR65 remediation verified; exact follow-up review and hosted
  closure remain pending. The unified-roadmap integrator owns the shared plan-index row.
- **Priority**: P1 — Part B is a deterministic compatibility cliff that triggers on **normal
  history growth** with no adversary and no overload. Part A is a hang primitive.
- **Effort**: M–L — Part A is small; Part B is a protocol addition (continuations) that must
  stay wire-compatible with peers that do not send them.
- **Risk**: Part A LOW, Part B **HIGH** — Part B changes the carrier request/response contract
  and touches the convergence path that every acceptance gate depends on. **Commit the two parts
  separately** (see Git workflow); their risk profiles are not comparable and a reviewer must be
  able to approve Part A without approving Part B.
- **Depends on**: `plans/169-carrier-control-frames-carry-no-authority.md` — 169 rewrites the
  acknowledgement logic inside `syncCarrierOnce`, and Part B adds continuation handling to the
  same pull loop in the same function. **Land 169 first**; do not run them concurrently.
- **Category**: bug (Part B), security (Part A)
- **Planned at**: commit `91bb6ca6`, 2026-08-06

## Why this matters

**Part A — the client can hang before the peer proves anything.**
`Lattice.Transport.WebSocket.Client.init/1` calls `:gen_tcp.connect/3` with no timeout argument,
so it defaults to `:infinity`. Because this runs inside `init/1`, the caller's `start_link` blocks
for as long as the TCP connect and the HTTP upgrade take. A configured endpoint that accepts the
connection and then simply never completes the upgrade stalls the projection indefinitely, before
the peer has proved possession of any key. There is no pre-authentication deadline on the client
side at all.

**Part B — normal growth eventually makes a log unsynchronizable.**
The carrier server answers `"pull"` by encoding **every** missing op into one frame. The client
enforces `@max_frame_size 64_000` and refuses anything larger. These two facts are on a collision
course that nothing in the system currently prevents:

- server emits the complete missing set in a single frame,
- client refuses frames above 64 KB,
- ordinary history growth eventually crosses that boundary,
- from then on the client rejects its own peer's well-formed response, permanently.

No attacker and no burst is required — it is a latent, deterministic break that gets closer with
every legitimate op. A fresh replica syncing from a mature log hits it first and hardest, which
is exactly the onboarding path. The same unpaged shape also makes `"frontier"` and `"pull"` an
asymmetric amplifier (a ~50-byte request yields an unbounded response), but the **correctness**
consequence is what makes this P1 rather than hardening.

## Current state

### Part A — no connect deadline, `apps/lattice_web_socket/lib/lattice/transport/web_socket/client.ex:68-76`

```elixir
  @impl true
  def init(opts) do
    host = Keyword.get(opts, :hostname, Keyword.get(opts, :host, "localhost"))
    port = Keyword.fetch!(opts, :port)
    path = Keyword.get(opts, :path, "/ws")

    with {:ok, socket} <-
           :gen_tcp.connect(String.to_charlist(host), port, [:binary, active: false, packet: :raw]),
         {:ok, buffer} <- handshake(socket, host, port, path),
```

`:gen_tcp.connect/3` — three arguments, no `Timeout`. `handshake/4` then reads the upgrade
response off the socket.

### Part B — the client's cap, `client.ex:17` and `:399`

```elixir
  @max_frame_size 64_000
```

```elixir
  defp validate_server_length(length) when length <= @max_frame_size, do: :ok
```

### Part B — the server's unpaged response, `apps/lattice_carrier_server/lib/lattice_carrier_server/web_socket.ex:169-176`

```elixir
  defp handle_message("frontier", _message, state) do
    %{type: "frontier_result", ids: Holder.op_ids(state.holder)}
  end

  defp handle_message("pull", %{"have" => have}, state) when is_list(have) do
    ops = state.holder |> Holder.missing_for(have) |> Enum.map(&Wire.encode_op/1)
    %{type: "ops", ops: ops}
  end
```

`Holder.op_ids/1` returns the whole sorted id list (`holder.ex:118-120`); `missing_for/2` returns
every missing op (`holder.ex:122-124`). Neither is bounded.

### Part B — the server's own ingress cap, `web_socket.ex:9` and `:22-23`

```elixir
  @max_frame_size 64_000
```

```elixir
    {:cowboy_websocket, req, state,
     %{idle_timeout: @authenticated_idle_timeout_ms, max_frame_size: @max_frame_size}}
```

The server bounds what it *receives* and not what it *sends*. Both sides agree on 64 000 for
ingress, which is the number Part B must page against.

### Repo conventions to match

- Elixir modules carry `@moduledoc` and `@spec`; all code is `mix format`-clean.
- The carrier's request/response messages are plain JSON maps with a `"type"` field, decoded in
  `web_socket.ex`'s `handle_message/3` and in the TypeScript client's request path. New fields
  must be **optional** so an older peer is unaffected.
- `apps/lattice_server/lib/lattice_server/rate_limiter.ex` is the existing limiter shape — read
  it before writing anything new, and reuse rather than reinvent.
- TypeScript is strict ESM with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

## Commands you will need

```bash
export MIXCMD="$HOME/.asdf/shims/mix"
export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"
```

| Purpose | Command | Expected on success |
|---|---|---|
| Format check | `$MIXCMD format --check-formatted` | exit 0 |
| Full suite | `$MIXCMD test` | exit 0 |
| Credo | `$MIXCMD credo --strict` | exit 0 |
| Carrier server suite | `$MIXCMD test apps/lattice_carrier_server/test` | all pass |
| WS client suite | `$MIXCMD test apps/lattice_web_socket/test` | all pass |
| G1 carrier acceptance | `$MIXCMD test apps/lattice_node_spike/test` | all pass |
| TS typecheck | `cd clients/lattice-client && npm run typecheck` | exit 0 |
| TS carrier gates | `cd clients/lattice-client && npm run carrier:township && npm run carrier:relay && npm run carrier:relay-sync && npm run carrier:feed && npm run carrier:township:live` | exit 0 |
| TS build | `cd clients/lattice-client && npm run build` | exit 0 |

Baseline at the planned-at commit: `$MIXCMD test` exits 0.

## Scope

### Unified R08 execution amendments — 2026-09-06

- Plan 169 is already integrated (`dff9e285` is reachable from the execution base
  `641cbbd78bf1338a4a245e5a670ad425aa79be1b`); preserve its acknowledgement semantics.
- The BEAM adapter lives at `apps/lattice_web_socket/lib/lattice/carrier/web_socket.ex`.
  The required acceptance tests in `apps/lattice_node_spike/test/` are explicitly in scope,
  as are both clients' frontier loops.
- Use app `test/` directories for umbrella test selection; app-root arguments silently
  select no tests. Existing HTTP reads have a 5,000 ms per-read timeout; Part A adds the
  configured total deadline, including slow trickles, rather than claiming every stalled
  upgrade previously waited forever.
- Pagination adds optional `cursor` requests and `next_cursor` responses, leaving terminal
  and small legacy responses unchanged. Pull pages retain `Sync.missing/2`'s deterministic
  topological order so cursor-ignorant clients can accept each causal prefix. Frontier IDs
  remain sorted. Never sort pull history globally by ID: a dependent-only prefix can stall
  an older client permanently. Legacy clients progress across repeated synchronization
  calls; one cursor-ignorant call does not establish complete history or frontier coverage.
  Both upgraded clients collect every frontier and pull page before reporting success.
- A stateless cursor is at most 512 encoded bytes and contains `version: 1`, the last
  emitted ID in `after`, an increasing integer `offset`, and a snapshot digest bound to
  the request kind, replica and complete ID set. Pull cursors also bind the fixed initial
  `have` set by digest. Validate exact keys, types, bounds, snapshot/filter and `after`
  membership at `offset - 1`. There is no per-client server pagination cache. A cursor's
  lifetime is its exact snapshot: an unchanged-log restart preserves it; mutation or a
  different route/filter refuses it. Interrupted sync starts afresh.
- Each client accepts at most 1,024 pages, validates exact offset advancement by page count,
  last-ID binding and duplicate absence, and discards all partial results on any refusal or
  cap. These transport fields carry no semantic authority. Operation signature, hash and
  replica verification and acknowledgement semantics remain unchanged.
- Initial `have` requests are bounded to 48,000 encoded bytes; larger local histories send
  an empty set and replay authenticated duplicates. Repeat that fixed bounded set with
  continuations instead of growing the request beyond the existing 64,000-byte ingress cap.
  Page sizing includes encoded JSON and continuation overhead. Preserve the source plan's
  explicit single-oversized-operation exception and existing client refusal.

**In scope**:

- **Part A**: `apps/lattice_web_socket/lib/lattice/transport/web_socket/client.ex`,
  `apps/lattice_web_socket/test/`
- **Part B**: `apps/lattice_carrier_server/lib/lattice_carrier_server/web_socket.ex`,
  `apps/lattice_carrier_server/lib/lattice_carrier_server/holder.ex` (bounded read functions
  only), `clients/lattice-client/src/carrier.ts` (frontier and pull loops),
  `apps/lattice_web_socket/lib/lattice/carrier/web_socket.ex` (BEAM frontier and pull loops),
  `apps/lattice_carrier_server/test/`, `clients/lattice-client/test/`
- `clients/lattice-client/dist/**` — regenerated by `npm run build`, never hand-edited
- `plans/README.md` — status row

**Out of scope** (do NOT touch, even though they look related):

- **`Lattice.Log`'s persistence format.** Paging is a *transport* concern. Do not change
  `dump/2`/`restore/1`, and do not introduce an append-only journal — that is explicitly
  deferred by plan 165 and would collide.
- **`syncCarrierOnce`'s acknowledgement logic.** That is **plan 169**. If 169 has not landed,
  STOP and land it first: both plans edit the same function and the merge is not worth it.
- **The relay path and quarantine growth** — plan 165 Part C owns those. This plan bounds reads,
  not writes.
- **Raising `@max_frame_size` on either side.** Making the number bigger moves the cliff; it does
  not remove it. If you find yourself proposing that, STOP and report.
- **Authentication or the session handshake.** Part A adds a *deadline*, not a new auth step.

## Git workflow

- Branch: `codex/173-bounded-carrier-transport`
- **Two separate commits minimum**, because the risk profiles differ sharply:
  1. `fix(carrier): bound client connect and pre-auth setup` — Part A
  2. `feat(carrier): page pull responses under the shared frame budget` — Part B
  Do not squash them. A reviewer must be able to accept Part A independently.
- Conventional commits matching `git log`; RED tests in their own commit before each part.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (RED): Prove the connect hang

Add a test in `apps/lattice_web_socket/test/` that starts a listening socket which accepts the
TCP connection and then never responds to the HTTP upgrade, and asserts that
`Client.start_link/1` returns an error within a bounded time rather than blocking.

Use a short configured timeout in the test so the suite stays fast. Read the existing
`client_test.exs` first and follow how it constructs test peers.

**Verify**: `$MIXCMD test apps/lattice_web_socket/test` → **the new test FAILS by timing out**. If it
passes, the deadline already exists — STOP and report.

### Step 2 (GREEN): Bound connect and pre-auth setup

In `client.ex`, add a `:connect_timeout` option (default it to something small enough to fail
fast and large enough for a real WAN handshake — 5_000 ms matches the carrier server's
`@authentication_timeout_ms`), pass it as `:gen_tcp.connect/4`'s fourth argument, and apply a
deadline to `handshake/4`'s read of the upgrade response so a peer that accepts and stalls is
also caught.

Bound the upgrade response too: cap the bytes `handshake/4` will accumulate before it gives up,
so a peer cannot stream unbounded headers pre-authentication. Reuse `@max_frame_size` as the
budget rather than inventing a second constant.

**Verify**: `$MIXCMD test apps/lattice_web_socket/test` → all pass including the step-1 test.
Then `$MIXCMD test apps/lattice_node_spike/test` → still passes (the G1 acceptance harness uses this
client; a too-tight default would show up here).

**Commit Part A now, before starting Part B.**

### Step 3 (RED): Prove the frame cliff

Add a test in `apps/lattice_carrier_server/test/` that builds a log whose encoded missing-op set
exceeds 64 000 bytes, serves a `"pull"` with `have: []`, and asserts the response frame is within
the shared budget.

To size the log without a huge fixture, note that `Wire.encode_op/1` output is dominated by
base64 author/sig plus the body; generating on the order of a few hundred ops with modest bodies
is enough. Measure with `byte_size(Jason.encode!(reply))` and assert against 64 000.

**Verify**: `$MIXCMD test apps/lattice_carrier_server/test` → **the new test FAILS** (the reply
exceeds the budget). Record the measured size in your report — it is the evidence the cliff is
real at a realistic log size.

### Step 4 (GREEN): Page `pull` with an optional continuation

Change `handle_message("pull", ...)` to emit at most a budgeted prefix of the missing set, plus
an explicit continuation signal. Requirements:

- **Wire-compatible.** A peer that ignores the continuation field must still make progress —
  each response must be a valid prefix, so an old client converges in more round trips rather
  than breaking. Add fields; do not repurpose existing ones.
- **Budget by encoded bytes, not op count.** Op sizes vary by orders of magnitude; a count-based
  cap does not bound the frame. Accumulate `Wire.encode_op/1` output and stop before the budget.
- **Deterministic order.** The prefix must be stable across calls with the same `have` set, or a
  client can loop forever re-fetching the same page. `Holder.missing_for/2` currently returns
  `Sync.missing/2`'s order — confirm it is deterministic and, if it is not, sort by op id.
- **Progress guarantee.** If a single op exceeds the budget on its own, the server must still
  emit it rather than returning an empty page forever. Document that this is the one case where
  the budget is exceeded, and note that such an op is unsyncable to a 64 KB client regardless —
  that is a genuine limit worth stating, not hiding.

Do the same for `"frontier"` if `Holder.op_ids/1` can exceed the budget on a mature log; measure
first and say so in your report either way.

**Verify**: `$MIXCMD test apps/lattice_carrier_server/test` → all pass including step 3.

### Step 5 (GREEN): Consume the continuation in both clients

Two clients pull: the BEAM one in `apps/lattice_web_socket/lib/lattice/carrier/web_socket.ex` and the
TypeScript one in `clients/lattice-client/src/carrier.ts`. Both must loop until the server
reports no continuation.

Bound the loop: a maximum number of pages per sync, so a misbehaving or looping peer cannot pin
the client forever. On exceeding it, fail with a named error rather than silently returning a
partial set — a partial pull that looks complete is exactly the silent-non-convergence failure
mode this plan exists to prevent.

**Verify**: `cd clients/lattice-client && npm run typecheck && npm run build` → exit 0, then all
five carrier gates from the commands table → exit 0.

### Step 6: End-to-end convergence across a page boundary

Add an acceptance-level test that converges a log **larger than one page** end to end and
asserts the final materialized state matches the `Lattice.Sim` oracle — the same comparison the
existing G1 harness makes. Paging is only correct if convergence is unchanged; a unit test on
the page shape does not prove that.

Put it where the existing carrier convergence tests live
(`apps/lattice_node_spike/test/township_carrier_test.exs` is the G1 pattern; read it first).

**Verify**: `$MIXCMD test apps/lattice_node_spike/test` → exit 0 with the new multi-page case.

### Step 7: Full gate

```bash
$MIXCMD format --check-formatted && $MIXCMD test && $MIXCMD credo --strict
cd clients/lattice-client && npm run typecheck && npm run conformance && npm run canonical \
  && npm run carrier:township && npm run carrier:relay && npm run carrier:relay-sync \
  && npm run carrier:feed && npm run carrier:township:live
```

**Verify**: every command exits 0.

## Test plan

Part A:
1. `apps/lattice_web_socket/test/` — a peer that accepts TCP and never completes the upgrade
   causes `start_link/1` to return an error within the deadline, not block.
2. Same file — a peer that streams unbounded upgrade headers is rejected at the byte budget.

Part B:
3. `apps/lattice_carrier_server/test/` — a `"pull"` against a log whose missing set exceeds
   64 000 bytes returns a frame within budget plus a continuation signal.
4. Same file — repeated pulls with the continuation eventually return the complete set, and the
   page sequence is deterministic across identical calls.
5. Same file — a single op larger than the budget is still emitted (progress guarantee).
6. `apps/lattice_node_spike/test/` — a log spanning multiple pages converges to a state
   byte-identical to the `Lattice.Sim` oracle.
7. `clients/lattice-client/test/` — the TS pull loop follows continuations and fails with a
   named error at the page cap rather than returning a partial set.

Verification: `$MIXCMD test` → exit 0; the five TS carrier gates → exit 0.

## Done criteria

### Unified R08 execution evidence — 2026-09-06

- RED setup: a configured 50 ms deadline did not return within 500 ms before Part A.
  A separate streaming-header regression proves rejection of a 64,001-byte upgrade.
- RED history: 200 ordinary dependent posts produced a 200,741-byte unpaged pull.
  The 1,500-ID frontier measured 69,034 bytes before paging; the unmodified BEAM loop
  returned only 1,386 of those IDs after the server began paging.
- The new server, BEAM and TypeScript regressions prove complete bounded draining,
  deterministic causal order, repeated-call legacy progress, cursor/filter/snapshot
  refusal, duplicate and page-cap refusal, bounded initial requests, and the explicit
  single-oversized-operation limit.
- `LatticeNodeSpike.CarrierPaginationTest` kills its own second-BEAM peer after one
  page, restarts from the same log, resumes the stateless cursor, and compares complete
  operation IDs and deterministic materialized-state bytes against `Lattice.Sim`.
- Full Elixir tests: 675 tests and 27 properties, zero failures, three existing exclusions.
  After validation-helper cleanup, the final carrier/WS/node suites pass 165 tests,
  and formatting plus strict Credo exit zero. Credo retains existing advisory findings
  outside the changed files.
- TypeScript typecheck, build, conformance, canonical, `carrier:township`, `carrier:relay`,
  `carrier:relay-sync`, `carrier:feed` and `carrier:township:live` all exit zero. The feed
  gate includes the new pagination refusal matrix. The generated conformance JS also
  catches up two cases already present in its unchanged source.
- Part A is committed separately as `34a17e3a85e87ce91a038b4b9ee3424498e0bee2`.
  The unified-roadmap integrator owns the shared README status update and final review.

Machine-checkable. ALL must hold:

- [x] `$MIXCMD format --check-formatted` exits 0
- [x] `$MIXCMD test` exits 0
- [x] `$MIXCMD credo --strict` exits 0
- [x] `cd clients/lattice-client && npm run typecheck && npm run conformance && npm run canonical` — all exit 0
- [x] All five TS carrier gates exit 0
- [x] `rg -n 'connect_timeout|:gen_tcp.connect\(' apps/lattice_web_socket/lib/lattice/transport/web_socket/client.ex` shows a four-argument connect
- [x] The 7 tests named in the test plan exist and pass
- [x] `git log --oneline` shows Part A and Part B in **separate** commits
- [x] Your report records the measured pre-fix `"pull"` response size from step 3
- [x] `git status --porcelain` lists no file outside the in-scope list
- [ ] `plans/README.md` status row for 173 updated — integrator-owned at hosted closure;
  this packet does not edit the shared index. The checked criteria above reflect the
  recorded local evidence, not a claim that PR65's current hosted checks have passed.

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 169 has not landed. Both plans edit `syncCarrierOnce`; running them concurrently produces
  a merge that cannot be reviewed.
- The step-1 or step-3 test passes before the fix — that gap is already closed.
- Paging changes the materialized state in step 6. Convergence must be identical; if it is not,
  the page boundary is leaking into reduction and the design is wrong.
- You find yourself wanting to raise `@max_frame_size` on either side to make a test pass.
- An existing acceptance gate (G1, the packaged smokes, the live carrier test) goes red and the
  cause is the new pre-auth deadline being too tight. Report the measured handshake time rather
  than quietly raising the default.
- The continuation design would require a breaking change to the `"pull"` request shape. It must
  be additive; a breaking change needs its own plan and a version bump.

## Maintenance notes

For the human or agent who owns this next:

- **What a reviewer should scrutinize**: step 6. Everything else is shape; step 6 is the only
  test that proves paging did not change what the two sides converge to.
- **The limit this does not remove**: a single op larger than the frame budget remains
  unsyncable to a client enforcing that budget. Paging bounds the *response*, not the *op*.
  Say so in the carrier's moduledoc rather than leaving it implicit — and note that
  `Wire.encode_op/1` output size is driven by the op body, which `Township.Matter` does not
  currently bound. A body-size cap at authoring time is the complementary fix and is a separate
  question.
- **Interacting future work**: plan 165 Part C bounds relay *writes* and quarantine growth on
  the same two files. Land this first if both are queued — Part C's rate limiting is easier to
  reason about once reads are bounded. Plan 169 must precede this one.
- **Explicitly deferred**: `max_connections` on both ranch listeners, and a per-connection token
  bucket covering `pull` and `relay`. Both are real (neither listener sets a connection cap
  today) and both are additive hardening rather than correctness — they belong with plan 165
  Part C's limiter work, not here.

### 2026-09-06 integration review follow-up

Claude Fable reviewed `641cbbd7..8722403f`: PASS, no P0/P1. The integrator
accepted its documented performance and legacy-peer follow-ups without changing
the transport protocol. During R09 integration, the new 50 ms setup fixture was
scheduler-sensitive: the peer could miss the already-closed connection and wait
in an unbounded accept. A focused retry also exceeded its 500 ms observer budget.
Neither failed run is reported as green.

The fixture now starts its peer before the connector, bounds accept/cleanup,
runs serially, and uses a 500 ms configured setup timeout observed within two
seconds. The unchanged legacy five-second read still fails this regression;
the header-bound assertion also remains. No production timeout or assertion of
received request/socket closure was relaxed. Re-running both tests against the
original client produced two failures; restored reviewed production bytes then
passed all 20 WebSocket tests and the real second-BEAM replay test. That accepted
final run used `ERL_FLAGS='+S 4:4'` under concurrent host load; formatting and
whitespace passed. A preliminary run overlapping the temporary baseline source
substitution is not used as final evidence.

The new second-BEAM fixture also resolves the local asdf Elixir executable with
a PATH fallback for `erlef/setup-beam` CI. This repairs test portability without
changing the exercised process/restart behavior. Logs are under
`/tmp/lattice-treehouse-execution-20260906/r08-setup-fixture-*.log` and
`r08-final-fixture-green.log`; exact follow-up review and hosted gates remain.

### PR65 review remediation — 2026-09-06

Public RED `f826dab5` records two defects at reviewed head `a172265e`:
after receiving 63,999 unterminated header bytes, setup received another 9,216
bytes before enforcing its one-byte remaining allowance; and an explicit JSON
null cursor restarted both read kinds instead of refusing malformed input.
The omitted-cursor legacy control remains valid. The RED log is
`/tmp/lattice-treehouse-execution-20260906/r08-pr65-red.log`.

Setup now sets the raw socket driver's buffer to the remaining header allowance
before each `recv(0)`, checks the returned chunk before concatenating it, and
restores the original driver buffer after a successful upgrade. The public
resource regression observes socket reads during `Client.start_link/1`: it now
receives exactly the one remaining byte before refusal. The total setup deadline
and 64,000-byte allowance are unchanged. Positive controls accept short and
exactly 64,000-byte upgrades and deliver both coalesced WebSocket frames. Reads
never wait for a fixed number of bytes beyond the header terminator. Present-null
frontier/pull cursors now return `malformed_cursor`; omitted cursors keep the
legacy request shape. The focused 12-test gate passes in
`r08-pr65-green.log` beside the RED evidence.

The second-BEAM fixture now chooses the required local asdf shim and supplies its
own OTP 28/Elixir PATH prefix to the child. `erlef/setup-beam` CI retains a PATH
executable fallback, with an explicit diagnostic if no Elixir executable exists.
Earlier prescribed-prefix runs remain valid evidence; this makes the fixture
self-contained when a caller has an unprefixed PATH. A separate fixture probe
prepended a synthetic shadow `erl` after the parent VM started: the original
fixture exited 97 with `SHADOW_ERL_SELECTED`, and the updated fixture passed its
real two-process replay/restart test. These RED/GREEN logs are
`r08-child-path-red.log` and `r08-child-path-green.log` in the same evidence directory.

The first remediation full run passed **678 tests and 27 properties**, with
zero test failures and three existing exclusions. Its enclosing `mix check`
then exited 8 on a new nested-branch Credo finding. The branch was rewritten as
a guarded `with` clause; strict Credo then exited zero, and all **31** focused
WebSocket/pagination/second-BEAM tests passed against the final source
`b86c0eda`. Preserve `r08-pr65-check.log` as that failed combined-gate record,
alongside `r08-pr65-credo.log` and `r08-pr65-final-focused.log`.
A subsequent exact-source `mix check` at `b86c0eda` exited zero: **678 tests and
27 properties**, zero failures, three existing exclusions, clean formatting and
strict Credo. That final run used the prescribed asdf/OTP 28 PATH and
`ERL_FLAGS='+S 4:4'`; its record is `r08-pr65-final-check.log`. Only this plan's
evidence/status text changed afterward.
TypeScript typecheck, build, conformance, canonical and all five carrier gates
also exited zero; regenerated output remained unchanged. The source has no
TypeScript edits in this remediation.

The pagination-cache suggestion remains the accepted deferred performance item
from Fable's prior review: every page recomputes sorted IDs, digests and pull
topological order in the Holder. Frame and page-count limits do not establish a
bound on relay latency under a large concurrent workload. The roadmap's workload
gate must measure that cost before selecting an optimization. This remediation
adds no shared cache or cursor/session state.
