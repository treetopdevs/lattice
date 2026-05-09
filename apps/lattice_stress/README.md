# Lattice Stress

Adversarial validation app for the Lattice POC.

This app is not framework surface. It contains probe transports, probe targets,
deterministic barriers, harsh ExUnit suites, the `mix lattice.stress` load
harness, and an optional two-browser Playwright E2E check.

Run:

```sh
mix test apps/lattice_stress/test
mix lattice.stress --tabs 500 --caps 2000 --calls 50000 --bridges 1000
npm run browser:e2e
```

See `docs/stress_lab.md` at the repository root for details.
