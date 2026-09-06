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
