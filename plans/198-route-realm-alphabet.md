# Plan 198: State the Treehouse route and realm alphabet once (TS, Rust and the CSP read one table)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 68ad53ad9..HEAD -- clients/treehouse-tauri-shell/src-tauri/src/preview.rs clients/treehouse-tauri-shell/src/treehouse_routes.ts clients/treehouse-tauri-shell/src/treehouse_state.ts clients/treehouse-tauri-shell/src-tauri/tauri.dev-trace.conf.json clients/treehouse-tauri-shell/test/storage.ts clients/treehouse-tauri-shell/test/product_contract.mjs clients/treehouse-tauri-shell/src-tauri/tests/native_commands.rs clients/treehouse-tauri-shell/src/App.vue clients/treehouse-tauri-shell/package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW–MED (validation rules in the shell and its native store; one deliberate narrowing,
  `ws://[::1]`, and one CSP widening in the dev-trace variant only; no custody, signing or
  carrier-wire code changes)
- **Depends on**: 181 (DONE); operator decision D3 of 2026-10-14 (one generated table for TS, Rust
  and the CSP, checked in CI; saved routes refused with a message, not rewritten)
- **Category**: correctness / dx (ends the validator-parity and pinned-route-unusable finding
  classes, ten PR #104 review rounds)
- **Planned at**: commit `68ad53ad9`, 2026-10-16

## Why this matters

A relay route and its realm labels are pinned for good once saved (`mergeRelay` only extends a set;
the native store refuses any change). Two validators judge them: `treehouse_routes.ts` when the
operator types or an offer carries them, and `preview.rs` when the record is persisted and when it
is opened again. They were written to agree and were hand-checked list against list, but the lists
are the only thing that ties them together, and two rules escaped:

- `realm_text` (Rust) uses `str::trim`, which strips Unicode White_Space (U+0085 included,
  U+FEFF excluded); `realmText` (TS) uses `String.prototype.trim`, which strips U+FEFF but not
  U+0085. A realm `"x\u0085"` passes TS, is saved, and the native `open()` then refuses the whole
  record as `invalid_relay`; `"﻿x"` is the mirror image. Because the set is extend-only, the
  operator cannot repair it from the app.
- Both validators accept `wss://` to any host and `ws://` to `localhost` or `[::1]`, but the only
  build that can configure routes (`tauri.dev-trace.conf.json`) allows `connect-src
  ws://127.0.0.1:*` alone. Such a route validates, pins, and can never connect.

D3 chose one table over permitting route replacement: the alphabet is stated once, both validators
read it, the CSP is derived from it, and a differential test proves the two runtimes agree on the
same cases. A persisted set that fails the rules is still refused on open, now with a message, and
is never rewritten.

### Policy fit

- Rule 1: the claim tier is **core** (TS unit test, Rust integration test, a structural contract
  on the config). No packaged or physical claim: the hosted enrollment gate dials
  `ws://127.0.0.1` only, so nothing here changes what it exercises.
- Rule 3: `preview.rs` is `src-tauri/src` custody code, so this PR gets the adversarial review and
  a second independent review (Codex Sol).
- Rule 6: no test asserts on prose in this plan or the index.
- Rule 7: row 200's missing messages stay row 200; this plan adds only `invalid_relay`.
- No `.github/workflows` edit: the new tests run inside the existing `npm test` and
  `cargo test --locked` steps of the Treehouse jobs.

## Current state

- `clients/treehouse-tauri-shell/src/treehouse_routes.ts:21-32` — `realmText` refuses a
  non-string, an all-whitespace value, `value !== value.trim()`, or more than 256 UTF-8 bytes.
  `validRouteUrl` (lines 37-64): WHATWG `URL`, printable ASCII only, no credentials or fragment,
  ≤ 2048 chars, raw host equal to `url.hostname`, name hosts `[A-Za-z0-9._-]`, canonical decimal
  port, `wss:` any host, `ws:` only `127.0.0.1`, `localhost` or `[::1]`.
- `clients/treehouse-tauri-shell/src-tauri/src/preview.rs:116-119` — `realm_text`:
  `!value.is_empty() && value.trim() == value && value.len() <= 256`. `route_url` (138-187):
  the same URL rules by hand; a bracketed host must be a canonical IPv6 literal and is loopback when
  `Ipv6Addr::is_loopback`; `route_host` (190-213) classifies names and IPv4. `valid_relay`
  (229-247) applies them per route; `parse` (325-326, 339) returns `invalid_relay`, which `open()`
  surfaces unchanged.
- `clients/treehouse-tauri-shell/src/treehouse_state.ts:203-214` — `relay()` re-runs the TS rules
  when a record is loaded and `parseState` throws `invalid_relay`.
- `clients/treehouse-tauri-shell/src-tauri/tauri.dev-trace.conf.json` — `connect-src 'self' ipc:
  http://ipc.localhost ws://127.0.0.1:*`; `test/product_contract.mjs:15-24` pins that string
  exactly and requires the overlay to patch `connect-src` alone.
- `clients/treehouse-tauri-shell/test/storage.ts:286-331` and
  `src-tauri/tests/native_commands.rs:443-547` — the hand-mirrored valid and refused URL lists
  (`ws://[::1]:9` and `ws://[::1]:` are in both valid lists).
- `clients/treehouse-tauri-shell/src/App.vue:100-131` — `describe()` maps known error codes to
  copy; `invalid_relay` is not among them, so a refused saved set shows the generic sentence.
- `clients/treehouse-tauri-shell/route_alphabet.json` — written with this plan: realm max bytes
  and the 26 edge code points (Rust White_Space ∪ U+FEFF), route URL constants, loopback hosts
  `127.0.0.1` and `localhost`, host alphabet, port range, and the ordinary `connect-src`.
- `package.json` `test` script runs the TS tests in sequence; `enrollment_ci_contract.mjs` pins
  only `packaged:enrollment` and the build script, not `test`.

## Commands you will need

Homebrew node is broken on the operator machine; use nvm's Node 22 and the shell's own
`node_modules/.bin` (the lattice-client package must be installed too, the shell imports its
`dist`):

```bash
export PATH="$HOME/.nvm/versions/node/v22.15.1/bin:$PATH"
(cd clients/lattice-client && npm ci)
cd clients/treehouse-tauri-shell && npm ci
npm run typecheck && npm test
npm run route-alphabet:cases            # regenerate test/route_alphabet_cases.json
(cd src-tauri && cargo test --locked && cargo test --locked --features treehouse-dev-trace)
```

## Scope

Only these files change. Nothing under `clients/lattice-client`, `apps/`, or `.github/`.

1. `clients/treehouse-tauri-shell/route_alphabet.json` (new, already written) — the table.
2. `src/treehouse_routes.ts` — import the table. `realmText`: non-empty, first and last **code
   point** (not UTF-16 unit) not in `edgeWhitespace`, UTF-8 length ≤ `maxUtf8Bytes`, no lone surrogate
   (the native store's JSON parser refuses one, so the shell refuses it first); no `trim()`.
   `validRouteUrl`: `ws:` loopback test is `loopbackHosts.includes(url.hostname)` (so `[::1]` is
   refused for `ws:`; `wss://[...]` is unchanged); host alphabet, length cap, printable range and
   port bounds read from the table. Keep every other rule byte-for-byte.
3. `src-tauri/src/preview.rs` — `include_str!("../../route_alphabet.json")` parsed once behind
   `std::sync::LazyLock` into a `serde` struct (unknown fields denied). `realm_text`: first and
   last `char` not in the edge set, byte length ≤ the table cap, non-empty; no `trim()`. `route_url`:
   a bracketed host is never loopback (keep the canonical-IPv6 check, now against the WHATWG
   serializer rather than `Ipv6Addr::to_string`, so `wss://[::A]`, `wss://[2001:db8::1]:443` and
   `wss://[::ffff:102:304]` stay accepted); the loopback names, scheme rules, port bounds, length cap
   and printable range come from the table. The host-alphabet byte check stays code, pinned by a test
   that the table's `hostAlphabet` string is the regex it implements. Any host label starting with
   `xn--` is refused in both runtimes: the shell's `URL()` runs IDNA and throws on a malformed
   punycode label, and the native store has no IDNA implementation to judge the same way. Expose exactly two pure functions for the
   differential test, `pub fn valid_realm_text(&str) -> bool` and
   `pub fn valid_route_url(&str) -> bool`, re-exported from `preview`; nothing else becomes public.
4. `test/support/route_alphabet_cases.ts` (new) — a deterministic generator (fixed-seed xorshift,
   no `Math.random`) that writes `test/route_alphabet_cases.json`: an array of
   `{ "kind": "realm" | "url", "value": string, "valid": boolean }` with `valid` taken from the TS
   validators. Realm cases: for every edge code point and for U+0000, U+0001, U+007F, U+00AD,
   U+180E, U+200B, U+2060, U+FFFD the forms `${c}x`, `x${c}`, `x${c}y`, `${c}`; byte boundaries
   (256 ASCII ok, 257 refused, 128 × `é` ok, 129 refused, 64 × a 4-byte emoji ok); the empty
   string; about 500 random strings over an alphabet mixing ASCII, the edge set and multibyte
   letters. URL cases: every entry of both hand-written lists in `storage.ts` and
   `native_commands.rs`, plus about 1500 combinations of scheme (`ws`, `wss`, `WS`, `WSS`, `http`,
   `wss ` ...), host (`127.0.0.1`, `localhost`, `LocalHost`, `[::1]`, `[::A]`, `[2001:db8::1]`,
   `example.com`, `127.1`, `0x7f.1`, `10.0.0.1`, `service.0xcorp`, `a.0x1f`, `foo!bar`,
   `ex%61mple.com`, `exämple.com`, `010.0.0.1`), port (`""`, `:`, `:1`, `:0`, `:80`, `:443`,
   `:65535`, `:65536`, `:0443`, `:8a`), path/query/fragment/userinfo suffixes and one inserted
   non-printable byte. No lone surrogates (JSON must round-trip through serde_json). With
   `--write` it rewrites the file; without, it returns the cases.
5. `test/route_alphabet.ts` (new) — regenerates the cases in memory and asserts deep equality with
   the committed file (a stale file fails), re-asserts every verdict against the live validators,
   and asserts these named expectations regardless of the generator: `"﻿x"` and `"x\u0085"`
   refused, `"x​y"` accepted, `"ws://[::1]:9"` refused, `"ws://localhost:1"` and
   `"wss://[2001:db8::1]:443"` accepted, and the table's edge list equals exactly the 26 code points
   listed in this plan's Current state.
6. `src-tauri/tests/route_alphabet.rs` (new) — reads the cases file through
   `concat!(env!("CARGO_MANIFEST_DIR"), "/../test/route_alphabet_cases.json")`, runs each through
   the two pure functions and asserts every verdict, reporting the first disagreement with its
   value escaped. Also asserts the file holds at least 1000 cases of each kind.
7. `test/storage.ts` and `src-tauri/tests/native_commands.rs` — move `ws://[::1]:9` and
   `ws://[::1]:` to the refused lists; add `"\u{FEFF}x"` / `"x\u{0085}"` realm refusals on both
   sides (the Rust list via `with(1, "expectedPeerRealm", ...)` and a `localRealm` variant).
8. `src-tauri/tauri.dev-trace.conf.json` — `connect-src 'self' ipc: http://ipc.localhost
   ws://127.0.0.1:* ws://localhost:* wss:`.
9. `test/product_contract.mjs` — derive the expected overlay value from the table
   (`ordinaryConnectSrc` + one `ws://<host>:*` per loopback host + `wss:` when `schemes.wss ===
   "any-host"`) instead of the literal; keep the ordinary `connect-src` pin and the overlay shape
   pins.
10. `src/App.vue` — `describe()` gains `invalid_relay`: "A saved relay route no longer meets the
    route rules. Nothing has been replaced or rewritten, but the saved record cannot be opened until an operator repairs its routes."
11. `package.json` — `test` runs `tsx test/route_alphabet.ts` after `test/storage.ts`; new script
    `route-alphabet:cases` = `tsx test/support/route_alphabet_cases.ts --write`.
12. `plans/README.md` — row 198 status cell (one line, ≤ 200 characters).

## Test plan

- RED first: add the named expectations of step 5 and the Rust realm cases of step 7 before
  touching the validators; `"x\u0085"` must fail in Rust and pass in TS, `"﻿x"` the reverse.
- GREEN: steps 2-3, then regenerate the cases file, then steps 5-6 pass in both runtimes.
- `npm run typecheck && npm test` green in the shell; `cargo test --locked` and
  `cargo test --locked --features treehouse-dev-trace` green in `src-tauri`.
- `git diff --exit-code -- clients/treehouse-tauri-shell/test/route_alphabet_cases.json` after a
  fresh `npm run route-alphabet:cases` (the committed file is current).
- `product_contract.mjs` fails when the overlay string is edited by hand to drop `wss:` (run once
  with a temporary edit, then revert).

## Done criteria

- One table file; neither validator contains a literal whitespace set, loopback host list, scheme
  rule, port bound or length cap of its own. The Rust host-alphabet byte check is the one literal
  left, pinned by string equality to the table's regex.
- The differential cases file holds ≥ 1000 realm and ≥ 1000 URL cases and both runtimes agree on
  every one.
- `ws://[::1]` and any `xn--` host label are refused by both validators and named in the PR as the
  two forms removed. The review-found parity breaks (a later `://` in the text, a bare `#`,
  IPv4-mapped IPv6 hex literals, two trailing dots) now agree and sit in the cases file.
- The dev-trace `connect-src` equals the value derived from the table; the ordinary and
  judge-spike configs are unchanged.
- A persisted relay that fails the rules still raises `invalid_relay` on open and the app shows the
  new sentence; no code path rewrites or drops a saved route.
- PR body states the claim tier (core; CSP contract is structural) and lists both reviews.

## STOP conditions

- A hosted gate (`packaged_enrollment.ts`, `enrollment_sync_gate.ts`, `pilot_node.exs`) is found
  to dial `localhost`, `[::1]` or `wss://`.
- A route or realm form other than `ws://[::1]`, `xn--` labels, lone surrogates and the U+0085 /
  U+FEFF edges changes verdict in both runtimes once both read the table (a form that changes in
  one runtime only is a parity fix, not a STOP).
- The change needs an edit under `clients/lattice-client`, `apps/`, or `.github/`.
- `cargo test --locked` needs a new dependency or a `Cargo.lock` change.

## Maintenance notes

- Adding a loopback host or scheme is a table edit plus regenerated cases; the contract test then
  tells the operator the dev-trace `connect-src` must follow.
- The generator is the only writer of the cases file; never edit the JSON by hand.
- Row 200 (missing messages) and row 199 (one capability snapshot) are untouched by this plan.
