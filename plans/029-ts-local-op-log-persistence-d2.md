# Plan 029: TS local op-log persistence seam for shell storage (D2)

## Status

DONE.

## Objective

Give browser/phone shells a framework-neutral way to persist and reload the local semantic op log
used by Township authoring. The TS core must not choose platform storage, but it should own the JSON
op-log roundtrip and idempotent append behavior that future Tauri/Expo shells can back with their
own key-value store.

## Scope

- Add `src/local_log.ts` with:
  - `LocalKeyValueStore` (`getItem` / `setItem`) as the shell-provided seam.
  - `LocalOpLogStore` (`load` / `save` / `append`).
  - `createJsonLocalOpLogStore(storage, key)`.
- Reuse existing `integrate` for idempotent append by op id.
- Extend `npm run township:authoring` so W1 local ops are saved, reloaded, and then used to author
  the same resident `post` frame accepted by BEAM.

## TDD Evidence

1. RED: `test/township_authoring.ts` imported missing `createJsonLocalOpLogStore`; `npm run
   township:authoring` failed on the missing export.
2. GREEN: `src/local_log.ts` added the JSON key-value storage adapter and exported it.
3. DEBUG: the first test helper declared `MemoryKeyValueStore` below a top-level await use, causing
   a temporal-dead-zone `ReferenceError`; moving the helper above use fixed the test setup.
4. GREEN: `npm run township:authoring` proves save/reload roundtrip, authoring from the persisted
   local log, and idempotent append of the authored W1 post.

## Verification

- `npm run township:authoring`
- `npm run typecheck`
- `npm run conformance`
- `npm run canonical`
- `npm run carrier:township`
- `npm run carrier:township:live`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix format --check-formatted`
- `git diff --check`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix check`
- `cd apps/lattice_server && PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix sobelow --exit`

## Remaining Work

- Connect real shell key custody so user actions can sign without fixture seed keys.
- Wire a Tauri/Expo store to `LocalKeyValueStore` in the eventual shell.
- Persist pushable carrier frames/outbox beside semantic ops (**completed by plan 030**).
- Expand authoring beyond the W1 resident `post` scenario once additional shell flows exist.
