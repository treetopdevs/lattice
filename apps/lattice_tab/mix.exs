defmodule LatticeTab.MixProject do
  use Mix.Project

  def project do
    [
      app: :lattice_tab,
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

  # No application callback: this app is a pure protocol library for now.
  # The Realm process + AtomVM packaging are added post-spike.
  def application do
    [extra_applications: [:logger]]
  end

  defp deps do
    # Intentionally empty — Protocol operates on plain maps (no JSON dep),
    # so it stays inside AtomVM's subset and needs nothing at runtime.
    []
  end
end
