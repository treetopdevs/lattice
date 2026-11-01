# Plan 257: one workflow history capacity, and a sync that stops at it

## Status

DONE in [PR #199](https://github.com/treetopdevs/lattice/pull/199): 1 MiB kept
(D-130), the feed pauses a route at `full`, max-size gates in TS and native.
The native catalog owner's pre-install capacity check is carried by plan 245
PR 5 and PR 6 (rule 7), because neither exists yet. Row 300 implements the
exporter half: `CatalogEvidence.export/4` refuses `preview_storage_limit`
before writing.

## Problem

`PreviewState` keeps every profile's frames, outbox and acknowledgements in one
JSON record capped at 1 MiB (`HISTORY_BYTES` in `src/treehouse_state.ts` and
`src-tauri/src/preview.rs`). The catalog evaluators accept a page of up to 16 MiB
of artifacts and put no aggregate bound on Space and Thread histories, so a route
that native trust accepts can carry a history the workflow cannot hold. Even
hand-typed routes reach the cap through ordinary growth.

At the cap, `mergeSync` throws `preview_storage_limit` and writes nothing, which is
correct. The feed controller (`clients/lattice-shell-kit/src/sync/feed.ts`) then
treats that error like a transient relay failure: the worker reconnects with
backoff up to every 5 s, and every reconnect, hint and 60 s poll pulls the same
history again. The status reads "Relay feed reconnecting: preview_storage_limit",
although the relay is fine and nothing will change by retrying.

## Decision (D-130, adopting plan 261 D5)

Keep the existing storage architecture and its 1 MiB record for this milestone.
Do not shard the store now:

- Any store has a finite capacity, and other members can grow a history on the
  relay without limit, so an evaluator-side bound against workflow capacity is
  needed whatever the size. Sharding only changes the number.
- Sharding changes the IPC commit contract and the identity-commit path in
  `preview.rs` (`identity_lock`, one `kv_compare_and_set` on `HISTORY_KEY`), which
  plan 245 PR 5's trust-owner design depends on (`history_generation` is
  `PreviewState.revision`). That is a protected custody rewrite (rule 3), not an M
  slice.
- Every commit still serializes the whole state, so a larger record makes each
  post and sync slower unless the IPC changes too.

If the operator wants more capacity before R14, sharding is the follow-up and must
be its own plan.

## Scope

1. **Capacity is inclusive and identical on both sides.** A record of exactly
   `HISTORY_BYTES` is accepted by `parseState` and by the native `commit`; one byte
   more is `preview_storage_limit`, and the native record is unchanged after the
   refused commit. Exception: while `intent.setup` is present, native `commit`
   also reserves `THREAD_CREATION_RESERVE_BYTES` (131,072) and refuses above
   917,504 bytes; `parseState` does not apply that reserve. The native boundary
   test uses a space intent, so it pins the inclusive 1 MiB cap, not the setup
   reserve.
2. **The largest merge commits; the next step writes nothing.** A real two-device
   history (same key, `FakeRelay`) is merged through `mergeSync` with a local
   padding post sized so that the merged record is within one base64 step (4 bytes)
   of the cap. It commits and reopens; a post after it is refused. The same merge
   with one more padding step is refused before any write and holds none of the
   pull. Post text is stored as base64, so 4 bytes is the finest step a post can
   reach. The byte-exact edge is covered by item 1.
3. **A full store pauses the route.** The kit's `SyncHost` gains an optional
   `capacityReason` (Treehouse: `preview_storage_limit`). When a sync of a route
   fails with it, the feed marks the route `full` and cancels its worker. The refused
   merge writes nothing; earlier committed progress survives and history remains
   readable. A paused route gets no reconnect, no hint sync, no poll
   sync and no Space-triggered Thread sync, and a sync queued before the pause never
   runs. A Thread that must sync its Space first (no Space held yet) never retries a
   paused Space: it pauses as dependent, with a message naming the anchor, and never
   dials its own history. **Sync now** is the only retry: it restarts the paused
   workers, which sync once and pause again if the store is still full. A
   reconfigure clears the pause with the rest of the route state.
4. **Visible explanation.** The route label reads "Paused: this device's local
   storage is full", the route message names the reason, and the panel summary says
   that the refused merge writes nothing, earlier committed progress survives, and
   history remains readable. The
   existing `preview_storage_limit` message in `App.vue` still covers posting.
5. **Plan 245 amendment (rule 7).** PR 5's native owner computes the serialized
   post-import record (profiles with metadata, outbox and acknowledgements) and
   refuses `preview_storage_limit` before changing trust or profile state; PR 6's
   workflow acceptance tests use the adopted store limit. The large evaluator
   fixtures stay evaluator and exporter tests.

## Files

- `clients/lattice-shell-kit/src/sync/{host,feed}.ts`
- `clients/treehouse-tauri-shell/src/treehouse_host.ts`
- `clients/treehouse-tauri-shell/test/{storage,sync,feed}.ts`
- `clients/treehouse-tauri-shell/src-tauri/tests/storage_lifecycle.rs` (test only)
- `plans/245-treehouse-listed-route-acceptance.md`, `plans/261-two-ordinary-desktop-apps-real-relay.md`

No production Rust, codec, carrier, authority or workflow file changes.

## Gates

- `npm run typecheck && npm test` in `clients/treehouse-tauri-shell`
- `npm run typecheck && npm run check` in `clients/lattice-shell-kit`
- `cargo test --manifest-path clients/treehouse-tauri-shell/src-tauri/Cargo.toml --test storage_lifecycle`
- `~/.asdf/shims/mix verify`
- The new feed tests fail on the previous `feed.ts` (the pause test times out waiting
  for `full`; the queued-sync test sees the poll's sync dial), and pass with this change.

Evidence tier: unit and contract (rule 1). No packaged, device or relay field claim.

## Non-claims

- No larger capacity: the pilot still holds about 1 MiB of history across the Space
  and its Threads, on the order of a thousand short posts (a short post's frame and
  ids take about 700 bytes).
- No catalog owner capacity check yet: plan 245 PRs 5 and 6 still carry the native
  owner and shell halves. Row 300 is the exporter half only (plan 261 D5 names both).
- The `thread_storage_limit` check in `TreehouseWorkflow.command` (4,000 frames or
  8 MiB of one Thread) is unreachable under the 1 MiB record and is left as is.
- The refused merge does not save that round's acknowledgements, so a local post
  whose ack was in the refused merge stays pending even when the relay holds it.
  Acknowledgements committed in earlier rounds survive.
- No eviction, compaction or archive: R14 lifecycle work, not this plan.
