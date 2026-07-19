# Plan 156: Human-readable election evidence report (projection, close evidence, and the non-claim manifest)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c9a05b40..HEAD -- apps/lattice_core/lib/township/election apps/lattice_core/test/township/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (presentation only) — but HIGH consequence if the honesty constraints below are violated; read them twice
- **Depends on**: none (154 recommended first only for HTML-style consistency)
- **Category**: direction
- **Planned at**: commit `c9a05b40`, 2026-07-18

## Why this matters

The M4 election foundation produces the project's most carefully structured evidence —
`Township.Election.Projection` (deterministic public result), `CloseEvidence` (which
ballot wrappers, digests, seals, and certificates a unanimous close verified), and
`SecurityProfile.research/0` (a versioned manifest of twelve security scopes, every one
an explicit `:not_claimed`). Today the only consumers are `to_canonical_term/1`
serializers and ExUnit assertions: no CLI, page, or file renders any of it. That is
exactly backwards for a research artifact whose *thesis is honest, structured
non-claiming* — the "what we do NOT claim" table is the deliverable. This plan adds a
pure formatter (`Township.Election.Report`) and a Mix task that renders an offline
bundle's verified projection plus the claim manifest into a self-contained HTML report,
in the same style as the Township audit report (plan 154).

## The honesty boundary (read first — from `CLAUDE.md`, non-negotiable)

The election foundation "makes no coercion-resistance claim." The report must be
structurally incapable of overclaiming:

1. Claim statuses render verbatim (`not_claimed` / `conditional` / `failed`) — never
   translated into softer or stronger words ("pending", "supported", "partial").
2. Every claim row must render its `exclusions` list verbatim; the manifest's current
   exclusions are "no pinned cryptographic construction" and "no completed operational
   composition review".
3. The report must carry, near the top, this fixed sentence (assert on it in tests):
   "This election foundation makes no security claim. Every scope below is explicitly
   not claimed; the profile's construction is unselected."
4. `CloseEvidence` renders with its own struct-documented caveat: it "is not global
   election finality and never advances the public foundation projection beyond
   `:setup`" (`close_evidence.ex:5-6`).
5. No green/success styling on claim rows; `not_claimed` renders neutrally.

## Current state

Relevant files (all under `apps/lattice_core/lib/township/election/`):

- `projection.ex` — the deterministic public result:
  ```elixir
  # projection.ex:9-35
  @enforce_keys [:election_id, :phase, :status, :close_id, :rejected, :faults, :claim_set_id]
  # status ::
  #   {:pending, [term()]} | {:invalid, [map()]} | {:forked, [map()]}
  #   | {:aborted, term()} | {:final, term()}
  # phase is always :setup while the profile is unselected; close_id always nil
  ```
  `to_canonical_term/1` at line 38 gives a JSON-safe map.
- `close_evidence.ex` — verified unanimous-close evidence:
  ```elixir
  # close_evidence.ex:9-20
  @enforce_keys [:election_id, :open_certificate_id, :manifest_digest,
                 :ballot_wrapper_ids, :ballot_digests, :seal_digests,
                 :certificate_op_ids, :prerequisite, :rejected]
  # prerequisite: :administrative_open_asserted
  ```
- `security_profile.ex` — `research/0` (line 58) builds the twelve-scope manifest; the
  scope names and one-line descriptions live in `@scopes` (lines 16–29:
  `board_integrity`, `convergence`, `universal_verifiability`, `eligibility`,
  `ballot_privacy`, `receipt_freeness`, `credential_surrender_resistance`,
  `forced_choice_resistance`, `forced_abstention_resistance`, `closure_safety`,
  `censorship_resistance`, `availability`). Every claim:
  `%Claim{status: :not_claimed, assumptions: [], scope: ..., exclusions: [...], evidence: []}`.
  `claim_set_id/0` (line 91) is the SHA-256 id of the canonical manifest.
  `implementation_status: :research`, `ideal_leakage: [:final_result, :ballot_count, :removed_count]`.
- `security_profile/claim.ex` — `Claim` struct + `to_canonical_term/1`
  (`status :: :not_claimed | :conditional | :failed`).
- `offline_bundle.ex` — the untrusted-input replay package:
  `verify(t()) :: {:ok, Projection.t()} | {:error, reason()}` (line 114),
  `decode(binary())` (line 169), `verify_bytes(binary()) :: {:ok, Projection.t()} | {:error, reason()}`
  (line 189). `verify_bytes` is the one-call path from raw bundle bytes to a verified
  projection.
- Task pattern to copy: `apps/lattice_core/lib/mix/tasks/lattice.township.verify_bundle.ex`
  (OptionParser strict opts, `Mix.raise` on failure — full excerpt in plan 154).
- Test patterns: `apps/lattice_core/test/township/election_offline_bundle_test.exs`
  (how to build a spec/snapshot/artifacts fixture and produce bundle bytes) and
  `election_projection_test.exs`. Reuse their fixture helpers/scenario shape rather
  than inventing a new election fixture.
- If plan 154 has landed, `apps/lattice_core/lib/township/audit_report.ex` exists —
  match its HTML conventions (inline CSS, escaping helper, no scripts). If it has not
  landed, apply the same constraints from scratch (they are restated below).

## Commands you will need

Local toolchain rule (from `AGENTS.md`):

```
PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix <task>
```

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | `~/.asdf/shims/mix test apps/lattice_core/test/township/election_report_test.exs` | all pass |
| Election suite | `~/.asdf/shims/mix test apps/lattice_core/test/township/ --only-loaded 2>/dev/null \|\| ~/.asdf/shims/mix test apps/lattice_core/test/township/` | all pass |
| Full gate | `~/.asdf/shims/mix verify` | green |
| Strict lint | `~/.asdf/shims/mix check` | green |

## Scope

**In scope** (the only files you should modify/create):

- `apps/lattice_core/lib/township/election/report.ex` (create)
- `apps/lattice_core/lib/mix/tasks/lattice.election.report.ex` (create)
- `apps/lattice_core/test/township/election_report_test.exs` (create)

**Out of scope** (do NOT touch):

- Every existing `election/*.ex` module — `Projection`, `CloseEvidence`,
  `SecurityProfile`, `Claim`, `OfflineBundle`, `Projector`, board, close policy. The
  report is a pure downstream formatter; if a field you want is missing, STOP.
- `apps/lattice_core/lib/lattice/attestation.ex` — the frozen legacy stub.
- `Township.Matter` and anything that could put election data on the Matter.
- Existing election tests — contracts.

## Git workflow

- Branch: `advisor/156-election-evidence-report`.
- Commit style: `feat(election): add human-readable evidence report formatter`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: `Township.Election.Report` formatter

Create `apps/lattice_core/lib/township/election/report.ex`:

- `@spec render(Projection.t(), keyword()) :: String.t()` — pure function; options:
  `close_evidence: %CloseEvidence{} | nil` (default nil). Renders a full self-contained
  HTML document:
  1. Header: "Township election evidence report", the election id (or "none"), phase
     (always `:setup` today — render verbatim), the fixed honesty sentence from the
     boundary section above, and the `claim_set_id`.
  2. Projection: status tag + payload rendered per variant (`{:pending, missing}` lists
     the missing requirements; `{:invalid, faults}` / `{:forked, entries}` render their
     maps as key/value rows; `{:aborted, reason}` / `{:final, term}` render inspected).
     `rejected` and `faults` lists render as tables with every map key/value shown —
     these carry the election-side quarantine reasons (`unauthorized_publisher`,
     `noncanonical_artifact`, …) that today appear nowhere human-readable; show the
     reason atoms verbatim.
  3. Close evidence (only when passed): the caveat sentence from `close_evidence.ex:5-6`,
     then counts + full id/digest lists for `ballot_wrapper_ids`, `ballot_digests`,
     `seal_digests`, `certificate_op_ids`, the `open_certificate_id`,
     `manifest_digest`, `prerequisite` verbatim, and its `rejected` table.
  4. Security manifest: render `SecurityProfile.research()` — profile id,
     `implementation_status`, construction status (`:unselected`, with nil
     paper/version/parameters shown as "none"), `ideal_leakage` list, then the
     twelve-claim table: scope name, scope description, status (verbatim), assumptions,
     exclusions, evidence. Iterate `Enum.sort_by(profile.claims, &elem(&1, 0))` for
     deterministic order.
- Same hard output constraints as plan 154: no `<script>`, no external URLs, inline
  `<style>` only, every interpolated string HTML-escaped, deterministic output
  (byte-identical for equal inputs).

**Verify**: `~/.asdf/shims/mix compile` → exit 0, no new warnings.

### Step 2: `mix lattice.election.report` task

Create `apps/lattice_core/lib/mix/tasks/lattice.election.report.ex`, modeled on
`lattice.township.verify_bundle.ex`:

- Options: `--bundle PATH` (required — path to encoded offline-bundle bytes),
  `--out PATH` (required).
- Behavior: `File.read!` the bundle bytes, call
  `Township.Election.OfflineBundle.verify_bytes(bytes)`.
  - `{:ok, projection}` → `Report.render(projection, [])`, write to `--out`, print the
    path and "projection verified by offline replay".
  - `{:error, reason}` → `Mix.raise("offline bundle verification failed: #{inspect(reason)}")`
    — write nothing (an unverifiable election bundle gets no report at all; unlike plan
    154 there is no partial-failure page, because here the input is untrusted bytes,
    not a locally produced bundle).
- Note: `CloseEvidence` is produced by the close policy at runtime and is not part of
  the offline bundle's verified output — the CLI therefore renders projection +
  manifest only. `render/2`'s `close_evidence:` option exists for BEAM-side callers
  and tests. Do not try to smuggle close evidence into the bundle format.

**Verify**: `~/.asdf/shims/mix help lattice.election.report` → shows the shortdoc.

### Step 3: tests

Create `apps/lattice_core/test/township/election_report_test.exs`, reusing the fixture
approach from `election_offline_bundle_test.exs` (build spec/snapshot/artifacts, encode
a bundle, get a verified projection) and, for close evidence, the fixture from
`election_close_policy_test.exs`:

1. **Honesty sentence**: rendered HTML contains the exact fixed sentence from the
   boundary section, and the string `not_claimed` appears exactly 12 times in claim
   rows (once per scope).
2. **No claim inflation**: the HTML does not contain the strings "receipt-free"
   preceded by anything affirmative — concretely, assert the words "guaranteed",
   "proven", and "receipt-free: yes" are absent, and that `status` cells render only
   `not_claimed`/`conditional`/`failed`.
3. **Projection variants**: render a `{:pending, [...]}` projection (the normal
   research-profile result) and assert the missing-requirement entries appear; render
   an `{:invalid, faults}` fixture (the offline-bundle tests have a malformed path)
   and assert each fault map's reason atom appears verbatim.
4. **Close evidence section**: with `close_evidence:` passed, assert the caveat
   sentence, the `administrative_open_asserted` prerequisite string, and every
   ballot-wrapper id from the fixture appear; without it, assert the section is absent.
5. **Self-containment + escaping + determinism**: no `<script`, no `http`, double
   render is byte-identical; a projection carrying a `rejected` map value containing
   `<b>x</b>` renders escaped.
6. **CLI round trip**: write fixture bundle bytes to a tmp file, run the task logic
   (`Mix.Tasks.Lattice.Election.Report.run/1` directly), assert the out-file exists
   and contains the election id; assert a corrupted bundle file raises and writes
   nothing.

**Verify**: `~/.asdf/shims/mix test apps/lattice_core/test/township/election_report_test.exs`
→ all pass.

### Step 4: full gates

**Verify**: `~/.asdf/shims/mix verify` → green; `~/.asdf/shims/mix check` → green.

## Test plan

Steps 3's six named cases; regression via the untouched election suite
(`PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix test apps/lattice_core/test/township/`)
and the corresponding `~/.asdf/shims/mix verify`. Structural patterns:
`election_offline_bundle_test.exs` (fixtures), `audit_bundle_test.exs` (report-style
assertions, if plan 154 landed).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `~/.asdf/shims/mix test apps/lattice_core/test/township/election_report_test.exs` exits 0 with the 6 cases
- [ ] `~/.asdf/shims/mix test apps/lattice_core/test/township/` exits 0 (no election contract disturbed)
- [ ] `~/.asdf/shims/mix verify` exits 0 and `~/.asdf/shims/mix check` exits 0
- [ ] `grep -rn "def render" apps/lattice_core/lib/township/election/report.ex` → present; `grep -c "<script" apps/lattice_core/lib/township/election/report.ex` → `0`
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 156 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any struct field in `Projection`, `CloseEvidence`, `SecurityProfile`, or `Claim`
  differs from the excerpts (the election foundation moved — it is under active M4
  gate work; reconcile first).
- Rendering requires new fields on election structs or changes to
  `OfflineBundle`'s format — hard out of scope; the M4 gates own those shapes.
- You cannot express something without softening or strengthening a claim status —
  the honesty boundary wins over readability every time; report the tension.
- The offline-bundle fixture helpers in the existing tests are private/unextractable
  and you'd need to modify existing test files to reuse them — copy the minimal
  fixture construction into the new test file instead; if even that requires touching
  election source modules, stop.

## Maintenance notes

- When an M4 gate eventually flips a claim to `:conditional`, this report renders it
  automatically — reviewers of that future change should re-read the "no claim
  inflation" test, which will need updating (deliberately: it pins today's all-
  `not_claimed` state so a claim change is loud).
- Plan 154's Township audit report and this one should converge on shared HTML helpers
  if a third report appears; two hand-rolled templates are fine, three are not.
- Reviewer scrutiny: the honesty-sentence and claim-count assertions, and that the CLI
  writes nothing for unverifiable bundles.
