defmodule Mix.Tasks.Lattice.BrowserCarrier.Server do
  @moduledoc """
  Starts the WebSocket distribution carrier spike server.

  Example:

      elixir --erl "-proto_dist Elixir.TCPFilter" -S mix lattice.browser_carrier.server 5000

  """

  use Mix.Task

  alias LatticeCarrierSpike.{BrowserGateway, EchoTarget, Runtime}

  @shortdoc "Start the Lattice browser BEAM carrier spike server"

  @impl true
  def run(args) do
    Mix.Task.run("app.start")

    unless Runtime.proto_dist_enabled?() do
      Mix.raise("""
      lattice.browser_carrier.server must be launched with:
        elixir --erl "-proto_dist Elixir.TCPFilter" -S mix lattice.browser_carrier.server
      """)
    end

    port =
      args
      |> List.first()
      |> case do
        nil -> 5_000
        value -> String.to_integer(value)
      end

    cookie = System.get_env("LATTICE_CARRIER_COOKIE", "lattice_carrier_cookie")

    Lattice.reset!()

    {:ok, target} = EchoTarget.start_link(owner: self())

    {:ok, tab} =
      Lattice.connect_tab(%{
        transport: :browser_beam_carrier,
        connection_pid: self(),
        identity: %{surface: "browser-beam-carrier", agent: "popcorn"}
      })

    {:ok, cap} = Lattice.grant(tab.id, target, [:call], audit: %{carrier: "web_socket_dist"})
    {:ok, _gateway} = BrowserGateway.start_link()
    {:ok, runtime} = Runtime.start_distribution(port: port, cookie: cookie)

    IO.puts(
      Jason.encode!(
        %{
          status: "browser_beam_carrier_listening",
          node: Atom.to_string(runtime.node),
          cookie: Atom.to_string(runtime.cookie),
          ws_dist_port: runtime.port,
          gateway_registered_name: Atom.to_string(LatticeCarrierSpike.gateway_name()),
          tab_id: tab.id,
          cap_id: cap.id,
          logical_frame: %{
            type: "lattice_call",
            request_id: "browser-1",
            tab_id: tab.id,
            cap_id: cap.id,
            payload: %{op: "echo", body: "hello from browser BEAM carrier"}
          }
        },
        pretty: true
      )
    )

    Process.sleep(:infinity)
  end
end
