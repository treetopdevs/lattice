defmodule LatticeWebSocket.MixProject do
  use Mix.Project

  def project do
    [
      app: :lattice_web_socket,
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

  def application do
    [extra_applications: [:logger, :crypto]]
  end

  defp deps do
    [
      {:lattice_core, in_umbrella: true},
      {:jason, "~> 1.4"}
    ]
  end
end
