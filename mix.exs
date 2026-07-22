defmodule Lattice.MixProject do
  use Mix.Project

  def project do
    [
      apps_path: "apps",
      version: "0.1.0",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      aliases: aliases(),
      releases: releases()
    ]
  end

  def cli do
    [preferred_envs: [verify: :test, check: :test]]
  end

  defp aliases do
    [
      verify: ["format --check-formatted", "test"],
      check: ["verify", "credo --strict"]
    ]
  end

  # Production pilot release (plan 158, Pilot Carrier Runtime). Mix umbrella
  # releases must be declared in the umbrella root's project/0 — a
  # `releases:` key in a child app's mix.exs is invisible to `mix release`
  # run here, which is where production actually invokes it. The runtime
  # boots from the manifest named by LATTICE_CARRIER_MANIFEST (see
  # config/runtime.exs); identity material loads only from the secret files
  # the manifest names — never from argv or inline configuration.
  defp releases do
    [
      lattice_carrier_pilot: [
        include_executables_for: [:unix],
        applications: [lattice_carrier_server: :permanent]
      ]
    ]
  end

  # Dependencies listed here are available only for this
  # project and cannot be accessed from applications inside
  # the apps folder.
  #
  # Run "mix help deps" for examples and options.
  defp deps do
    [
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:sobelow, "~> 0.13", only: [:dev, :test], runtime: false}
    ]
  end
end
