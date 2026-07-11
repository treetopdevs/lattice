defmodule TownshipWeb.MixProject do
  use Mix.Project

  def project do
    [
      app: :township_web,
      version: "0.1.0",
      build_path: "../../_build",
      config_path: "../../config/config.exs",
      deps_path: "../../deps",
      lockfile: "../../mix.lock",
      elixir: "~> 1.19",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      aliases: aliases()
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger, :runtime_tools],
      mod: {TownshipWeb.Application, []}
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:lattice_core, in_umbrella: true},
      {:bandit, "~> 1.12"},
      {:esbuild, "~> 0.10", runtime: Mix.env() == :dev},
      {:jason, "~> 1.4"},
      {:lazy_html, "~> 0.1.11", only: :test},
      {:phoenix, "~> 1.8.9"},
      {:phoenix_html, "~> 4.3"},
      {:phoenix_live_view, "~> 1.1.32"},
      {:sobelow, "~> 0.14", only: [:dev, :test], runtime: false}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_env), do: ["lib"]

  defp aliases do
    [
      setup: ["deps.get", "esbuild.install --if-missing", "assets.build"],
      "assets.build": ["esbuild township_web"]
    ]
  end
end
