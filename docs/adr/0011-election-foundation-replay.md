# ADR 0011 — One partial election foundation replay

- **Status**: accepted
- **Context**: `Township.Election.project/3` passed through into `Projector`, and
  `Projector` called back into `Election.verify_link/3`. One offline bundle walked
  that path four times. The research brief's future reduction can return a final
  `Projection`. The foundation does not.

## Decision

`Township.Election.replay/3` is the foundation walk. `{:ok, %Replay{}}` carries the
projection and the verified board detail (`spec`, `link`, `safe_log`, `commands`,
`artifact_records`, `requirements`, `findings`, `rejected`). `{:error, reason}`
carries neither. Every projection from this walk stays in `:setup`. There is no
second `project/3`. `Projector` is deleted.

Close policy and the offline bundle stay outside and call `replay/3` themselves.
They do not take a caller-built `Replay`. The bundle stores the projection only:
`build/3` replays once to fill the package, and `verify/1` replays the package
once and compares. A final projection remains a later gate.

## Considered options

- Keep `project/3` total, always returning a `Projection`, beside a second richer
  walk. Callers can use both and walk twice, which is how the offline bundle
  already behaved.
- Let close and the bundle accept a `Replay` from the caller. `verify/1` would
  then trust a projection it did not recompute, including one forged to `:final`.
- Fold close policy and the offline bundle into `Township.Election`. Those are
  separate jobs from the foundation walk.

## Consequences

Malformed input is `{:error, reason}`, not an invalid `Projection`. The offline
bundle preloads `Township.Election` so replay atoms exist before a fresh BEAM
decodes a package. The M4 brief's lifecycle and final reduction stay later gates.
