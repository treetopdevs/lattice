defmodule Lattice.Demo.FederatedWorkers do
  @moduledoc """
  Federated browser-worker simulation.

  This uses in-process tab transports to model browser/worker realms. It does
  not claim AtomVM/WASM or real distribution.
  """

  alias Lattice.Demo.LocalTab

  def run_demo do
    {:ok, _pid_a, tab_a} = LocalTab.connect(identity: %{worker: "a"})

    {:ok, pid_b, tab_b} =
      LocalTab.connect(
        identity: %{worker: "b"},
        handlers: [
          relay: fn payload -> %{worker_b_received: payload[:body] || payload["body"]} end
        ]
      )

    {:ok, direct_cap} = Lattice.grant(tab_a.id, {:tab, tab_b.id}, [:call])
    denied_direct = Lattice.call(tab_a.id, direct_cap, %{op: :relay, body: "direct"})

    {:ok, bridge_cap} = Lattice.bridge(tab_a.id, tab_b.id, [:call], ttl: 5_000)
    bridged = Lattice.call(tab_a.id, bridge_cap, %{op: :relay, body: "mediated"})

    %{denied_direct: denied_direct, bridged: bridged, worker_b_messages: LocalTab.messages(pid_b)}
  end
end
