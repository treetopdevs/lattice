defmodule LatticeCore.FlagshipTest do
  use ExUnit.Case, async: false

  setup do
    Lattice.Flagship.reset()
    :ok
  end

  test "flagship story proves allowed purchase and denied overreach without delivery" do
    assert {:ok, snapshot} = Lattice.Flagship.connect()
    assert step_status(snapshot, :connect) == "done"
    assert snapshot.presenter.current_step == :connect
    assert snapshot.presenter.next_action == "Next: #{action_label(snapshot, "grant")}"
    assert action_label(snapshot, "run_all")

    assert {:ok, snapshot} = Lattice.Flagship.grant()
    assert step_status(snapshot, :grant) == "done"
    assert snapshot.cap["caveats"] != []
    assert Enum.all?(snapshot.claims, &Map.has_key?(&1, :evidence_refs))
    assert :ok = Lattice.Flagship.Claims.validate!(repo_root())

    assert {:ok, allowed} = Lattice.Flagship.allowed()
    assert allowed.results.allowed.delivered_to_wallet? == true
    assert allowed.wallet.delivery_count == 1

    assert {:ok, over_budget} = Lattice.Flagship.over_budget()
    assert over_budget.results.over_budget.result.ok == false
    assert over_budget.results.over_budget.result.error == ":amount_exceeds_caveat"
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
    assert replay.presenter.next_action =~ "inspect"

    for {action, expected} <- expected_results(replay) do
      result = Map.fetch!(replay.results, action)
      assert result.expected_result == expected
      assert result.result.ok == expected.ok
      assert result.delivered_to_wallet? == expected.delivered_to_wallet?

      if Map.has_key?(expected, :error) do
        assert result.result.error == expected.error
      end
    end
  end

  test "flagship exports use the same graph source as the live inspector" do
    assert {:ok, _snapshot} = Lattice.Flagship.run_all()
    assert %Lattice.Flagship.Snapshot{} = Lattice.Flagship.snapshot()

    assert {:ok, json} = Lattice.Flagship.export("json")
    assert %{"graph" => %{"nodes" => nodes, "edges" => edges}} = decoded = Jason.decode!(json)

    assert [] =
             Enum.map(Lattice.Flagship.Snapshot.required_keys(), &Atom.to_string/1) --
               Map.keys(decoded)

    assert is_list(nodes)
    assert is_list(edges)

    assert {:ok, mermaid} = Lattice.Flagship.export("mermaid")
    assert mermaid =~ "graph TD"
    assert mermaid =~ "denied_attempt"

    assert {:ok, dot} = Lattice.Flagship.export("dot")
    assert dot =~ "digraph lattice"
    assert dot =~ "denied_attempt"

    assert {:ok, claims} = Lattice.Flagship.export("claims")
    assert [%{"id" => "capability_wallet_edge"} | _] = Jason.decode!(claims)
  end

  test "deny audit events without tab metadata stay visible in the graph" do
    assert {:ok, snapshot} = Lattice.Flagship.grant()
    cap_id = snapshot.cap["id"]

    Lattice.Audit.record(:deny, %{cap_id: cap_id, reason: :manual_deny_without_tab})

    edge =
      Lattice.Graph.snapshot().edges
      |> Enum.find(&(&1.kind == "denied_attempt" and &1.reason == ":manual_deny_without_tab"))

    assert edge
    assert edge.from == "process:gateway"
    refute edge.from == "tab:unknown"
  end

  test "reset stops local tab client processes" do
    assert {:ok, snapshot} = Lattice.Flagship.connect()

    tab_ids = [
      snapshot.actors.wallet_tab_id,
      snapshot.actors.planner_tab_id,
      snapshot.actors.red_team_tab_id
    ]

    client_pids =
      Lattice.diagnostics().topology.tabs
      |> Map.take(tab_ids)
      |> Map.values()
      |> Enum.map(& &1.connection_pid)

    assert Enum.all?(client_pids, &Process.alive?/1)

    assert {:ok, _snapshot} = Lattice.Flagship.reset()
    refute Enum.any?(client_pids, &Process.alive?/1)
  end

  defp step_status(snapshot, step) do
    snapshot.story
    |> Enum.find(&(&1.id == step))
    |> Map.fetch!(:status)
    |> to_string()
  end

  defp edge_kind(edge), do: edge.kind
  defp repo_root, do: Path.expand("../../..", __DIR__)

  defp expected_results(snapshot) do
    snapshot.story
    |> Enum.filter(&Map.has_key?(&1, :expected_result))
    |> Map.new(&{&1.id, &1.expected_result})
  end

  defp action_label(snapshot, action_name) do
    snapshot.actions
    |> Enum.find(&(&1.action == action_name))
    |> Map.fetch!(:label)
  end
end
