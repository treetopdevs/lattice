# Candidate-only native catalog persistence

Base: `03f127f56f28c219439747ea2770778e5fef196e` (main run 34149188715 passed).
Source: `4fdf287ef989b9590d5b4a565747c07e96080da0`, integrated as
`c6a5ecf32`; private module registration: `9b742eb6150bae065a3e31f00170ca9279d63893`.
Independent Sol review passed both the source packet and final base-to-tip delta.

The candidate record retains exact snapshot bytes, SHA-256 and both supplied
StoreToken counters in one ProductDatabase compare-and-set. It does not derive
counter advancement or authenticate the candidate. Same-counter stale writers and
stale replay cannot overwrite a newer record. Missing/corrupt state with an
existing native identity returns `trust_recovery_required` without repair.
Future callers must serialize the native identity-presence observation with
identity creation; no IPC caller supplies that fact.

Meaningful RED used the old unconditional write to reproduce stale overwrite
(`/tmp/catalog-store-red.log`). The CAS implementation passed seven focused tests,
including an actual child-process reopen. Root full checks passed 19 Rust tests
plus two compile-fail documentation tests (and the child helper invocation), Android
Rust target compilation, preview tests/build, and 1,031 BEAM tests plus 27 properties,
zero failures, three existing exclusions, formatting and Credo.

Root logs:
- `/tmp/treehouse-catalog-candidate-root-rust.log`
- `/tmp/treehouse-catalog-candidate-root-android.log`
- `/tmp/treehouse-catalog-candidate-root-client.log`
- `/tmp/treehouse-catalog-candidate-root-beam.log`

Hosted tip and merge-result checks are pending. This is a persistence primitive,
not native catalog installation. It creates no command, managed app state,
installed trust, route activation or replacement promotion. The dirty QuickJS
vendored experiment remains preserved and off this packet's dependency path.
Native evaluator acceptance and installed-client C03/C04 remain open; this packet
alone cannot close provisioning, enrollment, custody, device, release or pilot gates.
