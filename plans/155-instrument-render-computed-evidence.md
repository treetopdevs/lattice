# Plan 155: Render the evidence the Township instrument already computes (authority ledger + replay frame detail)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c9a05b40..HEAD -- apps/township_web/lib/township_web/instrument_live.html.heex apps/township_web/assets/js/causal_replay.js apps/township_web/test/township_web/instrument_live_test.exs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Implementation status**: DONE — PR #32 merged at `949d13ab`; hosted run `29755770936`
  passed Unit + property, flagship artifact, and packaged macOS convergence.
- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none (executes cleanly before or after 154; do it before 157)
- **Category**: direction
- **Planned at**: commit `c9a05b40`, 2026-07-18

## Why this matters

The instrument's thesis is *verifiable authority*, yet two of its richest computed
artifacts never reach the screen. First, `Township.ReadModel.observe/2` ships the ordered
authority audit ledger (`roles.audit` — every quarantine event with its `event`, `op`,
`reason`, and `role`) into the LiveView assigns and into `audit.json` for outside
auditors, but the template renders only a flat "reason atom + op id" strip. Second, the
causal-replay payload computes, **per frame**, the full materialized state, the role
holders, and the frontier — and the Vue island renders only `state.summary`. Both gaps
are pure presentation: the verified data is already flowing to the client and being
dropped. Closing them turns the marquee scrubber into the "who could act, and what did
the town see, at step N" story the demo narrates verbally, at near-zero risk.

## Current state

Relevant files:

- `apps/lattice_core/lib/township/read_model.ex` — the data producer (do NOT modify):
  - `observe/2` line 65–70 puts the ledger into the model:
    ```elixir
    roles: %{
      holders: fingerprint_holders(analysis.holders),
      quarantine: analysis.quarantine |> MapSet.to_list() |> Enum.sort(),
      reasons: analysis.reasons,
      audit: analysis.audit
    },
    ```
    Ledger entry shapes (from `apps/lattice_core/lib/lattice/authority.ex:752,800`):
    `%{event: :authority_quarantine, op: op_id, reason: atom, role: atom}` and
    `%{event: :command_quarantine, op: op_id, reason: atom}` (no `:role` key).
    Note: the ledger contains ONLY quarantine events — do not label it a succession
    or acquisition history in the UI copy.
  - `replay/1` line 110–128 builds per-frame payloads:
    ```elixir
    %{
      "index" => index,
      "head" => head.id,
      "visible_ids" => sub_log |> Log.op_ids() |> Enum.sort(),
      "frontier" => frontier,
      "state" => Matter |> Lattice.state_at(log, frontier) |> state_view(),
      "holders" => json_holders(analysis.holders),
      "quarantine" => json_reasons(analysis.reasons)
    }
    ```
    `state_view/1` (line 162) keys: `"title"`, `"summary"`, `"posts"`, `"members"`,
    `"clerk_locked"`. `json_holders/1` maps role-name string → fingerprint-or-nil.
- `apps/township_web/lib/township_web/instrument_live.html.heex` — the roles panel
  (lines 392–420) renders holders and the quarantine strip only:
  ```heex
  <div class="audit-strip">
    <p class="field-label">Authority quarantine</p>
    <div
      :for={op_id <- @model.roles.quarantine}
      class="audit-event"
      data-reason={@model.roles.reasons[op_id]}
    >
      <span>{Atom.to_string(@model.roles.reasons[op_id])}</span>
      <code>{String.slice(op_id, 0, 12)}</code>
    </div>
  </div>
  ```
  `@model.roles.audit` appears nowhere in the template (grep confirms).
- `apps/township_web/assets/js/causal_replay.js` — the Vue 3 island (Phoenix hook
  `TownshipCausalReplay`). Frame-state block at lines 141–148 renders only the summary:
  ```js
  h("div", { class: "causal-replay__frame-state" }, [
    h("span", { class: "field-label" }, "Summary at frontier"),
    h(
      "strong",
      { "data-replay-summary": "" },
      frame.value.state.summary || "—",
    ),
  ]),
  ```
  `frame.value.holders`, `frame.value.frontier`, and the rest of `frame.value.state`
  are currently unread (grep for `holders` in the file returns nothing).
- Tests: `apps/township_web/test/township_web/instrument_live_test.exs` — LiveView
  rendering assertions (the structural pattern to extend);
  `apps/lattice_core/test/township/causal_replay_test.exs` and
  `read_model_test.exs` — payload producers (do NOT modify; the payload is unchanged).
- The instrument is server-rendered and must stay usable without JavaScript (there is a
  Playwright check named around "verifi…available-without-JavaScript" under `tests/`);
  the LiveView panels are plain HEEx, the island is progressive enhancement.

## Commands you will need

Local toolchain rule (from `AGENTS.md`): invoke `~/.asdf/shims/mix`, with OTP 28 bins
prepended for spawned tools:

```
PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix <task>
```

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused LiveView tests | `~/.asdf/shims/mix test apps/township_web/test/township_web/instrument_live_test.exs` | all pass |
| Full gate | `~/.asdf/shims/mix verify` | green |
| Strict lint | `~/.asdf/shims/mix check` | green |
| Sobelow (township_web touched) | `cd apps/township_web && ~/.asdf/shims/mix sobelow --exit --skip` | no findings |

npm caveat (from memory/`AGENTS.md`): the npm shell wrapper recurses on this machine —
if you need node tooling, call binaries via `node_modules/.bin/` directly. For this plan
you should NOT need a JS build; `causal_replay.js` is consumed as an asset by the
existing pipeline.

## Scope

**In scope** (the only files you should modify):

- `apps/township_web/lib/township_web/instrument_live.html.heex`
- `apps/township_web/assets/js/causal_replay.js`
- `apps/township_web/test/township_web/instrument_live_test.exs` (extend)

**Out of scope** (do NOT touch, even though they look related):

- `apps/lattice_core/lib/township/read_model.ex` and
  `apps/lattice_core/lib/lattice/authority.ex` — the payload already carries everything
  needed; any "I need one more field" urge belongs to plan 157.
- `apps/township_web/lib/township_web/instrument_live.ex` — assigns already carry
  `@model` and the replay payload; no server change is needed.
- The intent-slot / action-handoff panels and their descriptors (Plan 143 consolidated
  them; do not disturb).
- `apps/lattice_core/test/township/*` — producer tests are contracts; unchanged.

## Git workflow

- Branch: `advisor/155-instrument-render-computed-evidence`.
- Commit style: `feat(township_web): render authority ledger and replay frame detail`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Authority ledger panel (HEEx only)

In `instrument_live.html.heex`, inside the roles panel `<section>` (after the existing
`audit-strip` div, before the section close at line 420), add an "Authority ledger"
block rendering `@model.roles.audit` in order:

```heex
<div class="audit-ledger" data-audit-ledger>
  <p class="field-label">Authority ledger · ordered quarantine events</p>
  <ol>
    <li
      :for={entry <- @model.roles.audit}
      data-ledger-event={Atom.to_string(entry.event)}
      data-ledger-reason={Atom.to_string(entry.reason)}
    >
      <span>{Atom.to_string(entry.event)}</span>
      <span :if={Map.has_key?(entry, :role)}>{Atom.to_string(entry.role)}</span>
      <span>{Atom.to_string(entry.reason)}</span>
      <code>{String.slice(entry.op, 0, 12)}</code>
    </li>
  </ol>
  <p :if={@model.roles.audit == []} class="field-label">No quarantine events.</p>
</div>
```

Match the surrounding markup idiom (the file uses `data-*` attributes for test hooks
throughout — keep that). Guard every map access: `command_quarantine` entries have no
`:role` key, which is why the `:if={Map.has_key?(entry, :role)}` guard is load-bearing.
Reuse existing CSS classes (`field-label`, `audit-event`-style look) rather than
inventing a design system; if you add CSS, put it wherever the panel styles already
live (check `apps/township_web/assets/css/` for the file styling `.audit-strip`).

**Verify**:
`~/.asdf/shims/mix test apps/township_web/test/township_web/instrument_live_test.exs`
→ existing tests still pass (panel addition must not break any current assertion).

### Step 2: Replay island — holders and state at frame

In `causal_replay.js`, extend the `causal-replay__frame-state` block (lines 141–148) to
render, from the already-present `frame.value`:

- **Holders at frame**: iterate `Object.entries(frame.value.holders || {})` sorted by
  role name; render `role → fingerprint` (or "unheld" when null), each with
  `"data-replay-holder": role` so tests/Playwright can target them.
- **State at frame**: title (`frame.value.state.title || "—"`), members count
  (`(frame.value.state.members || []).length`), posts count, and clerk-locked flag,
  with `data-replay-state-title`, `data-replay-members-count`,
  `data-replay-posts-count`, `data-replay-clerk-locked` attributes.
- **Frontier at frame**: render `frame.value.frontier` ids (truncate each to 12 chars
  like the existing node labels; the file already has a `truncate` helper used at line
  187) under a "Frontier" label with `data-replay-frontier`.

Keep the existing summary line and its `data-replay-summary` attribute unchanged —
Playwright suites key on `data-*` hooks and the existing ones must not move or vanish.
Follow the file's established `h(...)` render-function style (no SFC, no template
strings). All values come from the server-derived payload; render as text nodes only
(Vue `h` text children are safe — do not use `innerHTML`).

**Verify**: `grep -n "data-replay-holder\|data-replay-frontier" apps/township_web/assets/js/causal_replay.js`
→ both present; `grep -c "innerHTML" apps/township_web/assets/js/causal_replay.js` → `0`.

### Step 3: LiveView tests

Extend `apps/township_web/test/township_web/instrument_live_test.exs`, following its
existing setup pattern (whatever bundle/source fixture the current tests mount):

1. Ledger renders: the rendered HTML contains `data-audit-ledger`, and for a fixture
   with at least one quarantined op, a `data-ledger-reason` attribute matching a known
   reason atom from the fixture (find the fixture's quarantine expectations in the
   existing tests — e.g. the `not_holder` beat used across Township tests).
2. Ledger event without role: if the fixture produces a `command_quarantine` entry,
   assert it renders without crashing (this is the `Map.has_key?` guard's regression
   test). If the current fixture has no command quarantine, add the assertion that the
   page renders with the ledger present and note which entries exist — do NOT modify
   the fixture scenario to force one (fixtures are shared contracts).
3. Empty ledger: for a fixture/source with no quarantine (if one exists in the current
   tests), assert "No quarantine events." renders.
4. Replay payload keys: assert the `data-replay` JSON on the island mount node still
   contains `holders` and `frontier` for frame 0 (guards against someone "optimizing"
   the payload away later).

**Verify**:
`~/.asdf/shims/mix test apps/township_web/test/township_web/instrument_live_test.exs`
→ all pass, including the new assertions.

### Step 4: full gates

**Verify**: `~/.asdf/shims/mix verify` → green; `~/.asdf/shims/mix check` → green;
`cd apps/township_web && ~/.asdf/shims/mix sobelow --exit --skip` → no findings.
If the repo's Playwright township suites are runnable locally
(`playwright.township.config.mjs`; browsers may not be installed), run the instrument
suite; if the environment lacks browsers, note that in your report instead of
installing anything.

## Test plan

Covered in Step 3 (four named cases) plus the existing instrument suite as regression.
Structural pattern: the existing tests in `instrument_live_test.exs`. JS behavior is
covered indirectly through the payload-shape assertion and the Playwright suites; do
not add a JS unit-test framework for this plan.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `~/.asdf/shims/mix test apps/township_web/test/township_web/instrument_live_test.exs` exits 0 with the new assertions
- [ ] `~/.asdf/shims/mix verify` exits 0
- [ ] `~/.asdf/shims/mix check` exits 0
- [ ] `cd apps/township_web && ~/.asdf/shims/mix sobelow --exit --skip` exits 0
- [ ] `grep -n "roles.audit" apps/township_web/lib/township_web/instrument_live.html.heex` → at least one match
- [ ] `grep -c "innerHTML" apps/township_web/assets/js/causal_replay.js` → `0`
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 155 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The heex roles panel or the `causal_replay.js` frame-state block does not match the
  excerpts above (drift — possibly a parallel session; check
  `git log --oneline -5 -- apps/township_web`).
- Any existing test in `instrument_live_test.exs` or any Playwright `data-*` selector
  breaks and the fix would require renaming/moving an existing `data-replay-*` or
  panel attribute — those are shared contracts; report instead.
- You need a field that is not already in `roles.audit` or the replay frame payload —
  that extension is plan 157's scope, not yours.
- The ledger for the shared fixtures renders more than ~50 entries and the page
  becomes unwieldy — report with the count rather than inventing pagination.

## Maintenance notes

- Plan 157 (authority observability surface) will add role acquisition history and
  lease/beacon data; this panel is where those will likely render — keep the ledger
  markup list-shaped so 157 can add sibling blocks without restructuring.
- Plan 154's HTML audit report renders the same `roles.audit` ledger; if the gloss/copy
  evolves there, mirror the wording here (and vice versa) so the two audit surfaces
  agree.
- Reviewer scrutiny: the `Map.has_key?(entry, :role)` guard (mixed entry shapes), and
  that no existing `data-*` hooks changed (Playwright contracts).
