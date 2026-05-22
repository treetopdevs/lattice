defmodule Lattice.Demo.FederatedWorkers do
  @moduledoc """
  Federated browser-worker demo.

  The demonstrable path uses real browser `Worker` instances that connect to
  Lattice over the WebSocket tab boundary. A caller supplies the connected
  worker tab ids; this module then proves the topology rules with one denied
  direct tab cap and one explicit mediated bridge.
  """

  @default_ttl 5_000

  def run_demo do
    %{
      mode: :browser_worker,
      status: :requires_connected_browser_workers,
      worker_client: "/worker-client.js",
      endpoint: "/api/federated-workers/run"
    }
  end

  def run_demo(from_worker_tab_id, to_worker_tab_id, opts \\ [])
      when is_binary(from_worker_tab_id) and is_binary(to_worker_tab_id) do
    ttl = Keyword.get(opts, :ttl, @default_ttl)

    with {:ok, direct_cap} <- Lattice.grant(from_worker_tab_id, {:tab, to_worker_tab_id}, [:call]),
         denied_direct <-
           Lattice.call(from_worker_tab_id, direct_cap, %{"op" => "relay", "body" => "direct"}),
         :ok <- Lattice.revoke(direct_cap, :direct_worker_probe_closed),
         {:ok, bridge_cap} <-
           Lattice.bridge(from_worker_tab_id, to_worker_tab_id, [:call], ttl: ttl),
         bridged <-
           Lattice.call(from_worker_tab_id, bridge_cap, %{
             "op" => "relay",
             "body" => Keyword.get(opts, :body, "mediated")
           }),
         :ok <- Lattice.revoke(bridge_cap, :browser_worker_bridge_closed) do
      %{
        mode: :browser_worker,
        from_worker_tab_id: from_worker_tab_id,
        to_worker_tab_id: to_worker_tab_id,
        denied_direct: denied_direct,
        bridged: bridged,
        direct_cap_id: direct_cap.id,
        bridge_cap_id: bridge_cap.id
      }
    end
  end
end
