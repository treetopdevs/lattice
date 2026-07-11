defmodule LatticeServer.MixProject do
  use Mix.Project

  def project do
    [
      app: :lattice_server,
      version: "0.1.0",
      build_path: "../../_build",
      config_path: "../../config/config.exs",
      deps_path: "../../deps",
      lockfile: "../../mix.lock",
      elixir: "~> 1.19",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger, :cowboy, :jason],
      mod: {LatticeServer.Application, []}
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:lattice_core, in_umbrella: true},
      {:lattice_web_socket, in_umbrella: true},
      {:cowboy, "~> 2.12"},
      {:jason, "~> 1.4"},
      # Sobelow scans one Mix project at a time; umbrella-root deps are not visible
      # as tasks inside child apps, so the security linter is declared here too.
      {:sobelow, "~> 0.13", only: [:dev, :test], runtime: false}
    ]
  end
end
