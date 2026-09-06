# Independent native witness prompt repair

Status: local implementation and native verification passed; exact-diff review and
hosted tip/merge-result gates remain pending. This is the independent first build
slice required by Plan 174's follow-on instructions, not production work inside
its design spike. The user authorized execution of the unified proposal with
Claude Fable review on 2026-09-06. R17a's follow-on build assigns this as Stage 0;
it does not depend on completion or adoption of the larger native architecture.

- Base: `bed951d9ae753c390e509dceace1311df7c081c2`.
- RED commit: `83124984` adds one public signing/presence regression with six
  otherwise accepted replica inputs: 16 KiB text, newline, carriage return, NUL,
  non-ASCII text and a direction override. The initial focused run failed because
  the recorded OS reason included the submitted 16 KiB replica text.
- Production scope is only `TownshipNativeState.sign_governance_witness` in
  `clients/township-tauri-shell/src-tauri/src/lib.rs`. Replace submitted-replica
  interpolation with the fixed ASCII reason `Sign Township clerk recovery witness`.
  Existing closed-claim validation still runs before presence.
- The existing custody test's two exact reason expectations now name that constant.
  Payload digest, signature, fresh presence/seed access, cancellation, provider
  binding and no-write assertions remain intact. The hostile-input test cancels
  at presence and proves no seed read or durable write occurs.
- Full `cargo test --locked` passed: 68 tests including four doctests, zero failures
  and zero ignored tests. This includes 14 custody tests and the ordinary release
  binding target; it is injected-provider/native software evidence.
- `cargo fmt --check` and `git diff --check` passed. Canonical encoder, vectors,
  dependencies, production provider and IPC shape are unchanged.
- Local logs: `/tmp/lattice-treehouse-execution-20260906/native-prompt-red.log`,
  `native-prompt-green.log` and `native-prompt-format.log` in the same directory.

The constant reason removes caller-controlled prompt text. It does not verify a
claim's semantic truth or identify its replica. R17b still owns native derivation,
retained-history checks, verified review fields and authorization-token cutover;
R36/R17c still own Android custody and physical presence evidence.
