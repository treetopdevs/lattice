defmodule LatticeCore.FlagshipTest do
  use ExUnit.Case, async: false

  setup do
    Lattice.Flagship.reset()
    :ok
  end

  test "flagship story proves allowed purchase and denied overreach without delivery" do
    assert {:ok, snapshot} = Lattice.Flagship.connect()
    assert step_status(snapshot, :connect) == "done"

    assert {:ok, snapshot} = Lattice.Flagship.grant()
    assert step_status(snapshot, :grant) == "done"
    assert snapshot.cap["caveats"] != []

    assert {:ok, allowed} = Lattice.Flagship.allowed()
    assert allowed.results.allowed.delivered_to_wallet? == true
    assert allowed.wallet.delivery_count == 1

    assert {:ok, over_budget} = Lattice.Flagship.over_budget()
    assert over_budget.results.over_budget.result.ok == false
    assert over_budget.results.over_budget.delivered_to_wallet? == false
    assert over_budget.wallet.delivery_count == 1

    assert {:ok, wrong_vendor} = Lattice.Flagship.wrong_vendor()
    assert wrong_vendor.results.wrong_vendor.result.error == ":vendor_not_allowed"
    assert wrong_vendor.wallet.delivery_count == 1

    assert {:ok, stolen} = Lattice.Flagship.stolen()
    assert stolen.results.stolen.result.error == ":wrong_owner"
    assert stolen.wallet.delivery_count == 1

    assert {:ok, revoked} = Lattice.Flagship.revoke()
    assert step_status(revoked, :revoke) == "done"

    assert {:ok, replay} = Lattice.Flagship.replay()
    assert replay.results.replay.result.error == ":revoked"
    assert replay.results.replay.delivered_to_wallet? == false
    assert replay.wallet.delivery_count == 1

    assert Enum.any?(replay.audit_events, &(&1.type == :cap_use))
    assert Enum.count(replay.audit_events, &(&1.type == :deny)) >= 4
    assert Enum.any?(replay.audit_events, &(&1.type == :revoke))

    assert Enum.any?(replay.graph.edges, &(edge_kind(&1) == "denied_attempt"))
    assert Enum.any?(replay.graph.edges, &(edge_kind(&1) == "revoked"))
  end

  test "flagship exports use the same graph source as the live inspector" do
    assert {:ok, _snapshot} = Lattice.Flagship.run_all()

    assert {:ok, json} = Lattice.Flagship.export("json")
    assert %{"graph" => %{"nodes" => nodes, "edges" => edges}} = Jason.decode!(json)
    assert is_list(nodes)
    assert is_list(edges)

    assert {:ok, mermaid} = Lattice.Flagship.export("mermaid")
    assert mermaid =~ "graph TD"
    assert mermaid =~ "denied_attempt"

    assert {:ok, dot} = Lattice.Flagship.export("dot")
    assert dot =~ "digraph lattice"
    assert dot =~ "denied_attempt"
  end

  defp step_status(snapshot, step) do
    snapshot.story
    |> Enum.find(&(&1.id == step))
    |> Map.fetch!(:status)
    |> to_string()
  end

  defp edge_kind(edge), do: edge[:kind] || edge["kind"]
end
