# Verification record

Implementation base: `af84459bfc066b4ed405b99a02046b4f2c6315ee`.
Popcorn reference: `381a5d0e21fc1c853078457462537f0eec65db00`.
Packages: npm/Hex `0.4.0-next.0`, crypto manifest OTP `29.0.6`.
Browser host compiler: OTP 29.0.6, Elixir 1.20.4-otp-29.
Server compiler: OTP 28.3.1, Elixir 1.19.5-otp-28.

| Gate | Result |
| --- | --- |
| JavaScript facade/lifecycle tests | 5 passed |
| Native browser realm tests on OTP 29 | 2 passed |
| Native signed realm through real WebSocket/Gateway | 1 passed; allow, forged/missing/expired caps before delivery, forbidden vocabulary, tamper, replay, disconnect |
| Existing lattice_server suite | 15 passed |
| Existing lattice_core suite | 26 properties, 370 tests; one failure in pre-existing Township audit-bundle subprocess because township_bench was not built |
| Full umbrella suite | Blocked compiling existing township_bench: cargo unavailable |
| Popcorn crypto production bundle | Built successfully |
| Built preview | 23 served asset hashes and isolation headers verified; WebSocket proxy reached real Gateway and rejected RPC |
| Formatting / diff checks | Passed |
| Real browser acceptance | Blocked before page execution; local Chromium socket EPERM; supported cloud browser local URL ERR_BLOCKED_BY_CLIENT |
| Browser boot/connect latency | Unmeasured |
| Browser BEAM memory | Unmeasured; not equivalent to Wasm memory or browser RSS |

First successful build contained a 3,834,784-byte crypto Wasm binary
(approximately 1,595,746 bytes gzip), 8,094,720 bytes of uncompressed OTP/app
tarballs, and 3,791,132 bytes of precompressed tarballs. These are artifact sizes,
not a measured cold-browser download. `dist/build.json` records final per-file
byte counts, gzip estimates, hashes, and shared-source hashes on every build.
The output directory contains both raw and compressed copies, so its total disk
size is not the network payload.

Browser acceptance and the complete repository gate remain open. Run the exact
built preview and E2E from the runbook on a browser-enabled host, then retain the
successful evidence before changing any project-wide browser-BEAM claim.

## Durable browser replica extension (September 6, 2026)

The original runtime proof passed in Chromium on `f3cfb21` in run
[34013339074](https://github.com/treetopdevs/lattice/actions/runs/34013339074).
That success does not prove this extension. The new exact-head acceptance gate is
`npm run e2e:replicas`, retaining `evidence/replicas.json` alongside the original
runtime proof. It must pass before claiming real-browser durable convergence.

Local extension checks: six OTP 29 tests (four durable-replica scenarios plus
two existing realm tests), nine JavaScript host tests, the existing native
signed-echo/Gateway test, and the new two-replica real-WebSocket/Gateway test pass.
The v2 regression suite passes: 20 properties and 209 tests. The browser bundle
builds with warnings treated as errors. One unreachable private nil clause was
removed from core Authority because Elixir 1.20 diagnoses it when compiling the
exact shared source; authority behavior is unchanged and v2 regressions pass.

Local Chromium exits before opening a page because `socket()` is denied by the
workspace runtime. Root `mix verify` is blocked by missing Cargo in the existing
`township_bench` Rustler app. A baseline core-wide run also reports the existing
fresh-process audit-bundle failure for that unavailable umbrella app. Neither
failure is treated as a passing gate. GitHub CI supplies the full toolchain and
real-browser acceptance environment.

The first extension Chromium run found a cold-VM decode failure before enrollment
completed. A fresh native-process regression reproduced it: the wire codec only
accepts existing atoms, but the trusted Authority/Notes vocabulary was not loaded.
The decoder now explicitly loads those fixed modules before processing a signed
log. It still never creates atoms from incoming strings. The regression passes;
the subsequent current-head Chromium run is the acceptance gate.
