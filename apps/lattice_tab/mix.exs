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
      deps: deps(),
      # ExAtomVM packbeam: first module with start/0 is the entry.
      atomvm: [start: Lattice.Tab.Main]
    ]
  end

  # No application callback: this app is a pure protocol library for now.
  # The Realm process + AtomVM packaging are added post-spike.
  def application do
    [extra_applications: [:logger]]
  end

  defp deps do
    # exatomvm is BUILD-ONLY (provides `mix atomvm.packbeam`); never a runtime dep.
    [{:exatomvm, github: "atomvm/exatomvm", runtime: false, only: [:dev, :test]}]
  end
end
