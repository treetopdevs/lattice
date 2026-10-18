# Plan 223: R11b `ready`, `catalogued` and `listed` phases (design)

> **Executor instructions**: This is a design plan. It decides the `ready` phase and parks `catalogued`
> and `listed`; it moves no code. The `ready` slice is executed as its own PR with its own adversarial
> review and, because it changes the reviewed journal contract in both validators, a second review as
> PRs #126 and #134 had. Run every verification command. If anything in "STOP conditions" occurs, stop
> and report; do not improvise. Line numbers drift: grep the named function, not the number. Run mix as
> `~/.asdf/shims/mix`. The operator owner tests are Linux-only and skip on macOS; run them in Docker
> (`elixir:1.19.5-otp-28`, non-root, umask 022).
>
> **Drift check (run first)**: `git log --oneline -- scripts/treehouse_operator_mutation.py
> apps/lattice_carrier_server/lib/lattice_carrier_server/operator apps/lattice_carrier_server/lib/lattice_carrier_server/runtime.ex
> apps/lattice_carrier_server/lib/lattice_carrier_server/health.ex`, then re-read "Current state" against
> the live files. A new journal phase, a new owner plan kind, or a change to `Health.ready?/0` since
> 2026-10-18 is a STOP condition until this plan is refreshed.

## Status

Design written 2026-10-18 (slice 8). `ready` is index row 223 (TODO). `catalogued` and `listed` are row
224, BLOCKED on absent operator inputs (rule 8). No R11c plan is written; see "Parked phases".

## Header

- **Priority**: P2
- **Effort**: M (one PR for `ready`)
- **Risk**: MEDIUM. It adds a phase to the reviewed journal contract and a new owner plan kind. A wrong
  `ready` record would assert a served route the operator never proved.
- **Depends on**: row 217 (activation roster re-review, landed in slice 8); rows 216, 218 and 219 landed
- **Category**: carrier lifecycle (roadmap R11b, operator decision D1: route activation is local-only)
- **Planned at**: 2026-10-18, against the tree named by the drift-check paths above

## Current state

The journal record (`Operator.Journal`, `scripts/treehouse_operator_mutation.py` `record()`) has two
phases: `carrier_pending` (staged by the owner's `stage` plan) and `activated` (written only by the
owner's `activate` plan or by the `boot` plan's lost-commit reconcile). A controlled boot under
`LATTICE_CARRIER_OPERATOR_ROOT` runs the owner's `boot` plan after loading the manifest and before any
route starts; it checks that the loaded bytes are the active bytes and writes a fresh
`operator-incarnation` marker. `ReleaseActivation` moduledoc: activation "is neither readiness, catalog
publication nor catalog replacement", and the new route set is served only after a full restart.
Nothing records that the restarted carrier actually serves the activated route.

### What slice 8 changed (rows 217-219)

- **Row 217.** `ReleaseActivation` re-reviews the Space roster from the sealed, verified Space log. It
  refuses `{:error, :roster_drift_since_staging}` unless the staged child log artifact's sorted review
  grant recipients equal the current sorted roster, and the candidate's admitted instance
  `trusted_peers` equal `{child log root} ∪ roster`. No journal schema or Python change; the owner is
  never invoked on refusal.
- **Row 218.** Before any write that replaces an existing `operator-journal.json` (stage commit,
  journal-plan commit, activate commit, boot reconcile commit), the owner appends the exact replaced
  bytes plus `"\n"` to `operator-journal-history.jsonl` (O_APPEND, O_NOFOLLOW, mode 0600, regular
  single-link file owned by this uid, else `unsafe_operator_file`), fsyncs it and the root directory,
  then replaces the journal. A crash between append and replace leaves a duplicate of the current
  record at the tail; that is accepted. A torn earlier append is cut back to its last complete line
  before the next one, a failed write is cut back and refuses `operator_history_write_failed`, and
  activation and boot reconcile check the history file before their irreversible step. The file is reserved in Python `reserved_files` and in the BEAM
  `:operator_path_collision` check, and the owner refuses `operator_path_collision` for a candidate
  instance path or journal service identity that names an operator file by path or inode. Growth is unbounded (row 225).
- **Row 219.** Activation keeps the replaced manifest's permission bits: the owner fstats the active
  manifest, refuses `unsafe_operator_file` if `mode & 0o022 != 0`, and fchmods the candidate temp to
  `old mode & 0o777` (never setuid, setgid or sticky) before `os.replace`.

## Design: the `ready` phase

### Meaning

A `ready` record says: after a full restart under an operator-root controlled boot, this incarnation
loaded exactly the activated candidate, every route holder is ready, the Space roster still matches
what was staged, and the admitted child route answered an authenticated frontier pull over its real
loopback listener. It says nothing about catalog publication, clients, or any host other than this one.

### Who invokes it

The operator invokes `ReleaseReadiness.confirm/3` (new module beside `ReleaseActivation`) after the
controlled boot. It is not run automatically at boot: holders may still be loading, and no phase in
this lifecycle advances without an explicit operator act. An automatic boot-time step was considered
and rejected because a slow holder would turn a correct boot into a refused one.

### BEAM checks, in order (`ReleaseReadiness.confirm/3`)

1. The deployment was booted with an operator root and holds an incarnation marker; else
   `{:error, :release_boot_unguarded}` (same atom as activation).
2. The journal record read under `Journal.read/1` is `activated`; any other phase is
   `{:error, :stale_operator_intent}`. Its manifest artifact `sha256` must equal the loaded manifest
   digest of this deployment, else `{:error, :release_manifest_mismatch}`.
3. `Health.ready?/0` (every instance: holder, listener, identity, storage) is true, else
   `{:error, :route_not_ready}`. Reuse the existing probe; do not add a second readiness definition.
4. Roster re-review, as row 217 but against the now-served Space log: the Space instance's holder log,
   verified as activation verifies the sealed log. The staged child artifact's sorted grant recipients
   must equal the current sorted roster, and the loaded admitted instance's `trusted_peers` must equal
   `{child log root} ∪ roster`. Refusal: `{:error, :roster_drift_since_activation}`. A distinct atom
   from row 217's, so evidence shows which window the drift fell in. The check is repeated because a
   member can be added or removed between activation and restart.
5. Authenticated frontier pull of the admitted child route through its loopback listener with the real
   carrier client (not an in-process `Holder` call, which would duplicate step 3). The probe identity is
   one the operator names by file; its public key must be in the admitted instance's `trusted_peers`,
   else `{:error, :readiness_probe_untrusted}`. The BEAM reads the seed for the one session and never
   persists or logs it. The returned frontier must equal the holder's `Log.frontier/1` for that
   instance, else `{:error, :readiness_pull_failed}`; a connect, auth or decode failure is the same atom.
6. Only then does the BEAM send the owner a `ready` plan. The owner is never invoked on a refusal above.

### Owner plan `ready` (Python)

Closed plan shape, same top-level keys as today. `kind: "ready"`, `expected` = the current `activated`
journal bytes, `record` = the same record with phase `ready`, `attempt` = its attempt, `incarnation` =
the boot marker, `checks` = exactly one `{path, sha256}` for the active manifest, `artifacts: null`.
Under the lock the owner refuses:

- `malformed_operator_plan`: any shape deviation, as for `activate`.
- `stale_operator_intent`: expected is not the current journal, old phase is not `activated`, attempt
  differs, `record != dict(old, phase="ready")`, or the active manifest digest differs from the plan's
  check or from the record's manifest artifact `sha256`.
- `stale_operator_incarnation`: the marker file differs from `plan["incarnation"]`. A later restart
  wrote a new marker, so readiness observed by an older incarnation cannot be recorded.
- `unsafe_operator_file`: the manifest path is reserved, or a file check fails.

It then commits through `commit(..., ready=True)`, which takes the row 218 history append because it
replaces an existing journal. `commit()` today lets only `activation=True` write `activated`; it gains
a parallel allowance so only the `ready` plan writes `ready`, and an ordinary `journal` plan still
cannot create or advance a phase.

### Validators (both sides)

- Python: `PHASES = ("carrier_pending", "activated", "ready")`; `commit()` phase gate as above.
- Elixir: `Journal.valid?/1` phase list gains `"ready"`; the moduledoc's "Neither phase claims a
  restarted, ready or published route" is rewritten to say `ready` claims only the local facts above.
- `boot`: a `ready` record whose manifest artifact digest is the present bytes boots normally (marker
  rewritten; the record stays `ready` because it describes the activated bytes, and a restart does not
  undo them). A `ready` record over any other present bytes refuses `stale_operator_intent`, as an
  `activated` one over its pre-activation bytes does. Whether a reboot should demote `ready` is
  deliberately not decided here: the record is a dated observation, not a live health signal.
- `stage`: the next attempt's staging may replace a `ready` record (history keeps it, row 218).

### Tests

- Python `mutation_protocol_test.py`: closed `ready` plan shapes; phase parsing for `ready`; journal
  plan cannot write `ready`; stale marker, wrong phase, wrong attempt and digest mismatch refusals; the
  history line equals the replaced `activated` bytes.
- Elixir `release_readiness_test.exs` (Linux-only owner, as the activation tests): full flow stage,
  seal, activate, restart, confirm, then the journal is `ready`; one test per BEAM refusal in steps 1-5,
  each asserting the owner was not invoked (journal and history bytes unchanged); a member added to the
  Space after activation and before restart refuses `:roster_drift_since_activation`; a restart after
  confirm with the same bytes boots and keeps `ready`.
- Validator parity: one table of record bytes (each phase, an unknown phase, a missing field) decoded
  by both `Journal.decode/1` and the Python `record()`, asserting the same accept or refuse. Behavioural
  only, no prose pins (rule 6).

### Claim boundary

Local only (D1). `ready` is one operator's observation on one host after one restart. It is not catalog
publication, not catalog replacement (R11c), not row 198's client saved-route replacement (D3), and not
a field, device, hosted-deployment or production claim. Evidence tier is core unit (rule 1); the owner
tests run on Linux only.

## Parked phases: `catalogued` and `listed` (row 224, rule 8)

Both need inputs that do not exist, named in the roadmap's R11a paragraph: (1) the catalog signer,
generated by the operator; (2) the living root's reviewed and signed product/replica/service bootstrap
binding; (3) a verified, encrypted, separate signer backup with named custody and rotation
responsibility. Disposable test identities cannot stand in for them on the real path.

Intended shape only: `catalogued` records a signed catalog entry bound to a `ready` record's
generation, `catalog_head` and manifest digest, signed by the catalog signer under the root's
bootstrap binding. `listed` records that the signed catalog is served to retained clients, which
verify it against their retained trust. Both remain local-only steps under D1 until the operator says
otherwise. A design plan is written when the three inputs exist.

R11c (catalog replacement trust) replaces a catalog that a client already retains, so it cannot start
until `catalogued` exists. No R11c plan is written now.

## Non-goals

- No automatic restart, no admission reopening, no server push.
- No history retention or rotation (row 225).
- No change to `Health.ready?/0` semantics or the `/health` endpoint.
- No catalog, signer, client or Tauri work.

## Done criteria (row 223)

- [ ] `ready` exists in both validators and only the `ready` owner plan can write it.
- [ ] Every refusal named above has a test, and each BEAM refusal leaves journal and history unchanged.
- [ ] The parity table passes on both sides.
- [ ] The carrier-server suite and `mutation_protocol_test.py` pass in Docker; hosted `mix test` is
      green on the exact tip (rule 2).
- [ ] Row 223 updated in one line; roadmap R11b stays IN PROGRESS until row 224 clears.

## STOP conditions

- The operator holds no key in the admitted instance's `trusted_peers` that it may use for the probe.
  Who authenticates the readiness pull then becomes an operator design question; report it, do not
  use the carrier service key or mint a peer.
- The probe needs a server-side change to authenticate (a new realm, an operator bypass).
- Row 217's roster check cannot be reused against a served log without changing activation.
- Any change is needed under `apps/lattice_core/lib/lattice/carrier/` or another rule 3 path.
