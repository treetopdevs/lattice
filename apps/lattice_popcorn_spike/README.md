# Popcorn OTP browser realm spike

Optional research target based on Lattice `af84459` and Popcorn main
`381a5d0e21fc1c853078457462537f0eec65db00`. Both npm and Hex are locked to
`0.4.0-next.0`. The published crypto runtime manifest identifies OTP **29.0.6**.

**Status: implemented and built; browser acceptance still pending.** Native realm,
host lifecycle, and native WebSocket proof tests pass. This environment denied the
local Chromium launch (`socket() EPERM`) and the supported cloud browser's local
URL (`ERR_BLOCKED_BY_CLIENT`). Neither establishes a browser runtime failure.
Do not upgrade the main README/paper's browser-BEAM non-claim until the real
browser gate below passes. See [verification.md](verification.md).

## Design adjustments

- `browser/` is a standalone Mix project. There is deliberately no top-level
  spike `mix.exs`; the umbrella discovers only direct child Mix projects. Its
  OTP 28 server build never imports the OTP 29 browser app or Popcorn.
- `scripts/shared.mjs` copies exactly four Lattice value modules into ignored
  generated sources: Identity, Canonical, Op, and Authority.Delegation. It does
  not fork the encoder or start the server supervision tree. Build preparation
  refreshes those files; `dist/build.json` records their hashes and asset hashes.
- A supervised `LatticeBrowser.Realm` registers as `LatticeBrowser.Bridge`.
  The page receives a fixed command facade, not Popcorn's VM/process API. Only
  the trusted host forwards server events. Commands and pending work are bounded.
- The BEAM process generates an ephemeral Ed25519 identity and signs a fixed
  `Lattice.Op` shape binding the message, tab ID, sequence, and capability ID.
  Private keys never cross this bridge. Persistence/key recovery is deferred.
- WebSocket envelopes and `Lattice.Gateway` remain unchanged. The test-only
  SignedEcho target independently recomputes the canonical bytes and verifies
  the signature **after** Gateway authorization. It rejects duplicate op IDs.
  This is a signing/transport proof, **not v2 delegation validation or log admission**.
  A v1 cap ID in the signed op is not a v2 authority chain, and the generated
  public key is not an authenticated account identity.
- Worker errors, bridge timeouts, queue overflow, socket failure, and explicit
  disconnect close the session. A one-second heartbeat with a two-second call
  timeout detects a Worker terminated without an error event. Timeouts never
  retry potentially executed work. Background browser throttling can delay
  detection; this is not a server-enforced lease. A realm crash ends the VM
  session rather than silently changing its identity.

## Run

Use Node 22+ and the browser toolchain pinned in `.tool-versions`. The bundler
invokes `mix` from PATH: point PATH at the selected OTP/Elixir binaries (or working
asdf shims), not the broken mise shim described in the root AGENTS.md. In a
separate server shell retain OTP 28.3.1 / Elixir 1.19.5-otp-28.

From this directory, with the **browser** toolchain selected:

```sh
npm ci
npm run prepare:shared
cd browser
mix deps.get
mix test
cd ..
npm test
npm run build
npx playwright install chromium
```

From `apps/lattice_demo`, with the **server** toolchain selected:

```sh
MIX_ENV=test ~/.asdf/shims/mix run ../lattice_popcorn_spike/test/server_test.exs
MIX_ENV=test ~/.asdf/shims/mix run ../lattice_popcorn_spike/scripts/server.exs
```

The second command stays running on loopback port 4059. Set
`LATTICE_POPCORN_PORT` consistently to choose a different port. It mounts the
existing WebSocket handler, a signed echo target, and test-only `/proof` controls.
The lease endpoint grants only a short-lived cap to that test target. Never
mount these fixtures on a production listener.

In another shell in this directory:

```sh
npm run preview
```

This serves the exact built `dist/` on loopback port 5179 and proxies `/ws` to
4059. It sets COOP/COEP and the research CSP, serves Wasm with its correct MIME
type, and serves compressed OTP tarballs with `Content-Encoding: gzip`.
It does not repack OTP at preview time. `npm run dev` is available for development
but is not the acceptance target.

With both servers running and a fresh proof listener (counters start at zero):

```sh
npm run e2e
```

Optional overrides: `LATTICE_POPCORN_URL`, `LATTICE_POPCORN_PREVIEW_PORT`,
`PLAYWRIGHT_EXECUTABLE_PATH`. Stop/restart the proof listener before repeating
E2E. The test verifies every served asset hash before boot and writes
`evidence/browser.json`, including failure status. It checks a real Worker,
runtime identity, signed allow, forged/missing/expired cap denials before
delivery, forbidden protocol vocabulary, hard Worker termination, and graceful
browser disconnect. `bootAndConnectMs` includes Worker boot and Gateway handshake;
`runtime.memory_bytes` is BEAM total accounting, not total Wasm/Worker/browser RSS.

The path-scoped `Popcorn browser proof` GitHub Actions workflow runs this same
build and Chromium proof on PRs touching the spike, and supports manual dispatch.
It switches from OTP 29 for browser compilation to OTP 28 for the server, and
uploads evidence even on failure. A submitted workflow is not passing evidence.

## Security and acceptance limits

Popcorn deliberately removes distribution and native sockets. No raw remote PID,
registered-name, RPC, cookie, remote spawn, or node-membership interface is added.
Local registered names still exist inside OTP and Popcorn's trusted proxy; this
wrapper provides encapsulation, not a security boundary against the page owner,
XSS, extensions, or malicious host JavaScript. The host has no server credential
or authority unavailable to the realm.

HTTPS or localhost, `Cross-Origin-Opener-Policy: same-origin`, and
`Cross-Origin-Embedder-Policy: require-corp` are required. This prerelease also
requires CSP `unsafe-eval`; it is an explicit **production-readiness non-claim**.
The relaxed CSP is scoped to this separate proof origin. No production headers,
Gateway policy, existing adversarial tests, or main demo are weakened.

The original signed-echo proof excludes durable keys, reconnection, v2
delegations and materialization; the bounded durable-replica demo below adds these
research paths. Production authentication/key custody, mobile/browser compatibility,
and total Wasm memory profiling remain further work. Background heartbeat latency is not a
hard cleanup deadline. AtomVM remains a size/control comparison only.

Sources: [Popcorn OTP source](https://github.com/software-mansion/popcorn/tree/381a5d0e21fc1c853078457462537f0eec65db00/popcorn),
[JavaScript setup](https://github.com/software-mansion/popcorn/blob/381a5d0e21fc1c853078457462537f0eec65db00/popcorn/js/README.md).

## Durable two-replica demo

The next proof lives at `/replica.html?replica=alice` and
`/replica.html?replica=bob` on the same built preview described above.
It runs the exact v2 `Log`, `Sync`, `Authority`, `Reduce`, CRDTs, and wire/storage
codec inside each Popcorn OTP Worker. Source hashes are retained in `build.json`.
The server uses those same modules, behind a capability-protected Gateway target.
The original signed-echo proof remains available at `/`.

1. Start the proof Gateway and built preview using the toolchains above.
2. Open Alice and Bob in separate tabs. Each starts its own BEAM identity and
   IndexedDB record. Click **Connect / reconnect** in each, then **Sync** in Alice.
3. Click **Go offline** in both, enter different notes, and **Save locally**.
   Reload Alice: its key, signed local note, and log survive, without a connection.
4. Reconnect both and sync Alice again. Both note lists and op-id sets match.
5. Disconnect Alice and save another note. Copy Alice's `public_key` from the
   evidence panel and invoke the administrator-only local fixture:

   ```sh
   curl -X POST --get --data-urlencode 'public_key=PASTE_ALICE_PUBLIC_KEY' \
     http://127.0.0.1:4059/proof/revoke
   ```

6. Reconnect Alice and sync Bob. Alice's concurrent offline note is absent from
   accepted state, with its op id recorded as `revoked_capability` on both replicas.
   Saving another note in Alice now fails with that same reason. Reloading retains
   the signed revocation evidence and recomputes the denial.

**Semantics:** local offline writes are provisional. Lattice preserves commands
causally before a valid revocation; concurrent and subsequent commands citing the
revoked delegation are quarantined. Structural log receipt is not semantic
acceptance. Denied signed ops stay in the DAG as audit evidence and never affect
materialized notes. The relay's `accepted` array excludes semantically denied ops.
A duplicate sync returns an empty `accepted` array.

**Persistence contract:** a successful local save or sync resolves only after one
strict IndexedDB transaction commits the identity seed plus complete signed log.
Restore rechecks signatures, causal dependencies, the root-bound genesis, and
current authority; it never reads cached materialization or verdicts. Existing
records that cannot be read/validated fail closed rather than minting a replacement
identity. Web Locks permit only one active tab per named storage record. A new
browser context has separate storage and a separate identity.

**Research boundaries:** the seed passes through trusted host JavaScript into
IndexedDB; it is not non-extractable, encrypted, XSS-resistant, or protected from
the browser owner. Replica root selection is trust-on-first-enrollment, then pinned
by the stored log. Complete storage replacement/rollback is not detected. The local
fixture enrolls at most two identities and never regrants a revoked identity. It is
not production authentication or enrollment. Its root/log are in memory; restarting
the server creates a different replica, which existing browser records refuse.
For a fresh demo, use a fresh browser profile/context. Storage eviction/clearing can
lose the local record. The demo caps the complete log at 32 operations and notes at
256 UTF-8 bytes; it has no compaction, multi-device key recovery, automatic background
sync, or production custody claims. `unsafe-eval` and COOP/COEP requirements remain.

### Verification

```sh
# OTP 29, from apps/lattice_popcorn_spike
npm run prepare:shared
(cd browser && mix test)
npm test
npm run build

# OTP 28, from apps/lattice_demo
MIX_ENV=test mix run ../lattice_popcorn_spike/test/replica_server_test.exs

# Against fresh proof servers, from apps/lattice_popcorn_spike
npm run e2e
npm run e2e:replicas
```

The Chromium acceptance script uses two independent browser contexts and real
Workers, exercises reload/reconnect/offline edits, duplicate synchronization,
concurrent revocation, denial after observed revocation, same-record writer
exclusion, hard Worker termination/reload, and equality with native server state.
It writes `evidence/replicas.json` (public keys and signed-log verdicts only, no
private seeds). Native tests additionally exercise reordered/duplicate delivery,
tampered signatures, corrupted persistence, and changed roots. CI retains both
browser proof artifacts and runs on relevant core/Gateway changes as well.
