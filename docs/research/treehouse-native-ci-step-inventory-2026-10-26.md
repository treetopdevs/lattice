# Treehouse native CI step ownership

Plan277 retains all former unit checks. Only the two Treehouse native Cargo suites
move to a separately required job. Both retain their exact working directory,
command, lockfile flag and feature. Each runner prepares its own inputs.

| Former unit step | New owner |
|---|---|
| Pinned repository checkout | unit; also native setup |
| Set up BEAM | unit |
| Install Hex and Rebar | unit |
| Set up Node | unit |
| Cache deps and _build | unit |
| Cache Cargo dependencies and build | unit |
| Install dependencies | unit |
| Check formatting | unit |
| Install TS client dependencies | unit |
| Build client before reciprocal preview test | unit |
| Shared mobile signature and handoff contracts | unit |
| Install shell kit dependencies | unit |
| Shell kit typecheck and boundary check | unit |
| Install offline Treehouse preview dependencies | unit |
| Offline Treehouse workflow, storage and product contracts | unit |
| Build offline Treehouse UI | unit |
| Run full test suite | unit |
| Regenerate TS oracle vectors | unit |
| Regenerate and verify TS-authored continuation operations | unit |
| Regenerate TS-authored vector writers | unit |
| Committed oracle vectors and wire vocabulary match regeneration | unit |
| TS client distribution guard regression | unit |
| Committed TS client dist matches build | unit |
| Typecheck TS client | unit |
| TS client conformance | unit |
| TS Treehouse catalog and profile observations | unit |
| Reciprocal continuity claim-shape refusals | unit |
| TS Treehouse domain and authority review | unit |
| TS V-01 authority fail-closed guard | unit |
| TS canonical op parity | unit |
| TS Township authoring | unit |
| TS Tauri bridge | unit |
| TS carrier availability feed contract | unit |
| TS witnessed succession review | unit |
| TS witnessed succession artifact | unit |
| Build TS client for shell feed gate | unit |
| Install TS mobile core dependencies | unit |
| Build TS mobile core and check committed dist | unit |
| Install Tauri shell dependencies | unit |
| TS Township shell typecheck | unit |
| TS Township runtime wiring contract | unit |
| TS governance witness native bridge | unit |
| TS Township native workflow | unit |
| TS Township intent UI behavior | unit |
| TS Township action handoff support contract | unit |
| TS Township action-intent contract | unit |
| TS Township deep-link dispatcher contract | unit |
| TS Township action contract | unit |
| TS Township delegation-grant fixture | unit |
| TS Township frontend contract | unit |
| TS Township carrier sync contract | unit |
| TS reactive Township feed controller | unit |
| TS live stable carrier availability feed | unit |
| TS Township carrier peer contract | unit |
| TS Township pairing deep-link contract | unit |
| TS Township pairing deep-link source contract | unit |
| TS Township pairing QR contract | unit |
| TS Township pairing QR camera contract | unit |
| TS Township pairing discovery contract | unit |
| TS Township canonical probe contract | unit |
| TS mobile secure-store strategy | unit |
| TS Township witness artifact contract | unit |
| TS Township packaged bundle variant contract | unit |
| TS Township revocation fixture contract | unit |
| Runner image key | unit |
| Restore apt package cache | unit |
| Point apt at the cache and verify its contents against the index | unit |
| Install Tauri Linux prerequisites | unit |
| Hand the apt archive directory to the runner user | unit |
| Save apt package cache | unit |
| Tauri native command core | unit |
| Mobile core native migration matrix | unit |
| Offline Treehouse native persistence and key boundaries | treehouse_native |
| Treehouse dev-trace identity seam | treehouse_native |
| TS Township witness fixture preflight | unit |
| Tauri development trace contract | unit |
| TS carrier Township check | unit |
| TS one-op carrier relay check | unit |
| TS relay-aware carrier sync check | unit |
| TS live carrier Township check | unit |
| Treehouse enrollment sync gate against Lattice.Sim | unit |
| Credo (strict) | unit |
| Sobelow (lattice_server) | unit |
| Sobelow (township_web) | unit |

## Native runner prerequisites

The new job has pinned checkout, BEAM/Hex/Rebar/Node, separate Mix/Cargo caches,
dependency install, client install/build, shell-kit and shell installs, shell build,
forced test-environment BEAM compilation, authenticated apt cache validation and
Linux prerequisite install. Ordinary and tracing tests run sequentially. Cache
writer namespaces are separate from unit. Native has read-only contents access.

## Required aggregate

The aggregate checks out its own repository before executing its script.
Classifier, unit and native must succeed. Failure, cancellation, missing or unknown
results fail. Existing classified product skips remain allowed. The executable
result matrix runs in unit. Outputs containing a field named result do not
override a dependency's direct result.

## Budgets and evidence boundary

The previous35-minute serial budget expired after BEAM and ordinary native passed.
The45-minute remaining unit and50-minute native allocations include cold-install
headroom; apt remains capped at15minutes. These are provisional bounded allocations,
not observed cold-run timings. The final hosted gate must complete both jobs and
record their step timings before this slice or the native checkpoint can claim
hosted success. Failed or cancelled gates stay failed or cancelled. This split
makes no native production, installation or real-relay readiness claim.
