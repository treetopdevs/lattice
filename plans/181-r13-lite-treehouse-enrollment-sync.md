# Plan 181: R13-lite Treehouse enrollment and sync over one hand-configured relay route

Numbering note: "Plan 181" here is a newly allocated plan file. It is not the historical unallocated
"new Plan 181" slot that Plan 180 named for the successor-scope bound (that work was folded into R04
and delivered without a numbered plan file).

## Status

DONE (2026-10-10), at the tier Packaged macOS CI. The hosted `treehouse_packaged_macos_enrollment` job and `packaged_macos` were green at the exact tip in run 37718664290, and on main in run 37977222181; the evidence, review dispositions and follow-up rows 195 to 202 are in the `plans/README.md` row 181 and the closeout PR (branch `claude/181-r13-lite-closeout`). Round 6 working policy rules 1 and 2 superseded this plan's older exit items for a local packaged run and a separate merge-result run; the conflict is noted here and the Round 6 rules won. R13 itself stays PLANNED and every non-claim below stays.

Non-claim line: this plan builds no catalog, replacement, provisioning, device, custody, production,
pilot, or Phase G capability. See Non-goals and Completion claim.

- Priority: P1
- Effort: L (seven slices numbered 0 to 6, 17 agent-sized tickets; see the ticket table)
- Roadmap ID: R13-lite (a new sub-ID; R13 itself stays PLANNED, see Governance amendment)
- Depends on: Plans 129, 130, 131, 132, 133 (carrier relay, packaged gate pattern, subscription);
  R01b (DONE), R08 and R10 (DONE); R12 offline native preview (merged, but still IN PROGRESS in the
  ledger, so this plan builds on merged R12 code and does not claim R12 closure)
- Does not depend on the completion of: R11a, R11b, R11c. It is built on R11a-era runtime and guard code
  already on main (`ReleaseGate`, `Runtime.prepare_owned`, the stop seal from PR #101) without waiting
  for R11a to close. If R11a changes manifest boot, rebase and re-run the Slice 0 test before any later
  slice proceeds.
- Planned at: origin/main 981d4225c, branch `claude/r13-lite-enrollment-sync-10a2f5`
- Lands with: the files listed per slice, `plans/README.md` (append-only row 181), the roadmap
  ledger sub-row, and a scoped note under Plan 158's R01a amendment (see Slice 6)

## Objective

Two instances of one dev-trace test-variant macOS Treehouse bundle, each with a directory-isolated
store and a seeded in-memory test key (not Keychain custody), complete invite, join, post, converge,
restart, converge against one CI-launched `pilot_node.exs` fixture relay (loopback, macOS
directory-sync approximation) whose Space and Thread routes were written by hand into a manifest. The
final op ids, frame bytes, state and verdicts equal `Lattice.Sim`. The job is a hard-failing sibling of
`packaged_macos` in `.github/workflows/flagship.yml`.

Only semantic membership and Thread grants are enrolled in the log. Transport admission of both
instances is pre-seeded in the hand-written manifest; the flow does not enroll it.

The enrollment shape is Township's: product-neutral pairing handoff, native signing, persisted
outbox, one-signed-op-at-a-time relay submission, pull-only verification, subscription-triggered
refresh. Treehouse adds the invitation and join half, which Township does not have.

## Why this increment

- R13's R11 edge exists so that a relay can be replaced under signed catalog authority. First chat
  does not need replacement. The adoption register already permits a fixture-backed root-only domain
  before catalog (roadmap line 45); this plan extends the same reasoning to enrollment for a single
  unreplaceable route, as a recorded scope amendment (next section), not as a reading of that row.
- The Treehouse shell today is offline, single-identity, root-only. It has no joiner, no network, no
  outbox drain, no member capability lookup. Every later row (R14 roles, R15 rollover, R22 devices)
  needs a working two-app loop under it.
- Township already proved the transport half (Plans 129 to 133). Reusing it is cheaper than a second
  design, and it keeps the claim honest: the carrier is the existing relay process, started by CI.

## Governance amendment (must be written, not implied)

Plan 158's R01a execution amendment, item 3, reads: "R13 cannot enable multi-app enrollment until R11
completes." That names the whole of R11 (R11a, R11b and R11c), not only R11c. The register row at
roadmap line 45 ("Domain/catalog and catalog/deployment ordering") amends two edges: catalog to
`treehouseDomain` (permit a fixture-backed root-only domain before catalog) and catalog to public WSS
deployment (local catalog code before public WSS). It does not amend R13's dependency on R11.

So R13-lite is a new scope amendment that the operator directed in chat on 2026-10-07 (quoted verbatim
in Slice 6 as an evidence line). It waives the whole R11 (a, b and c) edge, for one hand-configured,
unreplaceable route set only. Every R11-dependent claim stays with full R13. Protected Plan 178 text,
the one-pager and Plan 177 are not edited. R13 keeps its Requires column; R14, R15, R16, R21a and R27
keep requiring full R13 or R11c.

## Critical trust separation

1. The relay is the existing `lattice_carrier_server` OS process, started by the CI harness as a
   subprocess (as Plans 129 and 131 do), loopback only, through the dev/test-only `pilot_node.exs`
   entrypoint. It is a separate trust role: its transport key never authors an operation, and no
   resident key ever signs a session.
2. The app never spawns, supervises, bundles, listens, or binds a LAN interface. No `treehouse_host`
   style module, no sidecar, no discovery. This keeps the rejected CD1 device-hosted carrier (Plans
   150 to 152, withdrawn by Plan 177(c)) closed, and Slice 5a adds pins for it (see 5a).
3. Relay admission (`trusted_peers`, `relay_realms`) is transport allowlisting, not a capability
   grant, and the enrollment flow does not issue it. `Treehouse.Space` says transport admission is the
   enrolling application's separate job, and here that job is done by the hand-written manifest before
   boot. Semantic authority arrives only as in-log delegations signed by the founder's key.
4. Every hosting sentence names who can read and who can withhold. The relay operator, and anyone
   with its host, backups or admitted transport peers, can read the plaintext log, and the host can
   withhold availability. The relay cannot decide semantic authority or erase device-held history. The
   shell shows a fixed disclosure to that effect wherever the user is asked to trust or use a relay
   route (Slice 2c).
5. The offer carries no private signing material and no bearer secret. The invitation stays
   recipient-bound: one signed ID and one recipient, replay is idempotent, rebinding is quarantined,
   revocation closes it, it is not a bearer link, and no expiry or use-limit claim is made.

## Verdict: manifest-owned routes boot from a hand-written manifest, no server change

Slice 0 as "server change" is not needed. Evidence, gathered by the read-only map:

- `LatticeCarrierServer.Application.start/2` reads `:manifest`, starts only the in-process
  `Operator.ReleaseGate` guard and `RuntimeSupervisor`. `Runtime.prepare_owned/3` calls
  `Manifest.load/1`, preflights each log (relay instances also rehearse durability), registers, and
  starts one `RouteOwner` per instance (`start_route` to `LatticeCarrierServer.start_link` with
  `source: {:path, log_file}`, `trusted_peers`, `relay_realms`).
- No reference to `Operator.Staging`, `Journal`, `Lock`, or any catalog or generation check exists in
  application, runtime, holder, listener or health code. Staging and the journal run only offline
  through `scripts/treehouse_operator*.{sh,py}`. The staging code that binds admitted identity runs
  only for candidate manifests offline (`verify_candidate_manifest`, which also requires
  `admitted.relay_realms == []`), so a harness-built manifest with `relay_realms` on a Space instance
  is not an admitted candidate and must never be presented as a staged, sealed or admitted route.
- Running `pilot_runtime_test.exs`, `runtime_isolation_test.exs` and `application_test.exs` in this
  worktree gave 15 tests, 0 failures. A scratch probe showed an empty `Log.new(replica)` dumped to
  disk restores through `Holder.restore_path`, and a genesis authority op relays into it with
  `accepted=[genesis]`.
- `state_reporter` is a closed whitelist (`"township"` only) and accepts `nil`; omitting it is correct
  for Treehouse. The shell pulls and materializes, so the `state` frame (which returns `read_only`
  without a reporter) is not used.
- `member_continuity_startup_test.exs` already boots `Treehouse.Space` through a hand-written manifest,
  relays, and reopens in a fresh BEAM. That is evidence the Treehouse command atoms load
  (`Wire.decode_op` uses `String.to_existing_atom`).

Decision this forces:

- Use the manifest path (`apps/lattice_carrier_server/priv/pilot_node.exs <manifest.json>`), one
  instance per replica, not `server_node.exs`. `server_node.exs` is Township-bound (hard-coded
  `Township.CarrierStateReport`, a single path source), and Treehouse needs one route per replica.
  `spawnStableCarrierServer` in the Township shell's `beam_peer.ts` is hard-wired to `server_node.exs`,
  so the manifest spawner in Slice 4 is new code, not reuse.
- No guard is weakened. `ReleaseGate` and release quiesce stay armed and inert; sealed staging and
  admitted-service binding live in the offline operator path that a hand-written manifest never
  enters; `Manifest.@state_reporters` and the manifest schema are untouched (operator-reviewed code).
  A hand-written manifest does boot through `ReleaseGate.acquire/complete`. The harness stop (stdin EOF,
  which ends in `System.halt(0)`) and `kill -9` paths are test-only: they produce no stop seal and
  claim no controlled-stop, staging or observed-seal semantics.
- `pilot_node.exs` sets `allow_ephemeral_manifest_ports` and, on darwin only,
  `allow_approximate_darwin_sync`. The release refuses that approximation. So the packaged macOS job
  has no durable-ack claim; durability evidence is the Linux Slice 4 gate only.
- Five constraints the harness must honor, each reproduced or read from source:
  1. macOS temp dirs sit under the `/var` symlink and `Manifest.load/1` refuses it
     (`{:invalid_manifest, {:manifest_path_permissions, "/var"}}`, reproduced). Use `realpathSync` of
     the temp root.
  2. Admission is static. Both apps' transport public keys must be known before the server boots.
     Resolved by seeded test keys (Slice 5b), as Township does with `seededEd25519Identity`.
  3. The log file must exist before boot. A fixture writes empty replica-named logs, and the founder
     relays the genesis into them. Use fixed loopback ports (not port 0) so restart reuses them.
  4. `identity_file` is a 64-hex seed, mode 0600, owned by the euid. Readiness can take several
     seconds (preload and log verification); allow a 60 second readiness bound.
  5. `manifest_path_permissions` requires `(mode &&& 0o022) == 0` on the manifest directory and every
     ancestor, so a world-writable `/tmp` (mode 1777) is refused on Linux. Never use `os.tmpdir()` on
     Ubuntu. The harness creates its temp root under the workspace (for example
     `<repo>/_build/test/tmp/r13-lite-<pid>`) or `$RUNNER_TEMP`, realpath-resolved, mode 0700, and a
     preflight helper asserts the whole chain has no group or other write bit before boot.

## Architecture

Reuse, by symbol (line numbers drift; find them by name):

| Need | Reuse | Where |
|---|---|---|
| Pull, verify, relay, durable-ack ids | `syncCarrierOnce` (exported). `submitCarrierFrames` is module-private, so only `syncCarrierOnce` is reusable | `clients/lattice-client/src/carrier.ts` |
| Availability subscription | `CarrierWebSocketClient.subscribeAvailability` (Plan 133) | `clients/lattice-client/src/carrier.ts` |
| Frame decode | `carrierOpsToSemanticOps(frames, realmByPubkey, commandDecoders?)` | `carrier.ts` |
| Treehouse authoring, acceptance, status | `authorTreehouseCommand`, `acceptTreehouseInvitation`, `treehouseCommandDecoders`, `treehouseCommandOpStatus` | `clients/lattice-client/src/treehouse.ts` |
| Generic grant authoring | `authorTownshipDelegation` (not Township-specific) | `clients/lattice-client/src/township.ts` |
| Route and pairing validation | pattern only: copy the small rules of `normalizeCarrierPeerConfig` (wss, or ws to loopback; 32-byte key; realm label) into a shell-local `treehouse_routes.ts`. Do not import `lattice-mobile-core` (see design decision 10) | `clients/lattice-mobile-core/src/pairing_handoff.ts` |
| Feed controller pattern | `createTownshipFeedController` (copy and parameterize) | `clients/township-tauri-shell/src/township_feed.ts` |
| Persist-after-ack ordering | `syncTownshipOutbox` (pattern, copy) | `clients/township-tauri-shell/src/township_sync.ts` |
| Domain oracle | `Treehouse.Invitation`, `Treehouse.ReadModel.observe` | `apps/lattice_core/lib/treehouse/` |
| Sim invite, accept, admit, grant flows | `domain_test.exs`, `thread_test.exs` | `apps/lattice_core/test/treehouse/` |
| Manifest server boot patterns | `write_pilot_fixture/1`, `spawn_pilot`, `await_pilot_ready` | `apps/lattice_carrier_server/test/pilot_runtime_test.exs` |
| Hand-manifest plus Treehouse relay plus reopen | fixture and in-subprocess script | `apps/lattice_carrier_server/test/member_continuity_startup_test.exs` |
| BEAM process helpers | copy `freeTcpPort` and `runBeamSupport` (exported); `pinnedBeamPath`, `elixirBin`, `mixBin` are unexported in `beam_peer.ts`, so copy them too. Do not import across shells | `clients/township-tauri-shell/test/support/beam_peer.ts` |
| Manifest relay spawner | new code (`spawnPilotManifestServer`); there is no reusable one | new |
| Packaged launch pattern | `packaged_preview.ts` spawns the binary directly (`spawn(binary, [], ...)`) which gives pid, env and signal control, and already runs in CI | `clients/treehouse-tauri-shell/test/packaged_preview.ts` |
| UI driver | accessibility helper addressed by pid; supports only `dump`, `press`, `set` today | `clients/treehouse-tauri-shell/test/support/packaged_accessibility.swift` |
| Township packaged-smoke shape (not the UI driving) | build-time env handoff plus trace file, seeded key, same-path restart | `clients/township-tauri-shell/test/tauri_stable_relay_onboarding_smoke.ts` |
| Workflow-contract test pattern | structural job and step parsing with mutated-YAML self-tests | `clients/township-tauri-shell/test/mobile_core_native_ci_contract.mjs` |
| CI job template | `packaged_macos` | `.github/workflows/flagship.yml` |

### Design decisions

1. **Key separation by data, not by command.** No new Tauri command is added. The preview command
   ceiling (six preview plus five witness commands, pinned in `product_contract.mjs`) is kept.
   Pairing, routes and acknowledgement state go into the existing single state record as a version 2
   envelope. `deny_unknown_fields` stays; the new fields are explicit. The v1 to v2 migration happens
   in `parse` only (TS `parseState`, Rust `preview.rs`), in memory. A v1 record is persisted as v2 only
   by the next explicit commit. Opening never writes. The ordinary packaged gate asserts byte-equal
   record bytes across restart, so a write-on-open migration is forbidden.
2. **Outbox stays monotonic; `acked` is the new additive set.** `PreviewStore.commit` rejects removal
   of retained frames or outbox ids (`retained_history_changed`). Do not relax that. Each profile
   already has `outbox: Vec<String>`, the monotonic list of locally authored ids. Add one more
   per-profile grow-only set, `acked`, a subset of retained ids. Define the sets precisely:
   - `retained`: all verified frames the profile holds.
   - `outbox`: ids this device authored. Never shrinks.
   - `acked`: ids known to be durable on the relay. Grows only. Subset of `retained`.
   - `pending = outbox minus acked`. Foreign frames are never pending, because they are never in
     `outbox`.
   - A verified pulled frame is added to `retained` and `acked` in the same CAS commit (it came from
     the relay, so it is durable there).
   - After submitting a locally authored frame, its id enters `acked` only if the relay's reply puts it
     in the `accepted` or `quarantined` bucket (both are persisted in the relay log before the reply),
     or if a fresh advertise or pull lists it (the duplicate-resubmit case, where `accepted` is empty
     because the op was already present). The `rejected` and `pending` buckets (`pending` means the
     relay lacks a dependency and did not persist the op) never enter `acked`.
   - Exit assertions are therefore: `acked` equals the retained id set, and `pending` is empty, for
     both stores.
3. **Joiner is a foreign-root profile with an explicit join intent.** v2 permits a Space profile and
   Thread profiles whose genesis author is not the local key. The `#root:<commitment>` in the replica
   string is verified in TS `verifyProfile` against the genesis author; the Rust store checks only the
   replica string format today and gains no commitment check unless 2a adds one with its own test.
   The Rust store has no workable join lifecycle today, so 2a defines it (see 2a): a `join` creation
   intent that permits key creation exactly once and is cleared when the key is persisted, not when a
   matching profile appears. Reopening never mints a key (R12 hazard: explicit first creation only).
4. **Per-replica routes.** One connection per replica (the hello challenge binds a replica). The route
   list is the Space plus the hand-configured Threads: at most four routes, so the Space plus at most
   three Threads. The shell fails closed above four routes, so the four-socket scheduler is trivially
   unconstrained and its fairness is not claimed.
5. **Hand-carried artifacts, no QR or link.** Three pasted text artifacts, each versioned and
   product-marked, none containing a secret:
   - join request: product marker plus the joiner's public key (joiner to founder);
   - offer: product marker, Space replica, every Thread replica in the invitation scope (archived ones
     included, marked as archived), invitation id, route list (url, expected server realm and public
     key, replica), and the local realm names; no key material (founder to joiner);
   - acceptance: replica, invitation id, recipient, recipient-signed acceptance (joiner to founder).
   There is no deep-link plugin and no camera claim. Admission needs the joiner's signed acceptance
   inside the founder's `admit_member`, so the third artifact is required by the domain, not a choice.
6. **Use, Sign and Sync stay three separate actions** end to end: Use (import and review, persists
   routes only after confirmation), Sign (accept, admit-and-grant, post: native signing, no network),
   Sync (network only). Wrong product, recipient, replica or server input makes no durable change.
7. **Invitation scope is every honored Thread, archived or not.** `issue_invitation` and
   `admit_member` both require `threads == thread_scope(context)`, and `thread_scope` matches every
   honored `create_thread` op with no archive filter. An archived Thread cannot be dropped from the
   signed scope, so the joiner is bound to it and needs a route and a grant for it, or the scope is
   unreviewable. With a four-route cap, a Space with more than three Threads (archived included)
   cannot issue an invitation in the lite shell. `issueInvitation` therefore refuses, with the explicit
   reason `thread_scope_exceeds_routes`, when the honored Thread count (archived included) is above
   three or when any Thread in the scope has no configured route. The offer lists every Thread in
   scope and marks archived ones. Nothing is claimed about new members reading archived Threads.
8. **Admit and grant is one reviewed founder action.** After `admit_member`, the founder authors
   exact-audience Thread grants (`post`, `author_edit`, `author_tombstone`, parent is the founder's
   root delegation) for every Thread in the invitation scope, so the joiner can sign posts. Two
   quarantine reasons are pinned exactly and must not be conflated (authority.ex): a post with no
   capability or an unknown capability id is `no_capability`; a post under a capability whose op set
   lacks `post` is `operation_not_granted` (authority.ex checks the op set first; `role_not_granted`
   fires only when a command needs an authority role the capability lacks, which a Thread post never
   does). The shell's `post` goes through a capability lookup that refuses
   locally when none exists (today it looks up only the root delegation), so the negative tests author
   the grantless post by calling `authorTreehouseCommand` directly with a null or wrong `capId`,
   bypassing the shell's local refusal. The BEAM side uses `Sim.command(..., cap: :none)`.
9. **Sim-equal is exact, and deps come only from Sim.** Op ids hash the sorted deps, and in Sim an op's
   deps are the author's local frontier at authoring time, so ids depend on the real sync
   interleaving. The oracle therefore takes an observed trace of per-authoring sync points (see Trust
   and oracle invariants), the gate awaits and asserts convergence before every authoring step so each
   op's dependency frontier is deterministic, and the oracle drives `Sim.sync_all`, `partition` and
   `heal` to those points. The oracle never reads deps from the shell frames or stores; doing so would
   make the comparison tautological.
10. **No `lattice-mobile-core` dependency in the Treehouse shell, and no route handling in
    `lattice-client`.** `normalizeCarrierPeerConfig` lives in `lattice-mobile-core`, which depends on
    `lattice-client`, so a route-validating module in `lattice-client` would create a package cycle.
    The `lattice-client` enrollment module is pure over frames and artifacts and imports only client
    primitives. Route and offer-route validation lives in the shell (`src/treehouse_routes.ts`), copied
    from the small rules of the mobile-core function. This also keeps the existing CI jobs intact: in
    the `unit` job the Treehouse steps run before "Build TS mobile core", and `treehouse_android_preview`
    never builds mobile-core, so a new dependency would need workflow edits that this decision avoids.
    The shell already depends on `lattice-client`, which both jobs build first.
11. **Enrollment UI is build-flag gated.** The enrollment and relay UI, the carrier client import
    (a dynamic `import()` under the flag), and the relay CSP exist only when `VITE_TREEHOUSE_ENROLLMENT=1`
    is set at build time, which the dev-trace variant sets. The ordinary and Android builds stay
    local-only: their CSP, `Local preview` label, R12 exit and `recovery_not_ready` copy are unchanged.
    A bundle scan pins that the ordinary `dist` contains no `subscribeAvailability` and no relay-client
    strings. Shipping enrollment in the ordinary build is a separate decision (open question 1).
12. **The second instance mechanism is named.** The gate uses one dev-trace build variant, launched
    twice, with a directory-isolated store and a seeded in-memory test key (Slice 5b), as Township's
    dev-trace variant does. That is a weaker claim than "ordinary installed app with Keychain custody",
    and it is one bundle with two instances, not two packages. The ordinary app is still covered by
    the existing `npm run packaged` step. The variant seam is compiled out of the ordinary build, and a
    bundle classifier plus a binary string scan prove it.

## Ticket table and ordering

Seven slices, 17 tickets.

| Ticket | What | Needs |
|---|---|---|
| S0 | Treehouse route boot characterization and discriminating mutations | none |
| S1a | BEAM enrollment vectors and TS-versus-BEAM id parity proof | none |
| S1b | TS enrollment module and negatives | S1a |
| S2a | State v2, join intent lifecycle, native store | none |
| S2b | Enrollment workflow and shell route module | S1b, S2a |
| S2c | Enrollment panel, disclosure copy | S2b |
| S3a | Injectable decoders in `carrier.ts` | none |
| S3b1 | `syncTreehouse` and acked/pending semantics | S3a, S2a, S2b |
| S3b2 | Feed controller and relay client | S3b1 |
| S3c | Sync control and status in the panel | S2c, S3b2 |
| S4 | Headless real-socket gate against Sim (Ubuntu) | S0, S1b, S3b2 |
| S5a | Pin amendments (CD1, std::env, CSP overlay) | none |
| S5b | Dev-trace seam and bundle classifier | S2a, S5a |
| S5c0 | Accessibility transfer spike and decision gate G-AX | none (runs on the ordinary build) |
| S5c1 | Packaged harness and oracle wiring | S4, S5a, S5b, S5c0, S3c |
| S5c2 | CI job and structural contract test | S5c1 |
| S6 | Roadmap, ledger and docs | all |

Parallelism: S0, S1a, S2a, S3a, S5a and S5c0 are file-disjoint and can start together. Single-writer
files: `App.vue` (S2c then S3c), `carrier.ts` (S3a), `preview.rs` (S2a then S5b), the workflow YAML
(S5c2, with S1a's vector step added earlier by rebase). Every slice: RED test committed first and shown
failing for the stated reason, then GREEN, then the slice's focused commands, then a summary of what was
reused. Slice 0 is the exception: it is a characterization test, not a RED test (see Slice 0).

Every new TS test file is appended to the owning package's existing test chain so CI runs it: the
Treehouse shell `npm test` script (`test/sync.ts`, `test/feed.ts`, `test/enrollment_ui_contract.mjs`,
`test/enrollment_ci_contract.mjs`, `test/packaged_bundle_variant.ts`), and the `lattice-client`
`treehouse` or `carrier:relay-sync` script (`test/treehouse_enrollment.ts`, `test/carrier_decoders.ts`).
Rust v2 tests live under `src-tauri/tests` so the existing `cargo test --locked` step in the `unit` job
runs them, and the `unit` job gains `cargo test --features treehouse-dev-trace` for the Treehouse
`src-tauri` (mirroring the Township `township-dev-trace` step) so the seam tests execute in CI.

Toolchain for BEAM commands:

```
export ERL_FLAGS='+S 4:4' PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"
MIX_ENV=test ~/.asdf/shims/mix deps.get && MIX_ENV=test ~/.asdf/shims/mix compile
```

(use `~/.asdf/shims/mix`; the mise mix shim is broken; run `mix compile` before mix tasks so `_build`
is not stale; call `node_modules/.bin/*` directly if the npm shell wrapper recurses).

## Slices

### Slice 0: Treehouse route boot characterization (test only, no server source change)

Files (new only): `apps/lattice_carrier_server/test/treehouse_route_boot_test.exs`. Use the ExUnit
`@tag :tmp_dir` fixture (under `_build/test/tmp`), which satisfies the Linux ancestor-permission rule
and avoids the macOS `/var` symlink. Do not touch `manifest.ex`, `runtime.ex`, `priv/*.exs`.

This is a characterization test, and it is not called RED. By the verdict above the happy path should
already pass. Its job is to pin, with discriminating mutations, that a hand-written manifest boots the
routes with no server change.

Behavior: a 2-instance hand-written manifest (one `Treehouse.Space` replica, one `Treehouse.Thread`
replica, empty replica-named path logs, `state_reporter` omitted) boots through the real
`pilot_node.exs` subprocess. Transport admission: `trusted_peers` founder, joiner and observer;
`relay_realms` founder only on the Space instance (the joiner never submits to the Space, because
acceptance rides inside the founder's `admit_member`) and founder plus joiner on the Thread instance.
An authenticated founder relays Space genesis, Space `create_space`, Thread genesis, Thread
`create_thread`. A joiner relays a post only after a Sim-authored grant is also relayed. The observer
gets `read_only` on `relay`. After `kill -9` and respawn from the same manifest, a pull returns ids
equal to the Sim ids.

Discriminating mutations (each must flip the result; these test the "no server change needed" claim):
(a) omit the Thread instance from the manifest: the Thread pull must fail with `wrong_replica`;
(b) respawn against a log file at a different path after `kill -9`: the pulled ids must differ from the
Sim ids; (c) delete the log file before respawn: the restart-equality assertion must fail.

Cheap wire negatives, asserted against the live relay and then re-pulled after a `kill -9` respawn:
(d) a joiner post before its grant is reported `quarantined` with the exact reason (`no_capability` for
a null capability, `operation_not_granted` for a capability lacking `post`) and is still advertised and
durable; (e) a bad-signature op is `rejected` and absent after restart; (f) a missing-dependency op is
`pending` and absent after restart.

Pins of existing refusals (documented constraints, not RED): drop `relay_realms` and assert
`read_only`; write the manifest under the unresolved `/var/folders` temp path and assert the exact
`manifest_path_permissions` refusal; wrong replica in the challenge is `wrong_replica`; an untrusted
realm is refused; a joiner `relay` to the Space route is `read_only`.

If the happy path unexpectedly fails (for example `unknown_atom`), STOP: that is the "needs a server
change" branch and requires the guard analysis below before any edit.

Guard analysis if the contingency triggers: any preload or atom-loading fix must be in
`preload_lattice_core` only, must not change `Manifest.@state_reporters`, `ReleaseGate`, quiesce,
staging or admission, and needs an operator-reviewed diff.

GREEN commands:

```
cd apps/lattice_carrier_server && ~/.asdf/shims/mix test test/treehouse_route_boot_test.exs test/pilot_runtime_test.exs test/runtime_isolation_test.exs test/application_test.exs test/member_continuity_startup_test.exs
```

Reuses: `write_pilot_fixture/1` and `spawn_pilot` in `pilot_runtime_test.exs`,
`member_continuity_startup_test.exs`, `priv/pilot_node.exs`.

### Slice 1a: BEAM enrollment vectors and id parity proof

Files: new `apps/lattice_core/test/support/enrollment_vectors.ex` (a test-support module, like
`Lattice.ContinuationVectors` and `Treehouse.MemberContinuityVectors`; `mix.exs` compiles
`test/support` only in `:test`, and modules in `lib/` would ship and be preloaded by
`Holder.preload_lattice_core`), new `apps/lattice_core/test/treehouse/enrollment_vectors_test.exs`,
vectors under `clients/lattice-client/test/vectors/treehouse_enrollment/`, one step in
`.github/workflows/flagship.yml` `verify` job beside the existing vector export lines.

The exporter runs the Sim flow (invite, accept via `Treehouse.Invitation.accept`, admit,
`Sim.grant(ops: [:post, :author_edit, :author_tombstone])`, member post) plus negatives, and writes
`Wire.encode_op` frames, honored and quarantine verdicts with exact reasons, and `ReadModel.observe`
state. The vectors include the archived-Thread case (an archived Thread stays in the invitation scope)
and the four-Thread cap case.

RED: the test file fails first for a missing module; then the exporter must reproduce every vector
deterministically across two runs (byte-identical output).

```
MIX_ENV=test ~/.asdf/shims/mix test apps/lattice_core/test/treehouse/enrollment_vectors_test.exs apps/lattice_core/test/treehouse/invitation_test.exs apps/lattice_core/test/treehouse/thread_test.exs apps/lattice_core/test/treehouse/contract_test.exs
MIX_ENV=test ~/.asdf/shims/mix run -e 'Treehouse.EnrollmentVectors.write("clients/lattice-client/test/vectors")'
```

Reuses: `domain_test.exs`, the `Lattice.ContinuationVectors.write` pattern. Do not edit `invitation.ex`
or Plan 178 protected text.

### Slice 1b: TS invitation and join module with parity proof

Files: new `clients/lattice-client/src/treehouse_enrollment.ts`; export line in
`clients/lattice-client/src/index.ts`; new `clients/lattice-client/test/treehouse_enrollment.ts`;
`clients/lattice-client/package.json` (extend the `treehouse` script).

The module is pure over frames and artifacts. It does no route handling and imports no
`lattice-mobile-core` code (decision 10); route validation lives in the shell (S2b).

Behavior (no storage, no network):
- `encode`/`decode` for join request, offer, acceptance artifacts; versioned prefixes
  (`treehouse-join-request:v1:`, `treehouse-offer:v1:`, `treehouse-acceptance:v1:`), canonical
  base64url JSON, product marker checked, unknown fields and oversize rejected. Route entries are
  decoded as opaque shaped records here and validated by the shell.
- `memberCapability(frames, publicKey, replica, { product, command? })`: the delegation whose audience is
  my key (not only the issuer-root lookup the shell uses today). `product` is required, so only honored
  frames are searched and a quarantined grant is never offered.
- `authorTreehouseAdmitAndGrant`: given founder signer, current frames, acceptance, produces the
  `admit_member` op plus exact-audience Thread grant ops, one per Thread in scope, in causal order,
  reusing `authorTreehouseCommand` and `authorTownshipDelegation`.
- `reviewInvitation`: recipient, group, full Thread scope (archived included), using
  `treehouseCommandOpStatus`; refuses stale scope, wrong recipient, wrong replica, revoked, already
  admitted rebind.
- `issueInvitation` guard: refuses with `thread_scope_exceeds_routes` when the honored Thread count
  (archived included) is above three or when a Thread in scope has no route entry supplied by the
  caller.

RED (written first, all must fail before the module exists): TS authored frame ids equal BEAM ids for
the positive flow when authored from the same deterministic seeds, replica strings and dependency
frontier (this is the feasibility proof for the exact Sim comparison in Slices 4 and 5; record the
result in TDD evidence); TS state and verdicts equal BEAM for every vector; wrong-recipient acceptance,
wrong replica, scope mismatch after a new Thread, rebinding, revoked invitation, replayed admit
(idempotent), grantless member post quarantines with the exact reason `no_capability` identically to
BEAM, a post under a capability lacking `post` quarantines `operation_not_granted`, grant with wrong parent
quarantines; the archived-Thread case (the archived Thread is in the offer scope, and a grant is
issued for it); an invitation attempt over the route cap refuses `thread_scope_exceeds_routes`;
artifact decoders refuse wrong product marker, secret-looking fields and oversize input. A dependency
perturbation mutation (one dep changed) must change the TS id and fail the parity assertion. This also
closes a gap in the current TS tests: `clients/lattice-client/test/treehouse.ts` signs only as the
root, so no TS test exercises a delegated member post.

```
cd clients/lattice-client && npm run build && npx tsx test/treehouse_enrollment.ts && npm run treehouse
```

Reuses: `treehouse.ts` authoring and status functions, `township.ts` `authorTownshipDelegation`,
the S1a vectors.

### Slice 2: Shell native persistence, enrollment workflow, enrollment UI

Three tickets. 2a is independent of S1; 2b needs S1b and 2a; 2c needs 2b.

**2a. State v2, join lifecycle and native store.** Files:
`clients/treehouse-tauri-shell/src/treehouse_state.ts`,
`clients/treehouse-tauri-shell/src-tauri/src/preview.rs`,
`clients/treehouse-tauri-shell/src-tauri/tests/storage_lifecycle.rs`,
`clients/treehouse-tauri-shell/src-tauri/tests/native_commands.rs` (it also uses `PreviewStore` and
must stay green and gain the join cases),
`clients/treehouse-tauri-shell/test/storage.ts`. No `lib.rs` command change.

Behavior: version 2 record with `relay: {localRealm, routes[{replica,url,expectedPeerRealm,
expectedPeerPubkey}]}|null` (max four), per-profile `acked`, v1 and v0 records migrate forward in
`parse` only, a v2 record is rejected by a v1 reader (fail closed), `acked` only grows and is a subset
of retained ids, outbox stays monotonic, 13 profile and 1 MiB caps unchanged. A profile with zero
frames stays invalid, so a joiner profile is created only with its first dependency-closed pulled
batch.

Join intent lifecycle (the Rust store refuses it in four places today, and all four change):
- Creation: `beginJoin` commits a record with `intent: {kind: "join", name: "join", nonce}` and no key.
  The fixed `name` constant satisfies the non-empty rule; it carries no user text. `parse` accepts
  intent kinds `space | thread | join`.
- Key: `initialize` permits key creation only when there is no public key, no profiles, and the intent
  kind is `space` or `join` (it checks `kind == "space"` only today). `commit` repeats that gate for the
  `old.public_key.is_none() && next.public_key.is_some()` branch and gets the same widening.
- Clearing: the `creation_incomplete` branch today requires a new profile whose replica starts with
  `replica:treehouse:{kind}:{nonce}#root:`; a joiner's profiles carry the founder's replica strings, so
  that can never match. For a `join` intent, the intent is cleared by the commit that persists the key
  (`next.public_key == the loaded key`, intent `None`, profiles still empty). A record with a key and no
  profiles is valid only on that path.
- Version: `commit` hard-codes `["version"] != 1` on the raw JSON; it accepts only version 2 for new
  commits after this slice (a v1 `next` is rejected), while `parse` still reads v0 and v1.
- Reopening a store with no key and a non-empty record, or with a `join` intent already spent, does not
  mint a key.

RED: Rust and TS tests for each branch: a join intent is created, initialize mints exactly one key,
the clearing commit succeeds, and a second initialize is refused (`identity_creation_not_allowed`);
a `join` record that skips the key (clearing without `public_key`) is refused (`creation_incomplete`);
a `join` intent with profiles present refuses key creation; commit of a v1 `next` is refused; a
joiner record with a foreign-root Space profile is accepted by the Rust store on format and by TS
`verifyProfile` only when the commitment matches, and a wrong-root profile is refused by TS
(`wrong_profile_root`); `acked` shrink refused; acked id not in frames refused; v1 to v2 migration
preserves frames and revision; a v1 record reopened without a commit stays byte-identical (Rust and TS
tests, asserting `open` returns the same raw bytes); routes above four refused; the existing space
intent flow is unchanged.

```
cd clients/treehouse-tauri-shell && npm run native:test && npx tsx test/storage.ts
```

**2b. Enrollment workflow and shell route module.** Files:
`clients/treehouse-tauri-shell/src/treehouse_workflow.ts`, new
`clients/treehouse-tauri-shell/src/treehouse_routes.ts` (route and offer-route validation, copied rules,
no `lattice-mobile-core` import), `clients/treehouse-tauri-shell/src/native_adapter.ts` (only if the
adapter type needs the v2 shape), `clients/treehouse-tauri-shell/test/workflow.ts`.

Behavior, all through the existing serialized `exclusive()` queue and native sign: `beginJoin` (key
creation under join intent, returns join request), `issueInvitation(joinRequest)` (founder; refuses
with `thread_scope_exceeds_routes` per decision 7, and when Thread routes are not configured or the
Thread set changed, so the pinned scope is exact), `useOffer(offer)` then `confirmOffer` (persists
routes only after confirmation, refuses wrong product, replica, server; a second confirm of the same
offer is a no-op that leaves `revision` unchanged), `acceptInvitation` (reviews, signs acceptance, no
network, no durable change on refusal), `admitAndGrant(acceptance)` (founder), `post` generalized to use
`memberCapability` for a joiner. `createThread` in the lite shell is allowed only for a Thread whose
route is already configured and only while the honored Thread count (archived included) stays at or
below three. Wrong-input negatives assert `revision` unchanged and the exact error label.

RED: one workflow test section per negative in Slice 1b plus cold start (no key, no profile, no route,
nothing minted), the over-cap and unrouted-Thread refusals, a refusal leaving `revision` unchanged, a
Township pairing handoff pasted as an offer (`wrong_product`), and a founder-then-joiner in-memory run
that ends with a member post authored under the member capability.

```
cd clients/treehouse-tauri-shell && npm run typecheck && npx tsx test/workflow.ts && npm test
```

**2c. Enrollment panel.** Files: `clients/treehouse-tauri-shell/src/App.vue` (single writer),
`src/style.css` if needed, new `test/enrollment_ui_contract.mjs` (appended to `npm test`).

Behavior (rendered only under `VITE_TREEHOUSE_ENROLLMENT=1`, decision 11): panel with separate buttons
Use, Accept or Admit-and-grant, Post, Sync (Sync is S3c). Each of the three artifacts has a read-only
textarea showing the artifact text (so the harness can read it from the accessibility dump without a
clipboard) and a copy button as a convenience, plus an editable textarea for pasting. Stable accessible
labels: `Join a group`, `Copy join request`, `Paste join request`, `Issue invitation`, `Copy offer`,
`Paste offer`, `Use offer`, `Accept invitation`, `Copy acceptance`, `Paste acceptance`,
`Admit and grant`, `Sync`; author display distinguishes You, Founder, Member by key.

Existing packaged-preview literals stay verbatim, including `Local preview` (the ordinary build is
unchanged, so the label stays honest there): `Recovery is not set up`, `Group name`,
`Create local group`, `Thread title`, `Create thread`, `Write a post`, `Post`, `Edit post 1`,
`Save edit`, `Archive thread`, `This thread is archived.`. The current fine print, "There are no
members or connections yet. Inviting others and recovery come later." (App.vue near line 274), is
unchanged in the ordinary build. In the enrollment build it is replaced by copy saying routes are
operator hand-configured and unsigned by any catalog; still no recovery claim, no founder-loss safety
claim, no banned hosting phrase.

Required fixed disclosure, shown on the Use-offer review and on the Sync status panel, together with the
pinned server realm and public key of each route: "The relay operator, and anyone with its host,
backups or admitted peers, can read this group's plaintext log, and the host can withhold availability.
The relay cannot decide who may act in the group." The disclosure string is pinned by the contract test.

RED: contract test that every label above exists under the flag, that the retained literals still exist
in the ordinary build, that the disclosure and realm and key display appear on the Use-offer review and
Sync status, that no button combines Sign and Sync, and that copy contains none of the prohibited
phrases.

```
cd clients/treehouse-tauri-shell && npm run build && VITE_TREEHOUSE_ENROLLMENT=1 npm run build && npm test
~/.asdf/shims/mix test apps/lattice_core/test/treehouse/contract_test.exs
```

### Slice 3: Relay sync, subscription pull, convergence state, restart recovery

**3a. Injectable decoders.** Files: `clients/lattice-client/src/carrier.ts` (single writer), new
`clients/lattice-client/test/carrier_decoders.ts` (added to the `carrier:relay-sync` script).

Behavior: add optional `commandDecoders` to `SyncCarrierOptions`, passed to `carrierOpsToSemanticOps`
in the pulled-ops path and also to the per-frame `carrierOpToSemanticOp` call in the candidate loop, so
both call sites agree. Default behavior byte-identical for Township (without decoders the candidate
loop still yields ids from neutral payloads).

RED: a Treehouse frame set pulled through `syncCarrierOnce` decodes to Treehouse semantic effects with
the decoders option and to the neutral shape without it; Township sync vectors unchanged.

```
cd clients/lattice-client && npm run build && npm run carrier:relay-sync && npm run carrier:relay && npm run carrier:feed && npx tsx test/treehouse.ts
```

**3b1. Sync module.** Files (new): `clients/treehouse-tauri-shell/src/treehouse_sync.ts`; tests
`test/sync.ts` (appended to `npm test`), plus a test-support fault-injecting adapter wrapper in
`test/support/`. No `package.json` dependency change beyond test scripts (decision 10).

Behavior:
- `syncTreehouse(route)`: per replica, `syncCarrierOnce` in relay mode with
  `treehouseCommandDecoders(product)`. Pulled frames are merged only as a dependency-closed set: the
  native store rejects retained history with a missing dep (`incomplete_retained_history`) and relay
  pulls are paginated (R08), so the module keeps pulling until every merged frame's deps are present in
  the profile or the batch, and a page cap reached with open deps makes no durable change. Pulled
  frames that fail `verifyProfile` make no durable change. Duplicates are byte-equal.
- The sets and ack rules are exactly decision 2: pulled frames are acked on verified pull; locally
  authored frames are submitted one at a time and acked only per the relay report buckets
  (`accepted` and `quarantined` ack; `rejected` and `pending` never ack; a duplicate resubmit acks only
  through a fresh advertise or pull). Persist order: write retained frames and `acked` together in one
  CAS commit, and only after the relay's own persist-before-ack reply, as `township_sync.ts` does.
- One writer: sync merges go through the workflow `exclusive()` queue so user posts and hint pulls
  cannot race (`stale_saved_state`).
- Restart: on boot, pending = `outbox` minus `acked`; resubmit.

RED, against an in-process fake carrier (the Plan 133 test peer pattern) first, then Slice 4 for the
real socket: for each relay report bucket, `accepted` and `quarantined` ids enter `acked`, while
`pending` and `rejected` ids never do; the fault injection point is a failing `native.commit` after a
successful submit (a wrapper in the test adapter): pending survives, the resubmission returns an empty
`accepted`, the id is acked only through the advertise path, and no duplicate entries result; an outbox
larger than the relay burst (120 ops, refilled at 12 per second) still drains to completion; a
paginated partial pull whose first page has open deps produces no durable change; a corrupt pulled
frame is rejected with no state change; more than four routes refuses to start.

```
cd clients/treehouse-tauri-shell && npm run typecheck && npx tsx test/sync.ts && npm test
```

**3b2. Feed controller and relay client.** Files (new):
`clients/treehouse-tauri-shell/src/treehouse_feed.ts`,
`clients/treehouse-tauri-shell/src/treehouse_relay_client.ts`; test `test/feed.ts` (appended to
`npm test`).

Behavior:
- Feed controller: copy and parameterize `createTownshipFeedController`: connect,
  `subscribeAvailability`, coalesced trailing refresh, reconnect backoff 100 to 5000 ms, epoch cancel.
  The stateReport cross-check is dropped (no reporter); the verified pull plus local `verifyProfile` is
  the check. Poll fallback interval is a build-time value (`VITE_TREEHOUSE_POLL_MS`, 0 disables) so the
  variant can disable it.
- Connection state per route: `idle | connecting | live | reconnecting | refused`, pending count, last
  relay generation seen, and "matches relay" meaning local ids equal the advertised frontier ids after a
  sync. Never labelled peer convergence.
- Autosync on mount is a build-time flag, `VITE_TREEHOUSE_AUTOSYNC_ON_MOUNT` (default on when a route is
  configured, `0` disables), mirroring Township's `VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT`. The variant build sets
  it to `0`. With it off, nothing connects at boot; a manual Sync performs one verified sync and starts
  the subscription for the session.

RED: a hint triggers exactly one pull; a regression or malformed hint fails the socket closed; reconnect
resumes; with the poll disabled, a hint alone converges.

```
cd clients/treehouse-tauri-shell && npm run typecheck && npx tsx test/feed.ts && npm test
```

**3c. Sync control and status in the panel.** Files: `clients/treehouse-tauri-shell/src/App.vue`
(after 2c), test extension from 2c. Adds the `Sync` button, per-route status, pending and acknowledged
counts, and the disclosure on the status panel (2c). In the enrollment build only. It replaces the
enrollment build's fine print with the real status; the ordinary build's fine print is untouched.
Boot never auto-syncs without a configured route; the packaged gate sets the autosync flag to `0` at
build time and presses Sync explicitly (see Slice 5c1 for which steps use manual Sync and which rely on
the live feed).

### Slice 4: Headless real-socket two-client gate against Lattice.Sim

Files (new): `clients/treehouse-tauri-shell/test/enrollment_sync_gate.ts`,
`clients/treehouse-tauri-shell/test/support/relay_peer.ts` (`spawnPilotManifestServer`: temp root under
the workspace or `$RUNNER_TEMP`, never `os.tmpdir()` on Ubuntu, realpath-resolved, mode 0700 chain
asserted before boot; 0600 identity files; manifest writer; `INSTANCE name port pubkey` and
`PILOT_READY` parsing; `stop()` via stdin, `kill()` via SIGKILL, same-port restart),
`clients/treehouse-tauri-shell/test/support/treehouse_enrollment_fixture.exs` (empty replica-named
logs), `clients/treehouse-tauri-shell/test/support/treehouse_enrollment_oracle.exs`,
`clients/treehouse-tauri-shell/test/support/secret_scan.ts` (a Treehouse-local copy of the idea behind
Township's `assertTownshipKvStoresNoSecrets`; do not import across shells); edit
`clients/treehouse-tauri-shell/package.json` (script `gate:enrollment`); one step in the Ubuntu `unit`
job of `flagship.yml` (Linux is the supported durability platform, so this job runs the manifest server
without the darwin approximation, and it is the only durability evidence in this plan).

Behavior: two in-memory-native `TreehouseWorkflow` clients (founder, joiner; seeded test keys; the
in-memory adapter is named as such) run the full scenario against the manifest-booted server over real
sockets: create group and Thread, route import, Sync (genesis relayed into empty logs), join request,
issue, offer, use, sync, accept, admit-and-grant, sync, joiner post, sync, founder pull (subscription
hint with the poll disabled), founder reply, restart the relay with `kill -9` and same manifest, an
offline post while the relay is down that drains after restart (the "heal" claim), converge.

The gate awaits and asserts convergence (both client frontiers equal the relay's pulled frontier) before
every authoring step. It writes an observed trace of per-authoring sync points. The oracle script
(`treehouse_enrollment_oracle.exs`) replays the actual replica strings, identities and command order
through `Lattice.Sim`, drives `Sim.sync_all`, `partition` and `heal` to the trace's sync points, and
derives deps only from Sim.

Comparison, in both directions (sorted id list count and set equality) across relay log files, founder
store, joiner store, and a fresh read-only observer pull: equal op ids; byte-equal `Wire.encode_op`
frames including the signature; canonical JSON state with deterministic key order; the exact quarantine
reason map. Also asserts: no op authored by the relay key or observer key, `acked` equals all retained
ids and pending is zero for both stores, and secrets are absent per the hygiene split in Trust and
oracle invariants. Negative controls that must make the oracle fail: perturb one dep in the trace
replay; drop one id; change one frame byte.

Wire-level negatives (real sockets), each asserting the exact error label and zero durable change
(store `revision` and frame count unchanged): paste the join request into the offer field; an
acceptance with one flipped signature byte; a Township pairing handoff pasted as an offer; replay the
same offer twice (second is idempotent); a route with a wrong `expectedPeerPubkey` is refused and
`acked` is unchanged; a replayed admit is idempotent.

RED: write the gate and oracle first; they fail because the shell modules or routes are not wired. Add
mutation checks that make it fail: skip the grant (the joiner's grantless post must quarantine with
the exact reason `no_capability`, identically in Sim, the relay report, both clients'
`quarantineReasons`, and the oracle), relay a post before acceptance, restart with a different log
path.

```
~/.asdf/shims/mix test apps/lattice_carrier_server/test/treehouse_route_boot_test.exs
cd clients/treehouse-tauri-shell && npm run gate:enrollment
```

Reuses: the copied `beam_peer.ts` helpers, `stable_relay_verify.exs` pattern,
`scripts/treehouse_verify_preview.exs` replay pattern, Plan 133 real-socket gate structure.

### Slice 5: Packaged two-instance macOS harness and hard-failing CI job

Four tickets. 5a and 5c0 can run any time; 5b needs 2a; 5c1 needs S4, 5a, 5b, 5c0 and 3c; 5c2 needs 5c1.

**5a. Pin amendments (explicit, reviewed, minimal).** Files:
`clients/treehouse-tauri-shell/src-tauri/tauri.dev-trace.conf.json` (new merge overlay),
`clients/treehouse-tauri-shell/test/product_contract.mjs`. The ordinary `tauri.conf.json` is not edited
(decision 11).

- CSP: the ordinary `connect-src` stays `'self' ipc: http://ipc.localhost`. The dev-trace overlay adds
  `ws://127.0.0.1:*` only (plus `http://127.0.0.1:*` only if the G-AX fallback is chosen). The pin test
  asserts both exact strings. TS refuses `ws:` to a non-loopback host.
- Forbidden-text pin, described as it is today: the regex
  `insert_seeded_dev_key|import_seed|DEV_SEED|SEED_PHRASE|governance-test-presence|NativeCarrierPeer|discovery|websocket`
  is applied to every file under `src` and `src-tauri/src`, and `std::env` is asserted absent only from
  `lib.rs` (not by the regex). After this slice: `websocket` stays forbidden in `src-tauri/src/**` and
  `Cargo.toml`, and is relaxed only for an explicit allowlist of named TS files that import the carrier
  client (`src/treehouse_relay_client.ts`, `src/treehouse_feed.ts`, `src/treehouse_sync.ts`).
  `insert_seeded_dev_key|import_seed|DEV_SEED|SEED_PHRASE|governance-test-presence|NativeCarrierPeer|
  discovery` stay forbidden everywhere. `std::env` is asserted absent from all of `src-tauri/src`
  except the single file `src-tauri/src/dev_trace.rs`, and `dev_trace` must be declared as
  `#[cfg(feature = "treehouse-dev-trace")] mod dev_trace;`; the pin asserts that gating by text.
- New CD1 closure pins: `Cargo.toml` has no listener, server or tungstenite-style direct dependency
  (an explicit deny list: `tungstenite`, `tokio-tungstenite`, `axum`, `hyper`, `warp`, `actix`,
  `mdns`, `zeroconf`), and `src-tauri/src` contains no `bind(`, `TcpListener`, `UdpSocket`, or
  `listen(`.
- The six preview commands and five witness commands, `build.rs`, and both capability files are
  unchanged and stay pinned.
- The amendment is recorded in this plan (the review artifact) and called out in the PR.

RED: edit the pin tests first (they fail against the unchanged tree), then make them pass.

**5b. Dev-trace seam (compiled out of the ordinary build).** `preview.rs` IS touched (it is
single-writer and follows 2a). Files: new `src-tauri/src/dev_trace.rs`; edit `src-tauri/Cargo.toml`
(`[features] treehouse-dev-trace = []`), `src-tauri/src/preview.rs` (one cfg-gated injection point),
`src-tauri/src/lib.rs` setup only (one cfg-gated call to `dev_trace`; no new command, no handler
change, no `std::env` in `lib.rs`); new `test/packaged_bundle_variant.ts` (classifier modeled on
`township-tauri-shell/test/packaged_bundle_variant.ts`); a new Rust test under `src-tauri/tests/`.

Why a plain seeded `CarrierKeySeedStore` does not work, and what replaces it: `PreviewStore::open`
returns `missing_local_history` when a key is loadable but the record has neither a public key nor an
intent, so a store that always returns the seed fails on first launch. A store that returns `None` until
`save_seed` makes `NativeCarrierSigner::ensure_key` generate a random key, save it, and return that
random public key, so the persisted public key would not match the seed and `commit` would fail with
`identity_mismatch`. The seam is therefore explicit, in `preview.rs`, cfg-gated, with its own tests:

- `PreviewStore` gains, under `#[cfg(feature = "treehouse-dev-trace")]`, an optional dev seed
  (`at_directory_dev(directory, seed)`). `loaded_key()` returns the seeded key only when the stored
  record already holds a public key or an intent (the same condition `open` uses for
  `missing_local_history`), so first launch reports `absent`. `initialize()`, after its existing intent
  checks (kind `space` or `join`), derives the public key from the seed directly instead of calling
  `ensure_key`, so no random key is generated and nothing is written to the Keychain or a seed store.
  `sign`, `open` and `commit` then see a key that matches the persisted public key, including after
  restart.
- `dev_trace.rs` reads `TREEHOUSE_DEV_DATA_DIR` (store directory, so two instances never share SQLite,
  the identity lock, or the Keychain alias), `TREEHOUSE_DEV_CARRIER_SEED` (the 32-byte test seed), and
  optional `TREEHOUSE_DEV_TRACE_FILE` (command-name lines, no payloads), and builds the store.
  Seeds are test constants derived from the Sim seed; they never leave env and are never uploaded.
  Without the feature, none of this code or its marker strings exists in the binary.

RED: Rust tests with the feature on: first launch `open()` with a seed returns `key_status: absent` and
not `missing_local_history`; `initialize` yields exactly the seed's public key and writes nothing to a
key store; the commit that persists that key succeeds (no `identity_mismatch`); after reopen the key is
`available`; `join` and `space` intents both work; two stores in two directories with two seeds hold
different keys. Ordinary-build proof: a binary string scan of the ordinary release binary finds none of
the dev-trace marker strings (this replaces a vacuous feature-off Rust test), and the bundle classifier
test classifies the variant bundle and not the ordinary one.

```
cd clients/treehouse-tauri-shell && node test/product_contract.mjs && npx tsx test/packaged_bundle_variant.ts
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --features treehouse-dev-trace
```

**5c0. Accessibility transfer spike and decision gate G-AX.** This is the highest-risk item, so it runs
first, on the ordinary build, before any harness work. It has no dependency on 5a or 5b: it uses the
existing `Write a post` textarea.

Facts that make this a real risk: the helper (`packaged_accessibility.swift`) supports only `dump`,
`press` and `set`; `set` types through a single `CGEvent` `keyboardSetUnicodeString` posted to the pid;
the only strings driven so far (`packaged_preview.ts`) are under about 30 characters; the three
artifacts are multi-KB (an offer carries a Space replica, up to three Thread replicas and routes); the
Township smokes do not drive their UI this way (they use a build-time env handoff and a trace file);
and the Tauri capabilities are pinned to `core:default` with no clipboard plugin, so a copy button's
clipboard write from an `AXPress` is unproven.

Spike (a timeboxed ticket): launch the ordinary bundle by spawning `Contents/MacOS/treehouse-tauri-shell`
directly (as `packaged_preview.ts` does), then, by pid, test transfer methods against an 8 KiB string
into the post textarea and read it back through `dump`: (1) a direct `AXValue` attribute set;
(2) chunked `set` key events of bounded UTF-16 length; (3) `pbcopy` plus a posted Cmd+V key event to the
pid. For reading artifacts out, the design already prefers a read-only textarea per artifact whose value
the harness reads from the dump (2c). Add the winning method as a `paste` or chunked `set` mode in the
helper. Pass criteria: 20 repeats of 8 KiB round-trip byte-exactly, locally and then on the hosted
runner inside the first 5c2 run.

Decision gate G-AX (recorded in TDD evidence): if no method passes by the end of the timebox, or the
hosted run fails, the harness switches to a named fallback with its own claim wording.
- Fallback: a dev-trace-only artifact mailbox. The variant webview polls a loopback HTTP mailbox hosted
  by the harness (the harness is the server; the app is only a client, so CD1 stays closed) and posts
  copy-out artifacts to it; the harness drives the button actions the same way. This needs
  `http://127.0.0.1:*` in the overlay CSP and adds no Tauri command.
- Claim wording under the fallback, added verbatim to the permitted sentence and to the required
  non-claims: "artifact transfer and button actions between the instances were driven through a
  dev-trace loopback mailbox, not accessibility or paste input", and "no proof that the real
  copy, paste and accessibility path transfers artifacts".
- The 5c1 oracle, relay, instances and assertions are unchanged under either path.

**5c1. Packaged harness and oracle wiring.** Files: new
`clients/treehouse-tauri-shell/test/packaged_enrollment.ts`, extend `test/support/relay_peer.ts` and
`test/support/packaged_accessibility.swift` with the G-AX winning mode, `package.json` (script
`packaged:enrollment` and a dev-trace build script).

Build command (variant, no stale bundle), defined in `package.json` as `tauri:build:dev-trace`:
`VITE_TREEHOUSE_ENROLLMENT=1 VITE_TREEHOUSE_DEV_TRACE=1 VITE_TREEHOUSE_AUTOSYNC_ON_MOUNT=0
VITE_TREEHOUSE_POLL_MS=0 tauri build --features treehouse-dev-trace --bundles app --config
src-tauri/tauri.dev-trace.conf.json`. The webview does not see Rust env, so every flag the UI needs is a
build-time `VITE_*` value.

Launch and stop mechanics: spawn `Contents/MacOS/treehouse-tauri-shell` directly with the dev-trace env
(not `open -n -W --env`, and not `osascript` `quit`). With two instances of one bundle id, `quit app
id` is ambiguous and `open` does not return the pid that the accessibility helper needs. Spawning
yields the pid, env control and SIGTERM, as `packaged_preview.ts` already does in CI. Address
accessibility by pid and stop each app by pid (SIGTERM, then SIGKILL after a bound). The relay is
spawned as a subprocess by the harness.

Which steps use manual Sync and which rely on the live feed: autosync on mount and the poll are off in
the variant, so every convergence step in steps 4 to 10 and 14 uses an explicit Sync, except steps 11
and 12, which assert the live subscription (no Sync pressed).

Each convergence step asserts both an accessibility-dump text match for the other party's post and
equality of the store id sets (read from the instance's SQLite by `sqlite3`, read-only, as
`packaged_preview.ts` does) with the relay's pulled frontier (read by the harness's own observer
client over the real socket).

Harness script:

1. Preflight: assert the data dirs and temp root are under the workspace, realpath-resolved, no
   group or other write bit on the chain; assert no `~/Library/Application Support/dev.treetop.lattice.treehouse`
   pollution; build the variant once (command above); assert the bundle classifies as dev-trace.
   (The ordinary bundle is classified in `packaged_macos`; see 5c2.)
2. Launch founder (data dir F, seed): create group and one Thread locally. Read the replica strings
   from the founder's SQLite.
3. Write fixture logs and the hand-written manifest under the realpath temp root; trusted peers
   founder, joiner, observer; relay realms founder on the Space route and founder plus joiner on the
   Thread route; boot `pilot_node.exs` on fixed ports. Admission was pre-seeded here, not enrolled.
4. Founder: paste the route list, press Sync. Assert the observer pull holds the founder's genesis ids
   and equals the founder store ids.
5. Founder negatives: paste a Township pairing handoff into the offer field (`wrong_product`); a route
   with a wrong `expectedPeerPubkey` is refused at Sync. Assert revision and frame counts unchanged and
   `acked` unchanged.
6. Launch joiner (data dir J, seed): Join a group, read the join request. Joiner negative: paste the
   join request into the offer field (`wrong_artifact`), unchanged state.
7. Founder: paste the join request, Issue invitation, Sync, read the offer.
8. Joiner: paste the offer, Use offer (review shows the disclosure and the pinned realm and key),
   confirm, Sync, assert the joiner store holds the Space ids equal to the relay's; replay the same offer
   (idempotent, no revision change); Accept invitation, read the acceptance. Founder negative: paste the
   acceptance with one flipped signature byte (refused, unchanged).
9. Founder: paste the real acceptance, Admit and grant, Sync.
10. Joiner: assert the Post button is disabled before the grant is visible; Sync; assert the grant is
    visible; Post; Sync.
11. Live feed, founder: do not press Sync; with the poll disabled, assert within 30 seconds that the
    joiner's post is in the founder's store and accessibility dump. Founder posts a reply and presses
    Sync.
12. Live feed, joiner: do not press Sync; assert within 30 seconds the reply arrives.
13. Restart and heal: snapshot the relay log file hashes and id lists and both stores' id sets and
    pids. SIGTERM both apps, `kill -9` the relay. While the relay is down, relaunch the joiner with the
    same data dir, assert its store ids equal the snapshot before any Sync (restart recovery without
    the network), and Post offline. Respawn the relay on the same ports and logs and assert the same
    ids and a changed relay pid. Relaunch the founder, read its store before Sync (ids equal the
    snapshot). Sync both; the joiner's offline post drains; assert convergence on both.
14. Oracle: `treehouse_enrollment_oracle.exs` compares relay logs, both SQLite stores and a fresh
    observer pull against the post-hoc `Lattice.Sim` replay driven by the harness's observed trace,
    under the comparison rules of Slice 4 (ids both directions, byte-equal frames, canonical state,
    exact reasons), and runs its negative controls. Assert no relay or observer authorship, `acked`
    equals retained ids, and pending is zero. Run the hygiene scans in Trust and oracle invariants.

**5c2. CI job and structural contract test.** Files: `.github/workflows/flagship.yml` (new job; plus one
add-only classification step in `packaged_macos`), new
`clients/treehouse-tauri-shell/test/enrollment_ci_contract.mjs` (appended to `npm test`, modeled on
`township-tauri-shell/test/mobile_core_native_ci_contract.mjs`). The existing precedent for workflow
contract tests is a JS test that parses job blocks, not an Elixir test.

CI job `treehouse_packaged_macos_enrollment` (sibling of `packaged_macos`; the new job is not added to
`android_pilot.needs`, because the existing `android_pilot_signing_contract.mjs` pins that list with a
`deepEqual`, and editing a pinned test to add it is out of scope; it fails the workflow run by itself):

1. `runs-on: macos-15-intel`, bounded `timeout-minutes` (start at 90), no `continue-on-error`, no
   platform skip, checkout with `persist-credentials: false`, pinned action SHAs copied from
   `packaged_macos`.
2. Same toolchain: setup-beam OTP 28.1 and Elixir 1.19.5, Node 22 with the lockfiles of
   `lattice-client` and the Treehouse shell (no `lattice-mobile-core`, decision 10), Cargo registry and
   target cache whose key hashes the Treehouse shell sources, `env MIX_ENV=test mix deps.get` and
   `env MIX_ENV=test mix compile` (the `env` prefix avoids actionlint SC2209), `npm ci` for
   `lattice-client` and the Treehouse shell, then `npm --prefix clients/lattice-client run build`.
3. A fresh variant build (no prebuilt stale bundle) and `npm run packaged:enrollment`. The job runs in a
   runner state with no `~/Library/Application Support/dev.treetop.lattice.treehouse`; order and
   cleanup are explicit.
4. `if: always()` upload of public evidence only: oracle JSON with op ids, verdicts, counts. No seeds,
   offers, join requests, acceptances, post text, keys, or SQLite files. This is the only step allowed
   an `if`.

Ordinary-bundle classification: the ordinary Treehouse build lives only in `packaged_macos`, and the
new job builds only the variant. Add one add-only step to `packaged_macos`, after its existing ordinary
build, that runs the bundle classifier plus the binary string scan on the real ordinary bundle and
asserts it is not dev-trace. Existing `packaged_macos` steps are not edited; their bodies are pinned by a
committed digest (below), and `runtime_wiring_contract.mjs` is unaffected by an added step.

Merge-blocking: this job fails the workflow run on a pull request. Whether it is also a required status
check is branch-protection configuration, which is an operator setting outside this plan (open question
2). Do not claim it is merge-blocking beyond failing the run.

Contract test (RED first, fails while the job does not exist), structural not textual: parse the job
and its steps; require the runner label, the build command with `--features treehouse-dev-trace` and
the four `VITE_*` flags, `npm run packaged:enrollment`, the oracle step, `timeout-minutes`; reject any
job or step `if` other than the `always()` upload step; reject `continue-on-error` in any spelling
(`true`, `${{ always() }}`), `|| true`, `set +e`, `if: false` and `if: ${{ false }}`, and skip env vars;
pin a committed digest of the `packaged_macos` step bodies other than the added classification step;
assert `android_pilot` `needs` is still the existing four jobs; and run mutation fixtures (mutated YAML)
that must each fail the contract, as the precedent does. A text check alone is not feasibility proof;
the hosted job must finish green.

Note: the workflow path filter ignores `docs/**` and `**/*.md`, so a plan-only change will not run the
job; the first hosted proof needs the source-bearing tip.

### Slice 6: Roadmap, ledger and docs

Files: `plans/README.md` (append-only row 181; do not edit protected rows 121, 122, 178),
`plans/roadmaps/treehouse-unified-2026-09-06.md`,
`plans/158-real-device-beta-poc-program-map.md` (appended scoped note under the R01a amendment only),
`docs/research/evidence/treehouse-roadmap-integration-20260907.md` or a new dated evidence record,
`CLAUDE.md` (narrow non-claim note only), this plan, new
`apps/lattice_core/test/treehouse/r13_lite_contract_test.exs`.

Edits: a new ledger sub-row "R13-lite | Hand-configured-route enrollment and sync / product | L | High |
R01b, R08, R10, R12 (not R11) | Packaged two-instance invite, join, post, converge, restart, converge,
Sim-equal, hard CI job | PLANNED" placed beside the R13 row (line 82); R13 stays PLANNED with an added
"R13-lite evidence does not close this row" clause and an unchanged Requires column; a scoped note about
plan number 181 under line 7; an Execution evidence row for R13-lite (tip, PR, exact-tip run, merge
run, tree match, tier Packaged desktop, remaining gates); an "Evidence completed" claims-table row with
the permitted sentence; the carve-out paragraph in the integration evidence record; and an evidence line
quoting the operator direction verbatim (chat, 2026-10-07): "R13-lite first (recommended). Build
enrollment and sync for the Treehouse shell against one hand-configured relay route, the way the
Township shell already does it, and defer catalog replacement to R11c." Do not edit Plan 177, Plan 178,
`treehouse_one_pager.html`, or `toolshed_one_pager.html`.

RED: `r13_lite_contract_test.exs` fails first and then pins: the permitted completion sentence verbatim
(the whole sentence, including the test-variant, fixture-relay and pre-seeded-admission clauses, so the
qualifications cannot be quoted away); every required non-claim verbatim; none of the prohibited
phrases (`nothing hosted`, `serverless`, `no server to`, `nothing to seize`, `use-limited`, `does not
orphan`, `zero server dependency`, `guaranteed availability`, `there is no landlord`, `uncapturable`,
`ttl'd`, `no registry to scrape`, `cannot be deleted, paywalled`; also avoid `decentralized`,
`centerless`, `host mode`, `self-hosted by members`), the wording "two instances" and never "two
devices", "two packaged apps", "separately packaged" or "native-custody identity", "operator hand-configured
route" and never "provisioned" (the sentence itself says "routes are not catalog-signed, provisioned,
staged, sealed, admitted-service-bound or replaceable", and the scan excludes that quoted negation), and
zero em dashes in this plan. The phrase scan covers the Completion claim section, the ledger and
evidence rows, the enrollment-build `App.vue` copy and the README row; it must exclude the
prohibited-phrase list quoted in this paragraph.

```
~/.asdf/shims/mix test apps/lattice_core/test/treehouse/r13_lite_contract_test.exs apps/lattice_core/test/treehouse/contract_test.exs apps/lattice_core/test/township/audit_bundle_test.exs apps/lattice_core/test/township/read_model_test.exs
grep -c $'\xe2\x80\x94' plans/181-r13-lite-treehouse-enrollment-sync.md   # must print 0
```

## Trust and oracle invariants

1. The Sim comparison is on op ids (both directions), byte-equal frames including signatures, canonical
   state, and the exact honored or quarantine reason map, not on carrier return values. Because
   Treehouse frames decode neutrally under Township decoders without failing loudly, projections used
   for comparison must be computed with `treehouseCommandDecoders`.
2. Oracle input is an observed trace of per-authoring sync points, produced by the gate. The gate
   asserts convergence before every authoring step. The oracle derives deps only from `Lattice.Sim` and
   never from shell frames or stores. A dep-perturbation, a dropped id and a changed frame byte must
   each make the oracle fail.
3. Native signing, the dev-trace store and key, the actual packaged bundle, the real WebSocket
   carrier, the manifest-booted relay and the Sim oracle may not be replaced by mocks in the packaged
   job. The in-memory native adapter is allowed only in Slice 4's headless gate and is named as such.
4. Persist-before-ack: no frame is marked `acked` before the relay's persisted acknowledgement, and the
   ack rules are decision 2 (relay buckets `accepted` and `quarantined` ack; `rejected` and `pending`
   never ack).
5. A joiner post is valid only under a root-issued, correctly parented delegation that the relay has
   delivered before or causally under the post. Quarantine is asserted identical, with the exact
   reason, across both clients, the relay report and Sim.
6. Wrong product, recipient, replica or server input changes no durable state.
7. Secret hygiene is split by surface. Seeds, private keys and bearer secrets must be absent
   everywhere: stores, relay logs, trace file, uploaded evidence. Post text is intentionally present in
   frames, stores and the plaintext relay log, so it must be absent only from the trace file and the
   uploaded evidence. The Treehouse-local `secret_scan.ts` scans JSON field names (a secret-field
   pattern) plus planted needles, runs over the new v2 record, and has a positive control that proves
   it detects a planted needle.

## Public TDD seams

1. `Treehouse.EnrollmentVectors` (test support) and the TS `treehouse_enrollment` module (Slices 1a and 1b).
2. `treehouse_route_boot_test.exs` (Slice 0).
3. `treehouse_state.ts` and `preview.rs` v2 record and join lifecycle (Slice 2a).
4. `TreehouseWorkflow` enrollment actions (Slice 2b).
5. `syncCarrierOnce` `commandDecoders` option and `syncTreehouse` (Slice 3).
6. `gate:enrollment` and the oracle script (Slice 4).
7. `product_contract.mjs`, the bundle classifier, `packaged:enrollment` and
   `enrollment_ci_contract.mjs` (Slice 5).
8. `r13_lite_contract_test.exs` (Slice 6).

## Scope

In: the files named per slice; one hand-configured route set (the Space plus at most three Threads,
at most four routes); posting over the relay; invite, join, admit-and-grant; restart recovery; one
offline-post-drains case; the hard-failing macOS job.

## Non-goals and non-claims

- No catalog trust, signed catalog, provisioning saga, or lifecycle reconciliation. No R11a, R11b or
  R11c claim. No relay replacement, rollback or reseed; if the relay identity or path changes, these
  apps cannot adopt the replacement. The routes are not catalog-signed, provisioned or replaceable,
  and they are not staged, sealed or admitted-service-bound.
- Transport admission is not enrolled. The joiner's transport key was pre-seeded in the hand-written
  manifest before the relay booted; the flow enrolls only semantic membership and Thread grants.
- R13, R14, R15 and R16 remain open. Four-socket fairness, visible-priority scheduling, a full-history
  sync action and the 12-Thread and 4,000-op latency workload are not claimed. A Space with more than
  three Threads, archived ones included, cannot issue an invitation in the lite shell (it refuses with
  `thread_scope_exceeds_routes`); archived Threads stay in the invitation scope, and nothing is claimed
  about new members reading them.
- No members, roles, removal, renewal, pinning, transfer, edit or tombstone over the relay (only post is
  claimed), no witnesses (R17, R36), no rollover.
- No QR, camera, deep link or cold-start link; offers move by paste (or the G-AX fallback mailbox). No
  physical device, Android or iOS claim; no device custody or protected witness; the generic
  `sign_carrier` signer is not a domain-separated custody claim; no Keychain custody for the test
  variant.
- Enrollment UI exists only in the dev-trace test variant build (decision 11). The ordinary and Android
  builds stay local-only.
- No founder-loss survival claim (AF-2 stays qualified, Plan 178 pinned sentence). No E2EE and no
  recovery.
- No CD1: the app does not host, spawn, bundle or listen for a carrier, and no LAN advert or discovery
  is added; Plans 072 to 075, 110 to 114 and 150 to 152 stay as they are. Slice 5a adds text pins for
  this.
- No production or WSS deployment, no pilot, no Phase G or G1 completion, no receipt-free W4, no server
  push beyond Plan 132's availability hint, no availability guarantee, no background delivery.
- The relay stays plaintext-readable to its operator and anyone with its host, backups or admitted
  transport peers, and the host can withhold availability.
- The packaged macOS relay is the dev/test `pilot_node.exs` fixture with the darwin directory-sync
  approximation and an ephemeral-port opt-in. No durable-ack claim is made on macOS; the Linux Slice 4
  gate is the only durability evidence. The harness stop and `kill -9` paths are test-only, produce no
  stop seal, and claim no controlled-stop semantics.

## STOP conditions (stop and report, do not widen scope)

- Slice 0 happy path fails and needs a server source change: stop, write the guard analysis, get an
  operator-reviewed decision before touching `manifest.ex`, `runtime.ex` or `priv/*.exs`.
- The app would host, spawn, supervise or bind anything, or the relay key authors an op.
- Any catalog, R11b or R11c language or code path appears, or a route could be replaced.
- A private key, seed, or bearer secret appears in an offer, request, acceptance, log, trace or upload.
- Any existing pinned test (Plan 178 contract, protected README rows, `read_model_test.exs`,
  `audit_bundle_test.exs`, `packaged_preview.ts` literals, R12 oracle `recovery_not_ready`,
  `android_pilot_signing_contract.mjs`) must be edited to pass, other than the explicit Slice 5a
  amendments listed above.
- CI goes green only via skip, `continue-on-error`, a prebuilt stale bundle, mocked native IPC, a
  Township-decoded comparison, or a weaker Sim comparison (for example comparing structure without op
  ids because Sim cannot reproduce the shell's replica strings or deps, or copying deps from shell
  frames into the oracle). Report the specific mismatch to the operator instead.
- Slice 1b shows TS-authored op ids cannot equal BEAM ids for the same inputs for a reason other than a
  fixable dependency-selection difference.
- Both G-AX transfer paths (accessibility and the named mailbox fallback) fail on the hosted runner.
- The hosted runner cannot launch the real WKWebView app.
- Relaxing the Rust commit invariant beyond the additive `acked` set and the join lifecycle in 2a looks
  necessary.
- Any prohibited phrase, or an em dash in a new plan file.

## TDD plan

1. Slice 0 characterization and mutations; Slice 1a and 1b vector, parity and negative tests; confirm
   each RED fails for the stated reason. The Slice 0 test is not RED and is not described as such.
2. Run the G-AX spike (5c0) early, in parallel, so the highest-risk item is decided before the rest of
   Slice 2c and Slice 5 are built.
3. GREEN per slice in the order of the ticket table, keeping each slice's focused commands green before
   the next.
4. Hosted feasibility: Slice 5c2 job RED (the contract test fails with no job), then the job is added
   and must finish green at the exact tip.
5. Docs RED then GREEN (Slice 6).
6. Full verification below.

## TDD evidence

Recorded at the Slice 6 docs commit from the per-ticket reports and the commits named below. Base
`981d4225c`; implementation tip before the docs commit `f7b58c791`. Every slice except S0 shipped its RED
test and its implementation in one commit, not two, so the RED run is a recorded observation, not a
separate commit. Nothing here has run on a hosted runner.

| Ticket | Commit | RED observed (stated reason) | GREEN |
|---|---|---|---|
| S5a | `692e19a96` | pin amendments; mutation fixtures each failed the pin test, then were reverted | `product_contract.mjs` |
| S3a | `851e9126d` | decoder seam; RED and implementation share the commit | `npm run carrier:relay-sync` |
| S2a | `3e9fbe956` | v2 record, join intent lifecycle and `acked` set; v1 never written on open, v2 refused by the frozen v1 reader | shell TS tests, Rust `native_commands` and `storage_lifecycle` |
| S0 | `34b680db1` | characterization test, not RED (see below) | `treehouse_route_boot_test.exs` |
| S1a | `f048b5c98` | `UndefinedFunctionError` for `Treehouse.EnrollmentVectors.build/0`, 11 tests invalid | `enrollment_vectors_test.exs` |
| S1b | `1542c4196` | `TREEHOUSE_LITE_THREAD_CAP` was not exported (module absent) | `npm run treehouse` |
| S2b | `e8c11e5a2` | `TypeError: jApp.beginJoin is not a function` | `test/workflow.ts` |
| S2c | `88b7f2eee` | `enrollment build lacks label: Join a group` | `test/enrollment_ui_contract.mjs` |
| S3b1 | `37f53c456` | `ERR_MODULE_NOT_FOUND` for `src/treehouse_sync` | `test/sync.ts` |
| S3b2 | `2d82b1714` | `ERR_MODULE_NOT_FOUND` for `src/treehouse_feed` | `test/feed.ts` |
| S3c | `f38c4c951` | `ERR_MODULE_NOT_FOUND` for `src/treehouse_panel_sync`; `enrollment build lacks label: Sync` | `test/sync_panel.ts`, contract test |
| S4 | `80353246f` | `ERR_MODULE_NOT_FOUND` for `test/support/relay_peer` | `npm run gate:enrollment` |
| S5b | `50ed5f581` | seam and classifier absent; an always-loadable-key mutation failed all 7 seam tests | `cargo test --features treehouse-dev-trace`, `test/packaged_bundle_variant.ts` |
| S5c1 | `f5a389857` | `ERR_MODULE_NOT_FOUND` for `test/support/packaged_ax` (driver unit test) | `npm run packaged:enrollment` |
| S5c2 | `f7b58c791` | job missing, `packaged_macos` classification step missing, digest mismatch | `test/enrollment_ci_contract.mjs` |
| S6 | docs commit | `r13_lite_contract_test.exs`: 15 of 17 tests failed (no carve-out, ledger rows, README row, notes) | same file, plus the pinned contract tests |

Slice 0 results (characterization, `34b680db1`): the happy path booted, relayed and restarted with no
server source change, so the STOP contingency did not trigger. The discriminating mutations all fail as
designed: omitting the Thread instance fails the Thread route; a Space listener given a Thread challenge
refuses with `wrong_replica` (server-internal telemetry, pinned in process; the client sees
`unauthenticated`); a respawn against a log at a different path loses the Sim ids; deleting the log before
respawn refuses startup (`PILOT_REFUSED`) and recreates nothing. The existing refusals are pinned: dropping
`relay_realms` yields `read_only`, the joiner cannot relay to the Space route, and a manifest under the
unresolved macOS `/var` temp path is refused with the exact offender `"/var"`.

Slice 1b id-parity result: TS-authored frames are byte-identical to the BEAM frames, signatures included,
for all 79 vector steps across the 9 scenarios, built from the public synthetic seeds and the exact Sim
dependency frontiers. The acceptance signatures recomputed in TS also match. There was no
dependency-selection difference to fix and no STOP. A dependency perturbation and a flipped signature each
fail the parity assertion.

G-AX decision (recorded in the S5c1 commit, local macOS only): the paste method (pasteboard write, focus,
select-all, paste, addressed by pid) passed 20 of 20 byte-exact 8 KiB round trips into the `Paste offer`
textarea on every local run. The chunked UTF-16 key-event method failed at round 1 (same length, wrong text,
first difference at index 458) and was removed. Direct `AXValue` set was not tried because it would likely
not fire the input event that Vue's `v-model` needs. The loopback-mailbox fallback was not built and is not
used, so the fallback addendum to the permitted sentence does not apply unless the hosted runner fails the
paste transfer. The hosted runner's pasteboard, Accessibility permission and checkout-chain permissions are
unproven. At the Slice 6 docs commit the packaged run could not be reproduced: four attempts on this
machine (two full runs, two preflight-only runs) each failed the G-AX paste preflight, at rounds 17, 16,
4 and 4 of 20, with the readback the right length but differing at index 0 (the previous text was still
in the textarea or another text arrived). The macOS console session was not locked, and the frontmost
application afterwards was a browser, so the machine was in interactive use. The cause is undetermined;
pasteboard or focus contention is a candidate, and nothing was changed in the helper or the harness. The
earlier four passing runs are therefore reported but not reproduced, and the paste transfer is not shown
reliable even locally. The separate S5c0 ticket stopped without a commit (its attempt ran with the macOS
console session locked and no AX window); the decision data above came from the S5c1 runs on an unlocked session.

Corrections to the plan text found during implementation (the slice bullets above were corrected in place
where they named a wrong reason):

- A post under a capability whose op set lacks `post` quarantines `operation_not_granted`. `role_not_granted`
  fires only for a command that needs an authority role, pinned on the `archive_thread` vector.
- The relay never reports semantic quarantine. A semantically quarantined op arrives in the `accepted`
  bucket (`Log.accept` classifies structure only) and the exact reason comes from analysis of the pulled
  log. The `quarantined` bucket is structural only (`bad_signature`), and `rejected` is only
  `wrong_replica`. The ack rules in design decision 2 apply as written, but "reported quarantined" in
  Slices 0 and 4 means "accepted by the relay, quarantined by analysis, identical in both clients, the
  relay log and Sim".
- `createThread` cannot require a pre-configured Thread route, because a Thread replica string embeds a
  nonce and a key-bound root tag. The cap is enforced at `issueInvitation`
  (`thread_scope_exceeds_routes`), and `createThread` refuses `thread_cap_reached` at three honored Threads
  only when a relay is configured.
- The offer carries one `localRealm`, the joiner's transport realm; `issueInvitation` takes it as a second
  argument.
- The packaged scenario uses one Thread (two routes, 11 ops: 5 Space and 6 Thread); the wrong-artifact
  label is `wrong_product`; the wrong-key negative in the UI is the refused `relay_already_configured`
  route paste, while the hello refusal itself is proven headless over the real socket.
- The relay stop and `kill -9` paths are test-only. The packaged macOS run makes no durable-ack claim; the
  relay log bytes were unchanged across the restart in every local run, recorded as informational only.

## Independent review

An adversarial review of the exact diff is required before LOCAL VERIFIED (roadmap line 173).
Checklist for the reviewer: acked-set invariants and persist-before-ack ordering across the four relay
buckets; foreign-root verification by commitment; join intent lifecycle; grant parenting and
quarantine reasons; wrong-input no-change; CSP and pin amendments are minimal and exact; CD1 pins;
dev-trace seam absent from the ordinary binary (string scan and classifier); enrollment UI absent from
the ordinary bundle; no claim language beyond the permitted sentence; the post-hoc Sim oracle derives
deps from Sim only and its negative controls fail; the harness never reads app storage to drive the UI.

Disposition (2026-10-10; three Claude lenses plus a Codex second review): 27 findings, 0 fixed, 16 filed into
eight rows, 11 rejected. Rows are in `plans/README.md`.

- Fixed: none.
- Row 195: acks of own frames the relay reports quarantined (ack-on-nonserved-bucket), with the FakeRelay mismatch.
- Row 196: design question, one deadline and abort at the carrier-client boundary (unbounded-await, Thread 46).
- Row 197: a relay error reply aborts the whole route sync in `submitCarrierFrames`.
- Row 198: design question, one route and realm alphabet for TS, Rust and the CSP (validator-parity).
- Row 199: design question, one capability snapshot for the shell UI (ui-capability-gating, Thread 48).
- Row 200: four missing refusal messages in the enrollment panel.
- Row 201: the ordinary-versus-test variant is decided only by build env, with no packaged assertion.
- Row 202: packaged harness hardening (draft-textarea waits, store-only founder match, sqlite3 busy timeout).
- Thread 47 and L1-5: rejected, reachable only by a direct `treehouse_commit` call whose caller can already sign.
- L1-6: rejected, a deliberate tested design with a labelled cost and a capped 5 s redial.
- L3-1: not a defect, a wording constraint this closeout follows (exact-tip, partial and first-complete runs named as such).
- L3-2: not a defect, the closeout edits the status pins in the same commit and adds none.
- L3-3: refuted, ids, frames and stores are compared byte for byte and the reason map is checked against Sim.
- L3-4: refuted, the unmutated baseline is not rescued and all four controls fail by real comparison.
- L3-9: refuted, `result.json` holds only fixed non-secret fields.
- L3-10: rejected, a log-wording nit disclosed at the point of use and in this plan.
- L3-11: rejected, hardening of a source-text pin that rule 6 says not to extend.
- C1: refuted, the claim is Sim replay equals the relay logs and both stores, which the oracle checks.
- C3: refuted, direct-IPC only, and the proposed rule would break a member's second offer.

## Verification

Local, macOS, from the worktree root:

```
export ERL_FLAGS='+S 4:4' PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"
MIX_ENV=test ~/.asdf/shims/mix deps.get && MIX_ENV=test ~/.asdf/shims/mix compile
~/.asdf/shims/mix format --check-formatted
~/.asdf/shims/mix test apps/lattice_core/test/treehouse/ apps/lattice_carrier_server/test/
~/.asdf/shims/mix verify && ~/.asdf/shims/mix check
cd clients/lattice-client && npm run build && npm run carrier:relay-sync && npm run carrier:relay && npm run carrier:feed && npm run treehouse
cd ../treehouse-tauri-shell && npm run typecheck && npm test && npm run native:test && node test/android_contract.mjs && npm run gate:enrollment
cargo test --manifest-path src-tauri/Cargo.toml --features treehouse-dev-trace
# the Android preview job builds the same shell; its local-only behavior must be unchanged (flag off):
npm run build
# existing ordinary-app gate still green and separate (needs a clean account):
npm run tauri -- build && npm run packaged
# packaged R13-lite gate (variant build, no stale bundle; Accessibility permission granted to the terminal):
rm -rf src-tauri/target/release/bundle/macos/Treehouse.app
npm run tauri:build:dev-trace
TREEHOUSE_EVIDENCE_DIR="$TMPDIR/treehouse-enrollment" npm run packaged:enrollment
cd ../.. && actionlint .github/workflows/flagship.yml   # if installed; the repo does not run actionlint in CI
```

The hosted jobs that must stay green alongside the new job: `unit`, `verify`, `packaged_macos`
(including its added classification step), and `treehouse_android_preview` (the same shell, flag off).

Run the ordinary `packaged` step and `packaged:enrollment` on a clean account, or reset
`~/Library/Application Support/dev.treetop.lattice.treehouse` between them; the variant uses its own
data directories and must never touch that path.

Exit evidence (all required): the Slice 0 to 4 focused commands green locally; a local
`packaged:enrollment` run showing the 14-step script, the oracle verdict with equal op ids, frames,
state and verdicts and its negative controls failing as expected, zero relay or observer authorship,
acked equal retained, pending zero; the hosted `treehouse_packaged_macos_enrollment` job green at the
exact tip and at the merge result with `packaged_macos` green; the independent review findings and
dispositions; base, PR and merge SHAs, changed files, named tests, tier achieved (Packaged macOS CI) and
limitations recorded in the roadmap evidence table.

## Risks

- Accessibility transfer of multi-KB artifacts is the largest unknown (G-AX, 5c0). It is spiked first,
  with a named fallback and fallback claim wording.
- Two-instance isolation is the second unknown. Sharing the real Keychain alias or the real
  Application Support directory would make "join" meaningless; the variant seam and the classifier
  exist to prevent that, and the claim names the mechanism.
- Exact Sim equality depends on TS and Sim agreeing on genesis bodies, replica strings and dependency
  choice, and on deterministic sync points. Slice 1b is the early feasibility proof; do not defer it.
- Two Tauri builds per CI pipeline (ordinary in `packaged_macos`, variant in the new job) strain the
  budget; keep the new job a sibling and share the Cargo cache key.
- Preview-store changes touch the safety-relevant commit invariants; keep `acked` additive, keep the
  join lifecycle narrow, and keep `storage_lifecycle.rs`, `native_commands.rs` and the mobile-core
  native tests green.
- Sync merge races with user posts; all writes go through the one serialized queue with CAS.
- `carrier.ts`, `preview.rs`, `authority.ex`, the workflow YAML and native shared state are
  single-writer files per roadmap rules; other branches (R11a, R36) may touch them, so rebase before
  each slice.
- Overclaim risk: do not write "enrollment done", "R13 complete", "two devices", "catalog-backed",
  "provisioned" or "operator-run relay"; use only the permitted sentence.
- Invitation scope is pinned to the current Thread set, archived included; creating a Thread after
  issuing invalidates it, so the flow orders create Thread, then invite.

## Completion claim

Permitted statement, to be used only after the full exit evidence above: "Two instances of one
dev-trace test-variant macOS Treehouse bundle, each with a directory-isolated store and a seeded
in-memory test key (not Keychain custody), complete invite, join, post, converge, restart, converge
against one CI-launched pilot_node.exs fixture relay (loopback, macOS directory-sync approximation)
whose Space and Thread routes were configured by hand in a manifest; only semantic membership and
Thread grants are enrolled in the log, and transport admission of both instances was pre-seeded in that
manifest; the final op ids, frame bytes, state and verdicts equal Lattice.Sim. The relay operator and
anyone with its host, backups or admitted transport peers can read the plaintext log, and the host can
withhold availability; the relay cannot decide semantic authority or erase device-held history. The
routes are not catalog-signed, provisioned, staged, sealed, admitted-service-bound or replaceable.
Desktop macOS CI only."

If the G-AX fallback is used, the sentence additionally carries: "artifact transfer and button actions
between the instances were driven through a dev-trace loopback mailbox, not accessibility or paste
input".

`r13_lite_contract_test.exs` pins that exact wording inside the permitted sentence itself, so the
qualifications ("test-variant", "not Keychain custody", "fixture relay", "pre-seeded", "macOS
directory-sync approximation") cannot be separated from the claim. The ordinary app's Keychain path
stays covered only by the existing single-app packaged step.

Required non-claims, stated verbatim in the evidence record: no catalog replacement and no R11b or
R11c; no relay replacement or reseed; routes are not staged, sealed or admitted-service-bound; joiner
transport admission was pre-seeded in the hand-written manifest, with no enrollment-driven or dynamic
transport admission; no durable-ack claim on macOS, durability evidence is the Linux gate only; the
harness stop and kill paths are test-only and claim no controlled-stop semantics; no Keychain custody;
enrollment UI exists only in the test-variant build; R13, R14, R15 and R16 remain open; no QR, camera
or deep link; no physical device, no Android, no iOS; no protected witness or custody (R36, R17); no
founder-loss survival (AF-2 stays qualified, Plan 178 pinned sentence); no production or WSS
deployment, no pilot, no Phase G or G1 completion, no receipt-free W4, no availability guarantee, no
background delivery, no E2EE.

## Open questions for the operator

1. Should the ordinary (and Android) Treehouse builds expose enrollment and relay UI? The plan's default
   is no: build-flag gated, test variant only, so the R12 local-only exit, CSP and `Local preview`
   label stay honest. Exposing it later needs a wss CSP decision and an honest relabel.
2. Answered (2026-10-10): `treehouse_packaged_macos_enrollment` is already in the `required` fan-in of
   `flagship.yml` from plan 183, so the workflow fails without it; making `Required checks` a required
   status check in branch protection is the operator's step.

## Appendix: Review disposition

Each finding of the 2026-10-07 review was verified against the code. All were accepted in whole or in
part; the note says what was applied or why part was not.

1. 5b seeded key: real (`preview.rs` `open`, `signer.rs` `ensure_key`). Applied: explicit cfg-gated
   injection in `preview.rs`, `dev_trace.rs` builds the store, RED tests, `preview.rs` named as touched.
2. Join lifecycle: real (`initialize`, `commit`, `parse` and the `creation_incomplete` branch are all
   `space`-only, and `commit` hard-codes version 1). Applied in 2a with `native_commands.rs` listed.
3. Circular dependency: real (`normalizeCarrierPeerConfig` is in mobile-core, which depends on
   lattice-client). Applied: no route handling in `lattice-client`; shell-local `treehouse_routes.ts`.
4. mobile-core CI breakage: real for the dependency as drafted. Applied by avoiding the dependency
   (decision 10), so no `flagship.yml` edits for it are needed.
5. Linux `/tmp`: real (`manifest_path_permissions`). Applied as constraint 5, Slice 0 and Slice 4.
6. AX transfer risk: real (helper supports `dump`, `press`, `set` only; strings under 30 chars so far).
   Applied: Slice 5c0 spike, read-only textareas, named decision gate G-AX with claim wording.
7. Launch mechanics: real. Applied: spawn the binary directly, address by pid, stop by pid.
8. `EnrollmentVectors` location: real. Moved to `test/support`.
9. Cited reuse items: real (`submitCarrierFrames` private; `beam_peer.ts` helpers unexported, line
   anchor wrong). Corrected; anchors are now by symbol; spawner marked new.
10. Non-existent statements: real ("remote delivery" and the "ledger recorded gap" are not in the repo).
    Applied: quoted the real App.vue string; the gap is cited as the actual `test/treehouse.ts` fact.
11. Mis-sizing: real. Header corrected to seven slices and 17 tickets; S1, 3b and 5c split.
12. Autosync contradiction: real. Applied: build-time `VITE_TREEHOUSE_AUTOSYNC_ON_MOUNT` and
    `VITE_TREEHOUSE_POLL_MS` flags in the variant build; steps labelled manual versus live.
13. CI wiring: real. Applied: classification add-only step in `packaged_macos`; `.mjs` structural
    contract; merge-blocking left to operator branch protection (open question 2).
14. Governance citations: real. Line 45 quoted accurately; R01b added to the header.
15. Completion sentence wording: real. Sentence rewritten and pinned verbatim by the contract test.
16. Relay fixture claim: real (`pilot_node.exs` approximation flags). Sentence and non-claims updated.
17. Transport admission overclaim: real. Non-claim added; joiner dropped from the Space route
    `relay_realms`, kept in `trusted_peers`.
18. Archived Threads: real (`thread_scope` has no archive filter). Applied: decision 7, the
    `thread_scope_exceeds_routes` refusal, RED tests, reworded non-goal.
19. R11 waiver: real (Plan 158 item 3 says "R11", not "R11c"). Waiver reworded to the whole R11 edge;
    R11a-era dependence stated; operator direction quoted in Slice 6.
20. CD1 and offline pins: real. Applied: `websocket` relaxed only for named TS files, CD1 closure pins,
    UI and relay CSP gated to the variant, `treehouse_android_preview` added to Verification.
21. Disclosure copy: real. Fixed disclosure pinned in the 2c contract test, with realm and key shown.
22. `std::env` description and migration: real. Pin described as it is; migration is `parse`-only;
    byte-identical reopen tests added.
23. Guard honesty: confirmed no guard is weakened. Added the test-only stop sentence and the
    "not staged, sealed or admitted" non-claim.
24. Anchors and dependency completeness: real. Anchors by symbol; dependency-closed pull merge and a
    paginated partial-pull RED added.
25. Oracle deps: real (Sim deps are the author's frontier). Applied: observed per-authoring sync-point
    trace, await-convergence gate, Sim-only deps, dep-perturbation control.
26. acked/pending: real (`outbox` already exists per profile). Applied: decision 2 with precise sets and
    per-bucket RED.
27. Quarantine reasons: real (`not_holder` is not an authority reason). Pinned `no_capability` and
    `role_not_granted`, with the direct-authoring method for the grantless post.
28. Slice 0 RED: real. Renamed a characterization test; added discriminating mutations and wire
    negatives.
29. Converge and restart assertions: real. Applied: dump text plus id-set assertions, pre-kill snapshot,
    pre-Sync restart read, live-feed assertions with the poll disabled.
30. Packaged negatives: real. Added to the packaged flow and to Slice 4.
31. Ordinary dev-trace proof: real. Applied: classification in `packaged_macos`, binary string scan,
    and `cargo test --features treehouse-dev-trace` in the `unit` job.
32. New tests not run in CI: real. Applied: every new test is appended to an existing test chain.
33. CI contract test: real. Replaced with a structural `.mjs` modeled on the precedent, with mutation
    fixtures and a committed digest.
34. Secret hygiene: real. Split by surface, Treehouse-local helper, positive control.
35. Sim-equality exactness: real. Both-direction id lists, byte-equal frames, canonical state, reason
    map, negative controls.
36. Crash injection: real. Named the failing `native.commit` injection point, duplicate-resubmit
    behavior and the over-burst outbox case.
