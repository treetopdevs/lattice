defmodule LatticeStress.MixProject do
  use Mix.Project

  def project do
    [
      app: :lattice_stress,
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
      extra_applications: [:logger, :lattice_core, :lattice_server, :lattice_demo],
      mod: {LatticeStress.Application, []}
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:lattice_core, in_umbrella: true},
      {:lattice_server, in_umbrella: true},
      {:lattice_demo, in_umbrella: true},
      {:stream_data, "~> 1.1", only: :test}
    ]
  end
end
