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
> A new journal phase, owner plan kind, manifest field or catalog trust refusal since 1cebccd03 is a
> STOP until this plan is refreshed.

## Status

Design written 2026-10-19 (slice 18) against main 1cebccd03. Row 224 stays BLOCKED (rule 8) until
the inputs in "Depends on" exist. PR 1 and PR 2 below need no ceremony output and may start once
operator decisions OD-1 and OD-3 are taken; PRs 3-6 wait on the ceremony report.

## Header

- **Priority**: P2. **Effort**: L (six PRs). **Risk**: HIGH. It extends the reviewed journal
  contract, adds the first operator call that holds a signing key for publication, and adds a
  carrier route path. A wrong `catalogued` record would advertise a route the operator never proved.
- **Depends on** (rule 8, exact operator inputs):
  1. The operator's real ceremony directory after runbook §5.6: `verification-report.json` with
     `mode: "real"` and `binding.status: "verified"`, `signer.json`, `binding-payload.json`,
     `binding-review.txt` and `binding.json` (`docs/treehouse_catalog_signer_custody.md` §5.4-§5.6).
  2. The signed `catalog_bootstrap_v1` present and honored in the carrier's served Space log.
  3. The carrier service identity file whose public key was given to `binding-payload` as
     `--service-public-key` (OD-1), on the carrier host.
  4. Operator decisions OD-1 to OD-4 below (rows 239-242).
  5. Plan 223 `ready` (row 223, DONE).
- **Category**: carrier lifecycle (roadmap R11b; operator decision D1: route activation is local-only)
- **Planned at**: 2026-10-19 against 1cebccd03

## Sources this plan follows, and what it supersedes

- The reviewed contract, `docs/research/treehouse_catalog_lifecycle.md` §2 ("Root bootstrap",
  "Signed catalog snapshot") and §5 (journal table), is authoritative. §5 defines `catalogued` as
  "sign and durably publish the next catalog after readiness" and `listed` as "recheck current
  reviewed membership/authority/attempt, then publish the original staged signed Space reference".
- Plan 223's parked sketch said `listed` "records that the signed catalog is served to retained
  clients". That contradicts §5 and the code: a client accepts a Thread entry only when its
  `create_thread` reference is present and honored in the Space log (`catalog_entries.ex:124-135`).
  This plan follows §5 and replaces the sketch (plan 223 now points here).
- §5 says `ready` authenticates "each intended route with pinned realm/service key". Row 223 built
  `ready` on the D-22 probe, whose client pins the server's realm and key from the admitted instance
  (`release_readiness.ex:177`). That realm is today a free manifest string (`manifest.ex:175`), so
  `ready` is self-referential until the realm is bound to the signed binding. PR 2 binds it; after
  PR 2 a `ready` record over a bound manifest meets §5 for the admitted route. `catalogued` refuses
  any `ready` record whose `service.realm`/`service.pub` differ from the binding.

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
  `resolve_route/1` (`:239`) are pure, candidate-only evaluators with TS twins
  (`treehouse_catalog_trust.ts`). TS derives the route realm with `catalogServiceRealm`
  (`treehouse_catalog_codec.ts:204`). Nothing in the Treehouse shell calls the evaluator.
- `CatalogBootstrap.observe/1` (`catalog_bootstrap.ex:13-27`) returns every honored bootstrap; it
  does not choose one. The ceremony's `verify-binding` requires exactly one honored root-authored
  record equal to the reviewed payload (`catalog_ceremony/binding.ex:315-333`) and checks the pin is
  unchanged (`:203-214`).
- `verification-report.json` is unsigned JSON (`report.ex:26-40`); its binding block carries only
  `bootstrap_id`, `record_sha256`, `space` (`report.ex:111-139`). The binding's `service_key` is an
  operator input to `binding-payload` (`cli.ex:34`); the ceremony generates no service key.
- Staging keeps the service key out of the roster and the child root (`staging.ex:340-345`) and
  pins `trusted_peers` to `{child root} ∪ roster` (`bootstrap_peers_exact?/3`, `staging.ex:405-414`).

## Design 1: ceremony ingress (`Operator.CatalogBinding`)

One read-only function, `CatalogBinding.load(ceremony_dir, space_log)`, used by PR 2, PR 4 and
PR 5. The ceremony directory copied to the carrier host holds public files only; the seed never
travels with it. Checks, in order (every failure is an atom; nothing is trusted from the report):

1. Read `binding-payload.json`, `binding-review.txt`, `binding.json`, `signer.json` and
   `verification-report.json` with the ceremony's closed readers (size-bounded, closed keys).
   Refuse `ceremony_artifact_missing` / `ceremony_artifact_malformed`.
2. `Store.undisposable` on `catalog_key`, `service_key` and `space_root`: `disposable_test_key`.
3. The served Space log is read with `Log.restore_verified/1` of the Space instance's `log_file`
   under its target lock, never `Holder.restore_path/1` (which deletes temp files). Require
   `log.replica == record.space` and the bounded continuation profile unchanged from the payload
   (reuse `profile_unchanged/2`): `binding_profile_changed`.
4. Exactly one distinct honored root-authored `catalog_bootstrap_v1` in the served log, and its
   normalized record equals the payload record and its id equals `binding.json`'s `bootstrap_id`.
   Zero is `binding_not_in_served_log`; two distinct records is `binding_fork` (contract §2: never
   chosen by arrival order). Extract the selection from `binding.ex:315-333` into one public
   function the ceremony and this module share.
5. `catalog_key == signer.json` public key; `catalog_key`, `service_key`, `space_root` pairwise
   distinct (`binding_key_reuse`; `normalize_bootstrap` checks only the first pair, `transport_catalog.ex:21`).
6. Cross-check only: report `signer.public_key_base64`, `binding.bootstrap_id`,
   `binding.record_sha256`, `binding.space` equal the re-derived values, `mode == "real"`,
   `binding.status == "verified"`: else `catalog_report_mismatch`. The report anchors nothing; its
   custody names, `separate_host` and backup digest are carried as attested, unverified text.
7. Return `%{bootstrap_id, record, realm: TransportCatalog.service_realm(record.service_id)}`.
   `origin` is the root-signed value and is reported as unverified (R21a owns the public origin).

## Design 2: the carrier service realm and routes

The realm `"treehouse-service:" <> service_id` is the **server's** realm, the one it proves in its
hello (`web_socket.ex:130`) and that clients pin (`carrier.ts:651-684`; BEAM client
`expected_realm`/`expected_pubkey`). It is never a client realm and never a `trusted_peers` key.
No handshake, wire or session code changes: both clients treat the realm as an opaque expected
string (`apps/lattice_core/lib/lattice/carrier/session.ex:147-150`).

- **Who may connect.** Unchanged. Members in `trusted_peers` under their own realms; the D-22 probe
  only through a live single-use grant (`probe_realm.ex`). `bootstrap_peers_exact?/3` is unchanged.
- **What it serves.** The same `frontier`, `pull`, `relay` (only where `relay_realms` allows),
  `subscribe`, `state`. No catalog message (OD-3).
- **Routes.** A Treehouse instance gains an optional manifest field `route`, `"/r/<43-char id>"`
  (the catalog's route shape, `transport_catalog.ex:245`). The listener dispatches that path to the
  same handler as `/carrier`. The public `wss://origin` to port mapping is deployment (R21a); the
  catalog claims only what this host serves locally.
- **Binding at staging (PR 2).** When the staging request names a ceremony directory, staging calls
  `CatalogBinding.load/2` and requires, for **every** Treehouse instance in the candidate (Space and
  each child, contract §2 "all that product's replica listeners"): `realm == binding realm`,
  `pub == service_key`, a `route`, routes unique, and no `trusted_peers` realm equal to the service
  realm (the refusal lives in staging, not in `web_socket.ex`). Refusal: `:service_binding_mismatch`.
  The active Space instance may change exactly its `realm` and `route` to the bound values in that
  one staging (today any active-instance change refuses); every other field stays unchanged.
- **Re-checks.** Activation (`release_activation.ex:104`) and readiness re-derive the realm from the
  binding instead of trusting the record: `:service_binding_mismatch`. The readiness probe dials the
  admitted instance's `route` path when it has one, so `ready` proves the catalogued path answers.
- **Service key custody (OD-1).** Recommended: the service key is the existing instance identity
  file, shared by every Treehouse instance (`release_readiness.ex:93` already allows shared
  service keys). It must exist on the carrier host before `binding-payload`, because the root signs
  its public key and it cannot be regenerated without a new binding.
- **D1 holds.** The realm is derived from a root-signed record and checked locally at staging,
  activation and readiness. Nothing is discovered, pushed or activated remotely.

## Design 3: journal records

Phases become `carrier_pending, activated, ready, catalogued, listed` in both validators. The owner
allows only `ready → catalogued → listed`. `commit()` replaces its two booleans with one
`writes=<phase or None>` argument; only the matching plan writes that phase, and a `journal` plan
still cannot create or advance one.

**No new top-level key** (`valid?/1` demands the exact key set). One new artifact kind, `catalog`:
`replica` = the Space, `op_id` = `catalog_id`, `review` nil, `path`, `sha256` of the envelope JSON
bytes. Exactly one is required in `catalogued` and `listed` and forbidden before. In those phases
`catalog_head` means the published head and must equal the `catalog` artifact's `op_id`.

**Catalog store.** A `catalog/` directory under the operator root, reserved in Python
`reserved_files` and the BEAM `:operator_path_collision` check. The owner writes each envelope as
`catalog/<sha256>.json` with `O_EXCL`, mode 0600, fsyncs file and directory, and never deletes one.
The owner derives the path itself; a plan never supplies it. This keeps every earlier revision after
stage replaces the record, so the chain and route reuse can be checked across all of them.

**Boot and stage.** Boot treats `catalogued` and `listed` like `ready`: present manifest bytes must
equal the record's manifest digest, else `stale_operator_intent`. Stage may replace any phase (history
keeps it), but the request's `catalog_head` must equal the catalog store's tip (below), else
`stale_catalog_head`.

**Store tip.** The BEAM verifies every envelope in `catalog/` with the binding key and walks
`previous`: exactly one chain from revision 0 with no gaps and no branches. A branch is
`catalog_fork`, a gap or unverifiable file `catalog_store_corrupt`. The tip is its last envelope; an
empty store has tip `nil`.

## Design 4: `catalogued`

**Signing location is OD-2.** Recommended (b): the carrier host never holds the seed.

- (a) `ReleaseCatalog.publish(root, expected, ceremony_dir, signer_file)` reads the seed with
  `Signer.read_seed` plus the `Paths.signer` ancestor checks, wraps it in `Secret`, and signs
  inside the call. This is the slice 13 sketch; it puts the signer on the network-facing host.
- (b) Two calls. `ReleaseCatalog.prepare(root, expected, ceremony_dir)` runs the checks below and
  writes `catalog-unsigned.json` (canonical catalog `C` and `sha256` of `catalog_bytes(C)`). The
  custodian runs a new ceremony command `sign-catalog`, which shows a review sheet, signs on the
  custodian machine and writes the envelope. `ReleaseCatalog.commit(root, expected, ceremony_dir,
  envelope_file)` re-runs every check, requires `envelope.catalog == C` byte for byte, then verifies
  the signature with the binding `catalog_key`.

BEAM checks (prepare and commit; atom-only refusals, every raise rescued as in `confirm/3`):

1. Guarded boot (`:release_boot_unguarded`); journal equals `expected` and is `ready`
   (`:stale_operator_intent`); loaded manifest digest equals the record (`:release_manifest_mismatch`);
   `Health.ready?/0` (`:route_not_ready`).
2. `CatalogBinding.load/2` (Design 1). The `ready` record's `service.realm` and `service.pub` equal
   the binding: `:service_binding_mismatch`.
3. Store tip equals `record.catalog_head`: `:stale_catalog_head`. Tip `nil` gives revision 0,
   `previous: nil`; else revision `tip.revision + 1`, `previous` = tip id, same `binding`
   (= `bootstrap_id` until R11c rotation exists).
4. Entries = the tip's entries (immutable, carried forward) plus this attempt's Thread entry: replica,
   root, genesis and creation from the staged child log, `reference` = the staged reference op id,
   `route` from the admitted instance. The Space entry (first catalog only) takes the Space log's
   genesis, `create_space` op and the Space instance route, `reference` = `bootstrap_id`. Refuse
   `:catalog_route_reused` if the route or replica appears in any stored revision for another
   replica, and `:catalog_capacity` past 13 entries.
5. Self-check: `CatalogEntries.observe(C, %{space => served Space log + staged reference frame,
   child => served child log})` returns `{:ok, _}`; any other result is `:catalog_invalid`. The
   staged frame is added only to this hypothetical; it proves the catalog is valid once listed.
6. Commit only: signature verifies (`:catalog_signature_invalid`); `catalog_id` is not already in
   the store under different bytes (`:catalog_fork`).

Owner plan `catalogued`: `expected` = ready bytes; `record` = `dict(old, phase="catalogued",
catalog_head=id, artifacts=old + [catalog artifact])`; `attempt`, `incarnation` (boot marker),
`checks` = active manifest; `artifacts` = one `{sha256, bytes}`. Owner refusals:
`malformed_operator_plan`; `stale_operator_intent` (old phase not `ready`, attempt differs, record is
not the derived one, bytes digest differs, manifest digest differs); `stale_operator_incarnation`;
`unsafe_operator_file`; `immutable_artifact_conflict` (store file exists with other bytes). The
owner cannot verify Ed25519; it binds bytes to digest and trusts the BEAM for the signature.

## Design 5: `listed`

`ReleaseListing.publish(root, expected, ceremony_dir)`. Checks:

1. As `catalogued` step 1, with phase `catalogued`.
2. `CatalogBinding.load/2` again; the stored catalog file's digest equals the artifact, it verifies,
   its id equals `catalog_head` and the store tip (`:stale_catalog_head`), and its new Thread entry's
   `reference` equals the staged reference op id (`:catalog_reference_mismatch`).
3. Roster re-review, as plan 223 step 4, against the served Space log:
   `:roster_drift_since_catalog`. The roster check in `release_readiness.ex` becomes one shared
   function taking the window atom.
4. Re-evaluate the staged reference against the complete current served Space log (contract §5:
   an unseen beacon or holder change can lapse it). If present: it must be honored, else
   `:reference_not_honored`. If absent: deliver it (OD-3), then re-read and require it present and
   honored. A refusal here needs a new superseding attempt with a new reference and catalog revision.
5. `CatalogEntries.observe(C, %{space => served Space log, child => served child log})` returns
   `{:ok, _}` with no hypothetical frames: `:catalog_invalid`. This is the client's own acceptance test.

Owner plan `listed`: same shape as `ready`, `record = dict(old, phase="listed")`, artifacts null;
refusals as for `ready` with old phase `catalogued`. The record is the local receipt (§5).

**Crash windows.** (i) Store file written, journal still `ready`: retry under (b) recomputes the same
`C`; the custodian's envelope is re-submitted, `retain` is a no-op on equal bytes. Under (a) Ed25519
signing is deterministic (RFC 8032), so the bytes are equal. (ii) Journal replaced, reply lost: the
caller re-reads the journal; `catalogued`/`listed` with the same catalog id is reported as done, and
the call refuses `stale_operator_intent` on any other input. (iii) Reference delivered, journal still
`catalogued`: step 4 finds it present and honored and writes `listed`. Never delete a store file or
log to retry.

## Design 6: what a client must do to accept a `listed` route

The pure evaluators already implement acceptance; the missing parts are delivery, custody and the
shell. A client accepts a route only when all hold:

1. **Pin from review, never from the page.** First install runs `prepare_installation` from the
   root's own signed bootstrap (the root's app holds it, row 232). Member first install waits on the
   R13 invitation carrying the pin. Refuse an unpinned or forked bootstrap (`catalog_fork`).
2. **Evidence page.** Catalog envelope (≤128 KiB, `@max_artifact_bytes`) plus each entry's Thread
   frames; signed frames are self-authenticating, so delivery is untrusted (OD-3). The Space log must
   come from an authenticated pull on the pinned Space route at its current frontier, not from the
   page, because a withheld revoke or beacon would make a lapsed reference look honored.
3. **Evaluate** with the retained token. Accept only `reason == nil` and an accepted catalog id equal
   to the head being installed: `finish` keeps the previous accepted routes on `:trust_pending`
   (`catalog_trust.ex:264-310`), so non-empty `routes` alone is not acceptance.
4. **Persist, then resolve on every launch.** The TS decision is WeakMap-held
   (`treehouse_catalog_trust.ts:361-381`); after restart, re-evaluate from the retained snapshot.
   `catalog_store.rs` refuses a first store when the native identity already exists
   (`trust_recovery_required`, `:97-99`); the build must define that ordering.
5. **Connect** with `route.url`, `route.realm`, `route.service_key` as the expected peer realm and
   key; then pull and drop the route if replica, root or genesis differ from the entry.
6. **Refused:** older or withheld catalogs never displace the retained head (no freshness claim);
   wrong scope `wrong_catalog_scope`; route reuse `invalid_catalog_transition`; missing or
   quarantined reference stays pending; a failed catalog route never falls back to a hand-typed
   route; a catalog route that differs from a saved `RelayRoute` for the same replica is refused
   until row 198's D3 replacement exists. A loopback `ws://` origin is allowed only in the disposable
   test profile (contract §2), never in a release build.

Out of scope: R11c replacement and rotation, members' first install, server push.

## Operator decisions (filed as rows 239-242; not decided here)

- **OD-1 (row 239) Service key.** (A) the existing carrier instance identity file, shared by all
  Treehouse instances; (B) a separate key minted by a new step. **Recommend A**: it already signs
  `carrier_hello` and is already kept apart from root, members and child roots; B adds custody and no
  boundary. Either way it must exist before `binding-payload` runs.
- **OD-2 (row 240) Where the catalog is signed.** (a) inside the carrier-host operator call; (b)
  prepare on the carrier host, sign on the custodian machine with a new ceremony `sign-catalog`
  command, commit on the carrier host. **Recommend b**: the signer never reaches the network-facing
  host, and the runbook's custody (§9) stays intact. It supersedes plan 223's slice 13 sketch.
- **OD-3 (row 241) How the staged reference reaches the served Space log at `listed`.** (a) an
  in-BEAM operator courier: under the owner lock, only the exact staged reference frame, only into
  the Space holder, through its existing structural delivery and durable acknowledgement, judged by
  Authority like any relay; (b) the member who signed it relays it, and `listed` only observes.
  **Recommend a**: it is what §5 describes ("retry submits the same content-addressed op") and
  needs no app change. It is a server-side write path, so it lifts plan 223's auth STOP for this
  one frame only. The binding is never couriered: it must already be in the served log (input 2).
- **OD-4 (row 242) Catalog delivery to clients.** (a) the operator exports an evidence page file
  (envelope plus Thread frames) that the root's app imports; (b) a new carrier read message
  (Wire vocabulary and `carrier.ts`, rule 3, lifts a plan 223 STOP); (c) a static file at the origin
  (R21a). **Recommend a** for row 224: no wire change, bytes are untrusted and fully verified.

## Build PRs (ordered; file sets disjoint)

| PR | Scope | Files | Needs | Review |
|---|---|---|---|---|
| 1 | Ingress | new `operator/catalog_binding.ex`; `operator/catalog_ceremony/binding.ex` (shared selection); tests | OD-1 | one |
| 2 | Service realm and routes | `manifest.ex`, `listener.ex`, `operator/staging.ex`, `operator/release_activation.ex`, `operator/release_readiness.ex`, `test/support/operator/fixture.ex`; tests | PR 1 | one |
| 3 | Journal contract | `operator/journal.ex`, `operator/lock.ex`, `scripts/treehouse_operator_mutation.py`, `apps/lattice_carrier_server/test/operator/mutation_protocol_test.py`, `journal_parity_test.exs` | none | second (precedent: PRs #126, #134) |
| 4 | `catalogued` | new `operator/release_catalog.ex`; under OD-2 (b) `catalog_ceremony/` sign command and `cli.ex`; runbook | PR 1-3, OD-2, ceremony report | second (signing custody) |
| 5 | `listed` | new `operator/release_listing.ex`; `holder.ex` courier entry (OD-3 a) | PR 4, OD-3 | second (server write path) |
| 6 | Client acceptance | `treehouse-tauri-shell/src` catalog adapter; `src-tauri/src/catalog_store.rs`, `lib.rs` IPC; operator page export | PR 5, OD-4 | **rule 3**: second (`src-tauri` custody) |

No PR touches `apps/lattice_core/lib/lattice/authority*`, `canonical.ex`, `apps/lattice_core/lib/lattice/carrier/`,
`clients/lattice-client/src/{authority,codec,carrier}.ts` or `.github/workflows`. PR 6 is the only
rule 3 PR; PR 6 adding a CI job would add `.github/workflows` (also rule 3).

### Gates

- PR 1: `mix test apps/lattice_carrier_server/test/operator/catalog_binding_test.exs` and
  `catalog_ceremony_test.exs` (macOS and Docker): one test per refusal in Design 1, a fork of two
  honored bootstraps, a report edited after `report`, a dry-run key, and a served log equal to the
  ceremony export after relay.
- PR 2: carrier-server suite in Docker; manifest tests for `route` shape and listener dispatch over a
  real loopback socket; staging refusals for a wrong realm, wrong pub, missing route, duplicate
  route, a `trusted_peers` realm equal to the service realm, and an unbound Space instance; probe
  pulls over the route path; activation refuses a realm edited after staging.
- PR 3: `python3 apps/lattice_carrier_server/test/operator/mutation_protocol_test.py` and the parity table (each phase, missing or
  extra `catalog` artifact, head not equal to artifact) on both sides; owner refuses a plan-supplied
  store path, a store collision with other bytes, and a `journal` plan writing either phase.
- PR 4: `release_catalog_test.exs` (Linux owner): stage, seal, activate, restart, confirm, catalog;
  one test per refusal leaving journal, history and store bytes unchanged; revision 1 after a second
  attempt carries revision 0's entries; crash window (i).
- PR 5: `release_listing_test.exs`: listed after courier; a concurrent beacon lapsing the reference
  refuses `:reference_not_honored`; roster drift; crash windows (ii) and (iii); a client-side
  `CatalogTrust.evaluate` over the served logs accepts the route with `reason: nil`.
- PR 6: `npm run catalog:trust` and the shell unit tests; Rust `cargo test catalog_store`; hosted
  packaged job only if the PR claims packaged tier (rule 1).

Each PR: hosted `mix test` green on the exact tip (rule 2); evidence tier core unit unless stated.

## Done criteria (row 224)

- [ ] PRs 1-5 merged on green exact tips; the operator's own run records `catalogued` then `listed`
      on the pilot host from the real ceremony inputs (the build PRs prove it on fixtures only).
- [ ] Every refusal named in Designs 1-5 has a test, and every BEAM refusal leaves journal, history
      and store unchanged.
- [ ] Row 224 updated in one line; roadmap R11b moves to DONE only after the operator run; R11c's
      plan may then start. PR 6 may land under R13 instead (its own row).

## STOP conditions

- Any change under a rule 3 path other than PR 6's `src-tauri` files, or under `web_socket.ex`'s
  authentication (`peer_key/2`), or to the Wire vocabulary.
- The binding is absent from the served Space log, or two distinct honored bootstraps exist: stop
  for the operator; never pick one.
- `CatalogEntries.observe/2` cannot verify a catalog the design builds (an evaluator change is R11c
  or core work, not this plan).
- The service key equals any member, root, child root or probe key.
- A third review round on the same finding class (rule 3): operator design question.
- Any need to put the signer seed in a plan, journal, manifest, log, telemetry or the catalog store.

## Non-goals

R11c replacement and rotation; members' first install (R13); public WSS deployment and the origin
to port mapping (R21a); server push; history retention (row 225); any production or field claim.
