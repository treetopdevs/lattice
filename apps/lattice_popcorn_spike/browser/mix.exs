defmodule LatticeBrowser.MixProject do
  use Mix.Project

  def project do
    [
      app: :lattice_browser,
      version: "0.1.0",
      elixir: "~> 1.19",
      deps: [{:popcorn, "0.4.0-next.0"}]
    ]
  end

  def application do
    [extra_applications: [:logger, :crypto], mod: {LatticeBrowser.Application, []}]
  end
end
