# Plan 033: TS Tauri bridge for async key custody and storage (E1)

## Status

DONE.

## Objective

Move the TS client from fixture-only shell seams toward the recommended Tauri spine by supporting
async native signing and an invoke-backed key-value store. The JS library should not hold private
keys; it should be able to delegate signing and storage to shell commands.

## Scope

- Allow `CarrierSigner.sign` to return either `Uint8Array` or `Promise<Uint8Array>`.
- Make carrier-session challenge signing await async signers.
- Add `src/tauri_bridge.ts` with:
  - `createTauriKeyValueStore(invoke, opts)` implementing `LocalKeyValueStore`.
  - `createTauriCarrierSigner(invoke, opts)` implementing `CarrierSigner` with public-key bytes
    in JS and private-key signing delegated to a Tauri command.
- Keep the bridge dependency-free by injecting a Tauri-compatible `invoke` function; actual Rust
  commands remain shell work.
- Add a focused TS test that proves async challenge signing, key-value command wiring, signing
  command wiring, and use of the Tauri signer through the Township author-and-persist workflow.

## TDD Evidence

1. RED: `test/tauri_bridge.ts` imported missing `createTauriCarrierSigner` and
   `createTauriKeyValueStore`; `npx tsx test/tauri_bridge.ts` failed on the missing export.
2. GREEN: `CarrierSigner.sign` now accepts sync or async signatures, and
   `signCarrierChallenge` awaits async native signers.
3. GREEN: `tauri_bridge.ts` implements an injected Tauri-style `invoke` key-value store and carrier
   signer.
4. GREEN: `npm run tauri:bridge` proves async challenge signing, command argument wiring, namespaced
   key-value storage, and `authorAndPersistTownshipCommand` using the Tauri signer/store bridge.
5. REFACTOR: exported the bridge, added the package script, and wired the CI workflow step.

## Verification

- `npm run tauri:bridge`
- `npm run township:authoring`
- `npm run carrier:township:live`
- `npm run typecheck`
- `npm run conformance`
- `npm run canonical`
- `npm run carrier:township`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix format --check-formatted`
- `git diff --check`
- `PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix check`
- `cd apps/lattice_server && PATH="$HOME/.asdf/shims:$PATH" ~/.asdf/shims/mix sobelow --exit`

## Remaining Work

- Implement the corresponding Tauri Rust commands and platform key storage.
- Wire a Vue/Tauri shell to call this bridge against a live BEAM carrier realm.
