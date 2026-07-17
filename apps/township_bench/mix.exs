defmodule TownshipBench.MixProject do
  use Mix.Project

  # G13 measurement harness.
  #
  # PURPOSE: price the dominant cost of the pinned coercion-resistance construction
  # (encrypted-sorting CHide, candidate profile — see zk-m4-election-path-findings.html
  # §07/§08) against its REFERENCE ALGORITHMS in single-process simulation, at
  # 100 / 1,000 / 10,000 participants, BEFORE any production role runner exists.
  #
  # This app makes NO coercion-resistance claim. It flips no SecurityProfile claim.
  # It touches neither Township.Matter nor Lattice.Attestation. It is a cost oracle.

  def project do
    [
      app: :township_bench,
      version: "0.1.0",
      build_path: "../../_build",
      config_path: "../../config/config.exs",
      deps_path: "../../deps",
      lockfile: "../../mix.lock",
      elixir: "~> 1.18",
      start_permanent: false,
      deps: deps()
    ]
  end

  def application do
    [extra_applications: [:logger, :crypto]]
  end

  # Intentionally dependency-light. The reference-algorithm cost model is pure Elixir
  # arithmetic over operation counts; a later profile may swap in a Rustler NIF that
  # times real group operations, but the harness contract stays the same.
  defp deps, do: []
end
