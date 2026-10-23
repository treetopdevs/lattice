# Plan 224: R11b `catalogued` and `listed` phases and the carrier service realm (design)

> **Executor instructions**: This is a design plan. It moves no code. Each build PR below is its own
> PR with one adversarial review; the PRs marked "second review" need a second independent review.
> Run every gate command. If anything in "STOP conditions" occurs, stop and report; do not improvise.
> Line numbers drift: grep the named function, not the number. Run mix as `~/.asdf/shims/mix`. The
> operator owner tests are Linux-only and skip on macOS; run them in Docker
> (`elixir:1.19.5-otp-28`, non-root, umask 022), from `apps/lattice_carrier_server` for any
> fresh-`mix` subprocess test.
>
> **Drift check (run first)**: `git log --oneline 1cebccd03..HEAD -- scripts/treehouse_operator_mutation.py
> apps/lattice_carrier_server/lib apps/lattice_core/lib/treehouse clients/lattice-client/src/treehouse_catalog_*.ts`.
> A new journal phase, owner plan kind, manifest field or catalog trust refusal since 1cebccd03 is a STOP.

## Status

Design written 2026-10-19 (slice 18) against main 1cebccd03. Row 224 stays BLOCKED (rule 8) until
the inputs in "Depends on" exist. PR 1 (Design 1) landed in PR #155; PR 3 (Design 3) landed in PR #158.
PR 2 (Design 2, OD-1 and OD-5 as decided in D-39) is built on branch `claude/backlog-slice-21-0c6e31`; PRs 4-5 wait on the ceremony report; PR 6 needs its own plan (row 245).

## Header

- **Priority**: P2. **Effort**: L (five PRs here, a sixth planned separately). **Risk**: HIGH. It extends the reviewed journal
  contract, adds a catalog signing step and an operator write into a served log, and adds a
  carrier route path. A wrong `catalogued` record would advertise a route the operator never proved.
- **Depends on** (rule 8, exact operator inputs):
  1. The operator's real ceremony directory after runbook §5.6: `verification-report.json` with
     `mode: "real"` and `binding.status: "verified"`, `signer.json`, `binding-payload.json`,
     `binding-review.txt` and `binding.json` (`docs/treehouse_catalog_signer_custody.md` §5.4-§5.6).
  2. The signed `catalog_bootstrap_v1` present and honored in the carrier's served Space log.
  3. The carrier service identity file whose public key was given to `binding-payload` as
     `--service-public-key` (OD-1), on the carrier host.
  4. Operator decisions OD-1 to OD-5 below (rows 239-243).
  5. Plan 223 `ready` (row 223, DONE).
- **Category**: carrier lifecycle (roadmap R11b; D1: activation is local-only). **Planned at**: 1cebccd03

## Sources this plan follows, and what it supersedes

- The reviewed contract, `docs/research/treehouse_catalog_lifecycle.md` §2 ("Root bootstrap",
  "Signed catalog snapshot") and §5 (journal table), is authoritative. §5 defines `catalogued` as
  "sign and durably publish the next catalog after readiness" and `listed` as "recheck current
  reviewed membership/authority/attempt, then publish the original staged signed Space reference".
- Plan 223's parked sketch said `listed` "records that the signed catalog is served to retained
  clients". That contradicts §5 and the code: a client accepts a Thread entry only when its
  `create_thread` reference is present and honored in the Space log (`catalog_entries.ex:124-135`).
  This plan follows §5 and replaces the sketch (plan 223 now points here).
- §5 says `ready` authenticates "each intended route with pinned realm/service key". Row 223's D-22
  probe pins the admitted instance's realm and key (`release_readiness.ex:177`), but that realm is a
  free manifest string (`manifest.ex:175`), so `ready` is self-referential until Design 2 binds it.

## Current state (verified 2026-10-19)

- Journal record keys are exact: `version, phase, attempt, generation, catalog_head,
  manifest_digest, artifacts, service` (`journal.ex:184-195`); phases `carrier_pending, activated,
  ready` (`journal.ex:186`; Python `PHASES`, `treehouse_operator_mutation.py:26`). Artifact kinds are
  `log`, `reference`, `manifest` (`journal.ex:240-252`). `generation` and `catalog_head` are copied
  from the staging request as reviewed intent (`staging.ex:64-65`, `journal.ex:13`).
- `commit(root, old, raw, activation=False, ready=False)` (`mutation.py:338`) gates which plan may
  write which phase and appends the replaced bytes to history first (`history()`, `:307`).
- A staged `reference` artifact is the member-signed, unpublished `create_thread` op (`staging.ex:225-240`).
- No carrier code serves or stores a catalog; no manifest field names a route. Each instance listens
  on its own port at the single path `/carrier` (`listener.ex:34-43`).
- `TransportCatalog` has the closed envelope: `catalog_bytes/1` (`:128`), `catalog_id/1` (`:136`),
  `verify_catalog/2` (`:112`, shape and signature only), `verify_catalog_json/2` (`:85`),
  `service_realm/1` (`:149`). Entries: 1-13, exactly one Space entry, unique routes, one
  `{service_id, service_key}` (`:196-201`). Origin is `wss://` DNS only (`:248-262`).
- `CatalogEntries.observe/2` (`catalog_entries.ex:26`) checks each entry against supplied histories:
  bounded family, binding service id/key, genesis and creation honored, and for a Thread the
  `create_thread` reference honored in the Space log. A missing item is `:trust_pending` (`:143`).
- `CatalogTrust.prepare_installation/1` (`catalog_trust.ex:116`), `evaluate/1` (`:145`) and
  `resolve_route/1` (`:239`) are pure, candidate-only evaluators with TS twins; TS derives the route
  realm with `catalogServiceRealm` (`treehouse_catalog_codec.ts:204`). No shell code calls them.
- `CatalogBootstrap.observe/1` (`catalog_bootstrap.ex:13-27`) returns every honored bootstrap; it
  does not choose one. The ceremony's `verify-binding` requires exactly one honored root-authored
  record equal to the reviewed payload (`catalog_ceremony/binding.ex:315-333`) and checks the pin is
  unchanged (`:203-214`).
- `verification-report.json` is unsigned JSON (`report.ex:26-40`); its binding block carries only
  `bootstrap_id`, `record_sha256`, `space` (`report.ex:111-139`). The binding's `service_key` is an
  operator input to `binding-payload` (`cli.ex:34`); the ceremony generates no service key. The
  ceremony's `Store.read/2` is an unbounded `File.read` plus generic JSON decode (`store.ex:83`), and
  `verify-binding` dedups honored bootstraps by record, not op id (`binding.ex:319`).
- Staging keeps the service key out of the roster and the child root (`staging.ex:340-345`), pins
  `trusted_peers` to `{child root} ∪ roster` (`staging.ex:405-414`), requires the admitted child's
  `relay_realms == []` (`staging.ex:347`), and refuses a candidate whose child is already served
  (`unserved/2`, `staging.ex:96`). Readiness compares the loaded manifest with the record's
  **manifest artifact** `sha256` (`release_readiness.ex:37`), not `manifest_digest`.
- The evaluators keep each listed entry's `root, genesis, creation, reference, kind, schema` immutable
  across revisions (`catalog_trust.ex:1985-1996`).

## Design 1: ceremony ingress (`Operator.CatalogBinding`)

One read-only function, `CatalogBinding.load(ceremony_dir, space_log)`, used by PRs 2, 4 and 5. The
ceremony directory copied to the carrier host holds public files only; the seed never travels with
it. Checks, in order; every failure is an atom, and nothing is trusted from the report:

1. Read `binding-payload.json`, `binding-review.txt`, `binding.json`, `signer.json` and
   `verification-report.json` with new bounded readers: a size cap per file, regular single-link
   file, closed key sets, duplicate keys refused, review sheet read as bounded UTF-8 text and compared
   field by field with the payload. `ceremony_artifact_missing` / `ceremony_artifact_malformed`.
2. `Store.undisposable` on `catalog_key`, `service_key` and `space_root`: `disposable_test_key`.
3. The served Space log is read with `Log.restore_verified/1` of the Space instance's `log_file`
   under its target lock, never `Holder.restore_path/1` (which deletes temp files). Require
   `log.replica == record.space` and the bounded profile unchanged (reuse `profile_unchanged/2`,
   `binding.ex:203-214`): `binding_profile_changed`.
4. Exactly one honored, root-authored `catalog_bootstrap_v1` **op id** in the served log; its
   normalized record equals the payload record and its id equals `binding.json`'s `bootstrap_id`.
   Zero is `binding_not_in_served_log`; two op ids, even with equal records, is `binding_fork`
   (contract §2: never chosen by arrival order). The ceremony's `verify-binding` adopts the same
   op-id rule; one shared public function replaces `honored/2`.
5. `catalog_key == signer.json` public key; `catalog_key`, `service_key`, `space_root` pairwise
   distinct (`binding_key_reuse`; `normalize_bootstrap` checks only the first pair, `transport_catalog.ex:21`).
6. Cross-check only: report `signer.public_key_base64`, `binding.bootstrap_id`,
   `binding.record_sha256`, `binding.space` equal the re-derived values, `mode == "real"`,
   `binding.status == "verified"`, else `catalog_report_mismatch`. Custody names, `separate_host`
   and backup digest are carried as attested, unverified text; so is the root-signed `origin` (R21a).
7. Return `%{bootstrap_id, record, realm: TransportCatalog.service_realm(record.service_id)}`.

## Design 2: the carrier service realm, routes and relay

The realm `"treehouse-service:" <> service_id` is the **server's** realm, the one it proves in its
hello (`web_socket.ex:130`) and that clients pin (`carrier.ts:651-684`; BEAM client
`expected_realm`/`expected_pubkey`). It is never a client realm and never a `trusted_peers` key. No
handshake, wire or session code changes: both clients treat the realm as an opaque expected string
(`apps/lattice_core/lib/lattice/carrier/session.ex:147-150`).

- **Who may connect.** Unchanged: members in `trusted_peers` under their own realms; the D-22 probe
  only through a live single-use grant. `bootstrap_peers_exact?/3` is unchanged.
- **What it serves.** The same `frontier`, `pull`, `relay` (only where `relay_realms` allows),
  `subscribe`, `state`. No catalog message (OD-4).
- **Routes.** A Treehouse instance gains a manifest field `route`, `"/r/<43-char id>"` (the catalog's
  route shape, `transport_catalog.ex:245`). The listener dispatches that path to the same handler as
  `/carrier`, with the same `trusted_peers` gate. The public `wss://origin` to port mapping is
  deployment (R21a); the catalog claims only what this host serves.
- **Binding is mandatory after PR 2.** Staging, activation and `confirm/3` take the ceremony
  directory as an argument and call `CatalogBinding.load/2`. For **every** Treehouse instance in the
  candidate (Space and each child; contract §2 "all that product's replica listeners"): `realm ==
  binding realm`, `pub == service_key`, a unique `route`, and no `trusted_peers` realm equal to the
  service realm (refused in staging, never in `web_socket.ex`). Refusal: `:service_binding_mismatch`.
  Activation (`release_activation.ex:104`) and readiness re-derive the realm from the binding rather
  than trusting the record.
- **Migration.** One staging may move every active Treehouse instance's `realm`, `route`,
  `relay_realms` and `identity_file`/`pub` to the bound and reviewed values, with the existing
  identity-file custody checks; nothing else changes (today any active-instance change refuses). A realm change breaks hand-pinned `RelayRoute`s for the old realm
  (dev-trace fixtures only); each instance's `trusted_peers` moves to `{its root} ∪ current roster`.
- **Relay (OD-5).** Contract C07 (`lifecycle.md:561`) forbids cataloguing a read-only relay. Staging
  today requires the child's `relay_realms == []` as "a separate reviewed decision". Recommended: the
  staging request carries that reviewed decision, and staging requires each catalogued instance's
  `relay_realms` to equal exactly the realms of its current roster members (plus the child root for
  its own Thread). The operator holds no member key (D-20), so a live authenticated write is proven
  only by the packaged gate in PR 6; the operator proof is configuration plus the read probe.
- **Readiness covers every route.** `confirm/3` runs the D-22 probe over each Treehouse instance's
  `route` path (one grant at a time; Space and every child), pinning realm and key and requiring the
  pulled replica, root and genesis to match the instance's log. The roster check becomes one shared
  function taking the window atom.
- **Service key custody (OD-1).** Recommended: the existing instance identity file, shared by every
  Treehouse instance (`release_readiness.ex:93` already allows shared keys). It must exist on the
  carrier host before `binding-payload`, because the root signs its public key permanently and R11c
  rotation is not built. Its file and backup become binding-critical; the runbook names their custody.
- **D1 holds.** The realm is checked locally against a root-signed record; nothing is remote.

## Design 3: journal records and the catalog store

Phases become `carrier_pending, activated, ready, catalogued, listed` in both validators. The owner
allows only `ready → catalogued → listed`. `commit()` replaces its two booleans with one
`writes=<phase or None>` argument; only the matching plan writes that phase, and a `journal` plan
still cannot create or advance one. Every manifest comparison below uses the manifest artifact's
`sha256`, as readiness does.

**No new top-level key** (`valid?/1` demands the exact key set). One new artifact kind, `catalog`:
`replica` = the Space, `op_id` = `catalog_id`, `review` nil, `path`, `sha256` of the envelope JSON
bytes. Exactly one is required in `catalogued` and `listed` and forbidden before; in those phases
`catalog_head` equals its `op_id`.

**Catalog store.** `catalog/` under the operator root, reserved in Python `reserved_files` and the
BEAM collision checks (`runtime.ex:129`). The owner derives `catalog/<sha256>.json` itself (a plan
never supplies a path), writes a temp file in `catalog/` with mode 0600, fsyncs it, links it to the
final name without overwriting (`os.link`; an existing name with equal bytes is a no-op, other bytes
`immutable_artifact_conflict`), unlinks the temp and fsyncs the directory. Leftover temps are ignored
by readers and removed under the lock. No envelope is ever deleted.

**Store tip and receipts.** The BEAM verifies every envelope with the binding key and walks
`previous`: one chain from revision 0 with no gaps. A second envelope with the same `previous` is
`catalog_fork`; a gap or unverifiable file is `catalog_store_corrupt`. Every `catalog` artifact in the
current record and in every history line must be present with its `sha256`, and the tip's revision
may not be lower than any of them: else `catalog_store_corrupt` (catches tail deletion). The
**committed head** is the highest-revision catalog artifact in journal or history. At most one store
envelope may lie past it: a **pending** envelope whose `previous` is the committed head. Anything
further is `catalog_fork`.

**Boot and stage.** Boot treats `catalogued`/`listed` like `ready`; whenever any record or history
line holds a receipt, the BEAM verifies store and receipts before routes start (`catalog_store_corrupt`).
Stage may replace any phase (history keeps it); the request's `catalog_head` must equal the committed head and no pending
envelope may exist, else `stale_catalog_head`.

## Design 4: `catalogued`

**Signing location is OD-2.** Recommended (b): the carrier host never holds the seed.

- (a) `ReleaseCatalog.publish(root, expected, ceremony_dir, probe_file, signer_file)` reads the seed
  with `Signer.read_seed` plus the `Paths.signer` ancestor checks, requires its public key to equal
  the root-signed `record.catalog_key` (`signer_key_mismatch`), wraps it in `Secret` and signs inside
  the call. This is the slice 13 sketch; it puts the signer on the network-facing host.
- (b) `ReleaseCatalog.prepare(root, expected, ceremony_dir, probe_file)` runs the checks below and
  writes `catalog-unsigned.json` (canonical `C` and `sha256` of `catalog_bytes(C)`). The custodian
  runs a new ceremony command `sign-catalog`. It keeps a custodian-side record of the last signed
  revision, id and envelope bytes (envelope written and fsynced before the record advances). It
  replays that envelope byte for byte for the same `C`, and refuses anything else that is not the
  next revision with `previous` equal to it. The package carries the staged reference frame; it
  re-runs `CatalogEntries.observe/2` over the custodian's Space and Thread exports plus that frame,
  as the carrier's step 6 does;
  it prints a review sheet with the binding id and, per new entry, replica, root, route and
  reference; then it signs. `ReleaseCatalog.commit(root, expected, ceremony_dir, probe_file,
  envelope_file)` re-runs every check, requires `envelope.catalog == C` exactly, and verifies the
  signature with the binding `catalog_key`.

BEAM checks (atom-only refusals; every raise rescued as in `confirm/3`):

1. Guarded boot (`:release_boot_unguarded`); journal equals `expected` and is `ready`
   (`:stale_operator_intent`); loaded manifest equals the manifest artifact
   (`:release_manifest_mismatch`); `Health.ready?/0` (`:route_not_ready`).
2. `CatalogBinding.load/2`; the record's `service.realm`/`service.pub` equal the binding
   (`:service_binding_mismatch`); every instance's `relay_realms` is the reviewed set (`:route_read_only`);
   the shared roster check over the served Space log still equals the staged roster and every
   instance's admissions (`:roster_drift_since_ready`).
3. The probe over every route, including the new Space route (Design 2; `:readiness_pull_failed`).
4. Store state (Design 3). A pending envelope (crash recovery) still goes through steps 5-6.
   The committed head equals `record.catalog_head` (`:stale_catalog_head`); revision and
   `previous` follow it (revision 0 and `nil` for the first); `binding` = `bootstrap_id`.
5. Entries = the head's entries carried forward unchanged, plus this attempt's Thread entry (replica,
   root, genesis, creation from the staged child log; `reference` = the staged reference op id;
   `route` from the admitted instance). The first catalog also holds the Space entry: genesis,
   `create_space` op and route of the Space instance, `reference` = `bootstrap_id`. Refuse
   `:catalog_route_reused` if the route or replica appears in any stored revision for another
   replica, and `:catalog_capacity` past 13 entries.
6. Self-check: `CatalogEntries.observe/2` over the served log of **every** entry's instance, with
   the staged reference frame added to the Space log as a hypothetical, returns `{:ok, _}`; else
   `:catalog_invalid`. The staged reference must also be honored in that hypothetical (`Authority.analyze`).
7. Commit only: the signature verifies (`:catalog_signature_invalid`). A pending envelope is accepted
   only if its `C` equals the one rebuilt in steps 4-6; else `:catalog_fork`.

Owner plan `catalogued`: `expected` = ready bytes; `record` = `dict(old, phase="catalogued",
catalog_head=id, artifacts=old + [catalog artifact])`; `attempt`, `incarnation` (boot marker),
`checks` = active manifest; `artifacts` = one `{sha256, bytes}`. Owner refusals:
`malformed_operator_plan`; `stale_operator_intent` (old phase not `ready`, attempt differs, record is
not the derived one, bytes digest differs, manifest digest differs); `stale_operator_incarnation`;
`unsafe_operator_file`; `immutable_artifact_conflict`. The owner cannot verify Ed25519; it binds
bytes to digest and trusts the BEAM for the signature. Like `ready`, `catalogued` is an observation at
the checked frontiers; a later roster or authority change is caught by `listed`'s in-holder guard.

## Design 5: `listed`

`ReleaseListing.publish(root, expected, ceremony_dir)`:

1. As `catalogued` step 1, with phase `catalogued`; `CatalogBinding.load/2` again.
2. The stored envelope's digest equals the artifact, it verifies, its id equals `catalog_head` and
   the committed head (`:stale_catalog_head`), and its new Thread entry's `reference` equals the
   staged reference op id (`:catalog_reference_mismatch`).
3. Courier (OD-3 a), one call into the Space holder: `Holder.courier(holder, frame, guard)`. The frame
   is the journal's `reference` artifact bytes, re-hashed against its `op_id` and `sha256`; callers
   pass no other bytes. Inside the holder call, so no relay interleaves, `guard` runs on the
   holder's current log: the roster equals the staged grant recipients (`:roster_drift_since_catalog`)
   and `Authority.analyze(Space, log + frame)` honors the frame (`:reference_not_honored`). Only then
   is the frame delivered and durably persisted before acknowledgement. An already present frame
   skips delivery but still passes the guard. `courier/3` is not reachable from `web_socket.ex` or
   `relay_realms`, and ignores the instance's relay setting.
4. `CatalogEntries.observe/2` over the served logs of every entry, with no hypothetical frames,
   returns `{:ok, _}`: `:catalog_invalid`. This is the client's own acceptance test. `listed`, like
   `ready`, is a dated observation at that frontier: a concurrent op that arrives later and
   quarantines the reference makes the entry pending again on clients, which judge their own logs.

Owner plan `listed`: same shape as `ready`, `record = dict(old, phase="listed")`, artifacts null;
refusals as for `ready` with old phase `catalogued`. The record is the local receipt (§5).

**Crash windows.** (i) Envelope linked, journal still `ready`: retry finds it pending (Design 3),
rebuilds `C`, and commits it; under (a) Ed25519 is deterministic (RFC 8032), so bytes are equal.
(ii) Journal replaced, reply lost: the caller re-reads the journal; `catalogued`/`listed` with the
same catalog id is done; any other input refuses `stale_operator_intent`. (iii) Frame delivered,
journal still `catalogued`: step 3 finds it present and passing the guard, and writes `listed`.

**A reference that lapses before `listed`** refuses `:reference_not_honored` and leaves its entry
pending (no route is granted, §5). The contract's "superseding attempt with a new reference" conflicts
with the evaluators' immutable entries (`catalog_trust.ex:1985-1996`) and with staging's
`unserved/2`. It is not built here; row 244 holds the design question. The entry keeps its slot.

## Design 6: what a client must do to accept a `listed` route

The pure evaluators implement acceptance; delivery, protected custody and the shell are missing.
PR 6 gets its own plan (row 245) before any build. That plan must meet these requirements:

1. **Pin from review, never from the page.** First install runs `prepare_installation` from the
   root's own signed bootstrap (row 232). Member first install waits on R13's invitation.
2. **Evidence page** (OD-4): the whole envelope chain from revision 0 (at most 13 entries per
   envelope, ≤128 KiB each) plus each entry's Thread frames. Signed frames are self-authenticating,
   so delivery is untrusted. The page only bootstraps: before acceptance the client pulls the Space
   log and every entry's Thread log over the pinned routes at their current frontiers and re-runs
   observation on those, because a withheld revoke or beacon would make a lapsed op look honored.
3. **Accept** only `reason == nil` with the accepted catalog id equal to the head being installed:
   `finish` keeps earlier accepted routes on `:trust_pending` (`catalog_trust.ex:264-310`).
4. **Protected owner.** Commit through the native trusted service of
   `docs/research/treehouse_catalog_retained_trust.md` (`commitCatalogTrust`, about line 383): it
   verifies against its retained pin and generations, serializes and returns a receipt. No IPC call
   may promote caller-supplied state; `catalog_store.rs` is candidate-only (`:1-4`) and refuses a
   first store beside an existing identity (`:97-99`), so the ordering must be designed.
5. **Grammar.** The shell route validators accept only legacy Thread replicas
   (`treehouse_routes.ts:32`; `preview.rs:257`); catalog entries are bounded Threads
   (`catalog_entries.ex:79`). Add bounded Thread grammar with TS/Rust parity, keeping plan 186's
   shell-owned product predicates.
6. **Connect and refuse.** Use `route.url`, `route.realm`, `route.service_key` as expected peer realm
   and key; drop the route if pulled replica, root or genesis differ. Never fall back to a hand-typed
   route; refuse a catalog route that differs from a saved `RelayRoute` until row 198's D3 exists. A
   loopback `ws://` origin only in the disposable test profile (contract §2). No freshness claim:
   a withheld newer catalog is undetectable, and an older one never displaces the retained head.

## Operator decisions (rows 239-243; decided 2026-10-19 as recommended, D-39)

- **OD-1 (row 239) Service key.** (A) the existing carrier instance identity file, shared by all
  Treehouse instances; (B) a separately minted key. **Recommend A**: it already signs
  `carrier_hello` and is kept apart from root, members and child roots; B adds custody and no
  boundary. Either way it exists before `binding-payload` and becomes binding-critical.
- **OD-2 (row 240) Where the catalog is signed.** (a) inside the carrier-host operator call; (b)
  prepare on the carrier host, sign on the custodian machine with `sign-catalog`, commit on the host.
  **Recommend b**: the signer never reaches the network-facing host and runbook §9 holds. It
  supersedes plan 223's slice 13 sketch.
- **OD-3 (row 241) How the staged reference reaches the served Space log.** (a) the guarded in-holder
  courier of Design 5; (b) the member who signed it relays it and `listed` only observes.
  **Recommend a**: it is §5's "retry submits the same content-addressed op", needs no app change and
  closes the roster race inside the holder. It is a server-side write path, so it lifts plan 223's
  auth STOP for this one frame. The binding is never couriered (input 2).
- **OD-4 (row 242) Catalog delivery to clients.** (a) an operator-exported evidence page file the
  root's app imports; (b) a new carrier read message (Wire vocabulary and `carrier.ts`, rule 3,
  lifts a plan 223 STOP); (c) a static file at the origin (R21a). **Recommend a**: no wire change,
  and the bytes are untrusted and fully verified.
- **OD-5 (row 243) Relay on catalogued routes.** (a) a reviewed staging decision sets each
  instance's `relay_realms` to exactly its current member realms plus its own child root (Design 2), required before `catalogued`; (b)
  catalogue read-only routes and waive C07. **Recommend a**: C07 is part of the reviewed contract.

## Build PRs (ordered; file sets disjoint)

| PR | Scope | Files (bare paths under `apps/lattice_carrier_server/lib/lattice_carrier_server/`; `test/` under `apps/lattice_carrier_server/`) | Needs | Review |
|---|---|---|---|---|
| 1 | Ingress | new `operator/catalog_binding.ex`; `operator/catalog_ceremony/{binding,store}.ex`; tests | — | one |
| 2 | Realm, routes, relay, probe per route | `manifest.ex`, `listener.ex`, `operator/{staging,release_activation,release_readiness}.ex`, `test/support/operator/fixture.ex`; tests | PR 1, OD-1, OD-5 | second (precedent) |
| 3 | Journal contract and store | `operator/{journal,lock}.ex`, `runtime.ex`, `scripts/treehouse_operator_mutation.py`, `test/operator/{mutation_protocol_test.py,journal_parity_test.exs}` | — | second (precedent: #126, #134) |
| 4 | `catalogued` | new `operator/release_catalog.ex`; under OD-2 (b) new `operator/catalog_ceremony/sign_catalog.ex`, `catalog_ceremony/cli.ex`; runbook | PRs 1-3, OD-2, report | second (signing custody) |
| 5 | `listed` | new `operator/release_listing.ex`; `holder.ex` (`courier/3`) | PR 4, OD-3 | second (server write path) |
| 6 | Client acceptance | its own plan (row 245) | PR 5, OD-4 | **rule 3** (`src-tauri` custody) |

PRs 1-5 touch no rule 3 path (`authority*`, `canonical.ex`, `lattice/carrier/`,
`clients/lattice-client/src/{authority,codec,carrier}.ts`, `src-tauri` custody, `.github/workflows`).
"Precedent" second reviews follow plan 223 and PRs #126/#134 for changes to the reviewed operator
contract; they are not rule 3.

### Gates

- PR 1: `mix test apps/lattice_carrier_server/test/operator/catalog_binding_test.exs` and
  `catalog_ceremony_test.exs` (macOS and Docker): one test per refusal in Design 1, two honored
  bootstraps with equal records and different deps (`binding_fork`), an oversized or duplicate-key
  file, a review sheet differing from the payload, a report edited after `report`, a dry-run key.
- PR 2: carrier-server suite in Docker; `route` shape and listener dispatch over a real loopback
  socket; staging refusals for wrong realm, wrong pub, missing or duplicate route, a `trusted_peers`
  realm equal to the service realm, an unbound Space instance and unreviewed relay realms; the probe
  over the Space and child route paths, with a wrong-replica negative; activation refuses a realm
  edited after staging; migrated `trusted_peers` = root plus current roster.
- PR 3: `python3 apps/lattice_carrier_server/test/operator/mutation_protocol_test.py` and the parity
  table on both sides (each phase, missing or extra `catalog` artifact, head not equal to artifact);
  owner refuses a plan-supplied store path, a store collision, and a `journal` plan writing either
  phase; a killed temp write leaves the store readable; a deleted tail envelope and a second
  envelope on one `previous` are refused.
- PR 4: `release_catalog_test.exs` (Linux owner): stage, seal, activate, restart, confirm, catalog;
  one test per refusal leaving journal, history and store unchanged; revision 1 carries revision 0's
  entries and observes both Threads; crash window (i); a member removed after `ready` refuses;
  under (b) `sign-catalog` refuses an older revision or a branch and replays a lost envelope exactly.
- PR 5: `release_listing_test.exs`: listed after courier; a concurrent beacon lapsing the reference
  and a member removal racing the courier both refuse with the log unchanged; a frame id differing
  from the artifact refuses; a network peer cannot reach `courier/3`; crash windows (ii) and (iii);
  `CatalogTrust.evaluate` over the served logs accepts the route with `reason: nil`.
- Each PR: hosted `mix test` green on the exact tip (rule 2); evidence tier core unit.

## Done criteria (row 224)

- [ ] PRs 1-5 merged on green exact tips; the operator's own run records `catalogued` then `listed`
      on the pilot host from the real ceremony inputs (the build PRs prove it on fixtures only).
- [ ] Every refusal named in Designs 1-5 has a test, and every BEAM refusal leaves journal, history
      and store unchanged.
- [ ] Row 224 updated (one line); R11b is DONE only after the operator run; rows 244-245 may move on.

## STOP conditions

- Any change under a rule 3 path in PRs 1-5, under `web_socket.ex` authentication (`peer_key/2`),
  or to the Wire vocabulary.
- The binding is absent from the served Space log, or two honored bootstrap op ids exist: stop for
  the operator; never pick one.
- `CatalogEntries.observe/2` cannot verify a catalog the design builds, or a superseding reference is
  needed (row 244): evaluator changes are R11c or core work, not this plan.
- The service key equals any member, root, child root or probe key.
- A third review round on the same finding class (rule 3): operator design question.
- Any need to put the signer seed in a plan, journal, manifest, log, telemetry or the catalog store.

**Non-goals:** R11c replacement and rotation; members' first install (R13); public WSS and the
origin-to-port mapping (R21a); server push; history retention (row 225); production or field claims.
