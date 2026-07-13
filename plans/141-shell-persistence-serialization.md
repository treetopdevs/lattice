# Plan 141: Serialize shell persistence (stop silent op loss)

## Status

TODO

## Priority

**P0 — confirmed silent-data-loss defect.** Blocks Plan 139 and further shell feature work.

## Findings this plan fixes (evidence)

1. **Non-atomic append.** `createJsonLocalOpLogStore.append`
   (`clients/lattice-client/src/local_log.ts:36-40`) and
   `createJsonCarrierFrameStore.append` (`:58-64`) are load → merge → save-whole-array over
   a shared KV key with an await point between load and save. Two interleaved appends lose
   one op (last save wins). `township.ts:288-289` additionally appends to the two KV keys
   non-atomically (crash between them → frame/op mismatch).

2. **Stale-snapshot whole-store overwrite (the severe case).**
   `township_sync.ts:157-203` loads ops+frames, performs a multi-round-trip WebSocket sync,
   then saves `synced.ops` and the compacted frames — both computed from the **pre-network**
   snapshot. Any op authored during the window is erased from both the local log and the
   outbox: never pushed, frame gone, permanently lost. `township_feed.ts:72-94`
   (`refreshTownshipFromCarrier`) has the same shape and runs from the **push-triggered
   feed controller**, i.e. precisely when new ops arrive, so it routinely overlaps user
   actions; until the next sync round-trips the frame back, `frontier(localOps)` misses the
   user's own op and their next command is authored concurrent with their previous one.

3. **No serialization in the shell.** `App.vue` uses independent per-action submitting flags
   and the feed controller runs unconditionally alongside them. The dev-trace deep-link
   routes (`action-*/use`, `action-*/sign`, `carrier/sync`) invoke the same flows without
   the UI's disabled-button guards; `signAcceptedGrantIntent` (Plan 138) sets
   `grantIntentSubmitting` but never checks it on entry.

4. **Corrupt KV silently wipes the store.** `load_values_file`
   (`clients/township-tauri-shell/src-tauri/src/lib.rs:332-341`) maps any JSON parse failure
   to an empty map; the next `kv_set` persists the empty state, destroying outbox, local
   log, and pairing. No fsync before the rename, so a crash can truncate the file and the
   app silently starts over.

## Objective

All reads-modify-writes of the workflow stores are serialized through a single writer; a
save can never overwrite ops appended after its snapshot was taken; corrupt KV surfaces an
error instead of persisting a wipe; every sign/sync entry point (including dev-trace) is
re-entrancy-guarded.

## Scope

### Included

- A single async mutex (or task queue) owned by the shell workflow layer wrapping every
  load→…→save sequence over the op-log and frame-outbox keys. Sync and feed refresh
  acquire it for their save phase and **re-load** the store before saving, merging their
  result with any ops/frames appended during the network window (content-hash ids make the
  merge a union). Alternative acceptable design: a compare-and-swap revision in
  `lattice_kv_set` with retry — choose one, not both.
- Make the op-log + outbox append a single serialized unit (both keys inside one critical
  section).
- Rust: `load_values_file` returns an error on parse failure; callers surface it; `kv_set`
  never persists an empty map over a non-empty file as a side effect of a load failure.
  Add fsync of the temp file before rename.
- Re-entrancy guards (`if (xSubmitting.value) return;`) on every sign/sync/submit function
  and on the dev-trace entry points.
- A regression test that **fails red first**: inject a KV store whose `get`/`set` yield to
  an interposed append mid-window; assert the interleaved op survives sync and feed
  refresh. A Rust test for the corrupt-KV path.

### Explicitly deferred

- Native secure-store changes, mobile custody, multi-process locking (single app process
  assumed, per existing scope).
- Outbox semantics changes (acknowledged-only compaction stays exactly as proven).

## Required gates

- New interleaving regression tests red before the fix, green after.
- Full local shell suites and packaged smokes green; hosted flagship green.
- No change to authored bytes, frame format, or custody boundaries.

## STOP conditions

- If serialization requires changing the `LatticeKvStore` public seam in a way that breaks
  the persisted-KV format, STOP and surface a migration note first.

## Non-claims

- No multi-device or multi-process concurrency claim; no new participant controls; no
  G1/Phase G or W4 claim.

## Likely files

- `clients/lattice-client/src/{local_log,township,township_sync,township_feed}.ts`
- `clients/township-tauri-shell/src/App.vue`, `src/township_actions.ts`
- `clients/township-tauri-shell/src-tauri/src/lib.rs`, `tests/native_commands.rs`

## Completion claim

Complete for this scoped increment when the interleaving tests pass and a corrupt KV file
produces a surfaced error, not an empty store.
