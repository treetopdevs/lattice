defmodule Hello.MixProject do
  use Mix.Project

  # Standalone (NOT in_umbrella) so it has its own _build/deps/mix.lock — this is
  # also the "separate build context" we'd fall back to if the repo toolchain fails.
  def project do
    [
      app: :hello,
      version: "0.1.0",
      elixir: "~> 1.19",
      deps: deps(),
      # ExAtomVM packbeam config: first module with start/0 is the entry.
      atomvm: [start: Hello]
    ]
  end

  def application, do: []

  defp deps do
    [{:exatomvm, github: "atomvm/exatomvm", runtime: false}]
  end
end
