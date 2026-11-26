defmodule LatticeCore.MixProject do
  use Mix.Project

  def project do
    [
      app: :lattice_core,
      version: "0.1.0",
      elixir: "~> 1.19",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      name: "Lattice",
      source_url: "https://github.com/treetopdevs/lattice",
      docs: [
        main: "Lattice",
        extras: [
          "../../docs/lattice2_design.md",
          "../../docs/threat_model_v2.md",
          "../../docs/path_to_real.md"
        ]
      ]
    ] ++ umbrella_paths()
  end

  # Inside the umbrella, share its build, config, deps and lockfile. A sparse checkout
  # of only apps/lattice_core has none of them, so it loads as a plain project instead.
  defp umbrella_paths do
    if File.exists?(Path.expand("../../config/config.exs", __DIR__)) do
      [
        build_path: "../../_build",
        config_path: "../../config/config.exs",
        deps_path: "../../deps",
        lockfile: "../../mix.lock"
      ]
    else
      []
    end
  end

  # test/support holds compiled test infrastructure (e.g. the attestation seam
  # contract) that must be available as real modules under `mix test`.
  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger, :crypto, :jason],
      mod: {LatticeCore.Application, []}
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:ex_doc, "~> 0.34", only: :dev, runtime: false},
      {:jason, "~> 1.4"},
      {:stream_data, "~> 1.1", only: [:dev, :test]}
    ]
  end
end
