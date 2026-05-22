defmodule LatticeCarrierSpike.MixProject do
  use Mix.Project

  @web_socket_dist_ref "a1223178c73c25fbd2101f56d475746fca663439"
  @tcp_filter_dist_ref "d6b9b27c4f44bf211b57064a8836234119c16af0"

  def project do
    [
      app: :lattice_carrier_spike,
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
    [
      extra_applications: [:logger, :jason]
    ]
  end

  defp deps do
    [
      {:lattice_core, in_umbrella: true},
      {:jason, "~> 1.4"},
      {:tcp_filter_dist,
       git: "https://github.com/otp-interop/tcp_filter_dist.git",
       ref: @tcp_filter_dist_ref,
       override: true},
      {:web_socket_dist,
       git: "https://github.com/otp-interop/web_socket_dist.git", ref: @web_socket_dist_ref}
    ]
  end
end
