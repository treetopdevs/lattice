defmodule Mix.Tasks.Lattice.BrowserCarrier.Proof do
  @moduledoc """
  Runs the browser BEAM carrier boundary proof and writes a JSON artifact.
  """

  use Mix.Task

  alias LatticeCarrierSpike.{BrowserGateway, EchoTarget, Filter}

  @shortdoc "Run the Lattice browser BEAM carrier spike proof"

  @impl true
  def run(args) do
    Mix.Task.run("app.start")

    {opts, _rest, _invalid} = OptionParser.parse(args, strict: [out: :string])
    out_dir = Keyword.get(opts, :out, "output/browser_beam_carrier")
    File.mkdir_p!(out_dir)

    Lattice.reset!()

    {:ok, target} = EchoTarget.start_link(owner: self())

    {:ok, tab} =
      Lattice.connect_tab(%{
        transport: :browser_beam_carrier,
        connection_pid: self(),
        identity: %{surface: "browser-beam-carrier", agent: "popcorn"}
      })

    {:ok, cap} = Lattice.grant(tab.id, target, [:call], audit: %{carrier: "web_socket_dist"})
    {:ok, gateway} = BrowserGateway.start_link(reply_nodes: fn -> [] end)

    frame =
      LatticeCarrierSpike.logical_call_frame(%{
        request_id: "proof-1",
        tab_id: tab.id,
        cap_id: cap.id,
        payload: %{"op" => "echo", "body" => "hello from browser BEAM carrier"}
      })

    :ok = Filter.filter({:reg_send, self(), :unused, LatticeCarrierSpike.gateway_name()}, frame)
    :ok = BrowserGateway.logical_call(gateway, frame)

    receive do
      {:carrier_target_call, _envelope} -> :ok
    after
      1_000 -> Mix.raise("carrier logical call did not reach target")
    end

    hostile_results =
      Enum.map(LatticeCarrierSpike.hostile_frames(), fn {name, control, payload} ->
        {name, Filter.filter(control, payload)}
      end)

    gateway_state = GenServer.call(gateway, :state)
    graph = Lattice.Graph.snapshot()

    proof = %{
      status: "sidecar_filter_and_gateway_proven",
      acceptance_target:
        "server-side boundary only; browser Popcorn/dist package remains a research blocker",
      tab_id: tab.id,
      cap_id: cap.id,
      target_call_count: EchoTarget.stats(target).call_count,
      gateway_replies: Enum.reverse(gateway_state.replies),
      hostile_results:
        Enum.map(hostile_results, fn {name, result} ->
          %{name: Atom.to_string(name), result: inspect(result)}
        end),
      audit_types: Enum.map(Lattice.audit_events(), & &1.type),
      graph: %{
        audit_event_count: graph.audit_event_count,
        node_count: length(graph.nodes),
        edge_count: length(graph.edges)
      }
    }

    artifact = Path.join(out_dir, "browser-beam-carrier-proof.json")
    File.write!(artifact, Jason.encode!(proof, pretty: true))

    IO.puts("Lattice browser BEAM carrier boundary proof wrote #{artifact}")
    IO.puts("status: #{proof.status}")
  end
end
