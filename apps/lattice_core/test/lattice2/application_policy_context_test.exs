defmodule Lattice2.ApplicationPolicyContextTest do
  @moduledoc """
  Plan 158 Wave A2 regressions for causal application-policy context and the
  deterministic full-frontier conflict phase.
  """
  use ExUnit.Case, async: true

  alias Lattice.{Log, Op, Sim}

  defmodule PolicyReplica do
    @moduledoc false
    use Lattice.Replica

    state do
      field(:events, merge: :causal_list, default: [])
    end

    command(:source, [:label], do: [{:events, {:append, {:source, label}}}])
    command(:reference, [:target_id], do: [{:events, {:append, {:reference, target_id}}}])
    command(:deny, [:label], do: [{:events, {:append, {:denied, label}}}])
    command(:claim, [:key, :label], do: [{:events, {:append, {:claim, key, label}}}])

    def command_op_status(%Op{body: {:deny, [_label]}}, _visible_ids, _context),
      do: {:error, :application_denied}

    def command_op_status(
          %Op{body: {:reference, [target_id]}},
          visible_ids,
          %{visible_ops: visible_ops, verdicts: verdicts}
        ) do
      cond do
        not MapSet.member?(visible_ids, target_id) ->
          {:error, :application_target_not_visible}

        not Map.has_key?(visible_ops, target_id) ->
          {:error, :application_target_not_visible}

        Map.get(verdicts, target_id) != :honored ->
          {:error, :application_target_quarantined}

        not match?(%Op{kind: :command, body: {:source, [_]}}, visible_ops[target_id]) ->
          {:error, :application_wrong_target}

        true ->
          :ok
      end
    end

    def command_op_status(_op, _visible_ids, _context), do: :ok

    def command_conflicts(ops, verdicts, ancestors) do
      ops
      |> Map.values()
      |> Enum.filter(fn
        %Op{id: id, kind: :command, body: {:claim, [_key, _label]}} ->
          Map.get(verdicts, id) == :honored

        _other ->
          false
      end)
      |> Enum.group_by(fn %Op{body: {:claim, [key, _label]}} -> key end)
      |> Enum.reduce(%{}, fn {_key, claims}, conflicts ->
        claims
        |> Enum.sort_by(& &1.id)
        |> conflict_losers(ancestors)
        |> Enum.reduce(conflicts, &Map.put(&2, &1.id, :application_conflict))
      end)
    end

    defp conflict_losers([], _ancestors), do: []

    defp conflict_losers([winner | rest], ancestors) do
      Enum.filter(rest, fn candidate ->
        winner_visible = Map.get(ancestors, candidate.id, MapSet.new())
        candidate_visible = Map.get(ancestors, winner.id, MapSet.new())

        not MapSet.member?(winner_visible, winner.id) and
          not MapSet.member?(candidate_visible, candidate.id)
      end)
    end
  end

  @replica "replica:application-policy-context"

  defp founded(realms \\ ["root", "peer"]) do
    PolicyReplica
    |> Sim.new(@replica, realms, seed: "application-policy-context")
    |> Sim.create_replica("root")
    |> elem(0)
    |> Sim.sync_all()
  end

  test "the /3 callback receives the exact honored causal target" do
    sim = founded()
    {sim, source} = Sim.command(sim, "root", :source, ["honored"])
    {sim, reference} = Sim.command(sim, "root", :reference, [source.id])
    sim = Sim.sync_all(sim)

    assert false == Sim.quarantined(sim, "root", source.id)
    assert false == Sim.quarantined(sim, "root", reference.id)
    assert {:reference, source.id} in Sim.state(sim, "root").events
  end

  test "a concurrent target is not visible to application policy" do
    sim = founded()
    {sim, _delegation} = Sim.grant(sim, "root", "peer", ops: [:source])
    sim = Sim.sync_all(sim) |> Sim.partition("root", "peer")

    {sim, source} = Sim.command(sim, "peer", :source, ["concurrent"])
    {sim, reference} = Sim.command(sim, "root", :reference, [source.id])
    sim = sim |> Sim.heal("root", "peer") |> Sim.sync_all()

    assert {true, :application_target_not_visible} =
             Sim.quarantined(sim, "root", reference.id)

    refute {:reference, source.id} in Sim.state(sim, "root").events
  end

  test "malformed, authority-denied, and application-denied targets stay unusable" do
    sim = founded()

    {sim, malformed} = Sim.append(sim, "root", :command, :malformed)
    {sim, malformed_ref} = Sim.command(sim, "root", :reference, [malformed.id])

    {sim, no_capability} = Sim.command(sim, "root", :source, ["no-cap"], cap: :none)
    {sim, no_capability_ref} = Sim.command(sim, "root", :reference, [no_capability.id])

    {sim, denied} = Sim.command(sim, "root", :deny, ["application"])
    {sim, denied_ref} = Sim.command(sim, "root", :reference, [denied.id])
    sim = Sim.sync_all(sim)

    assert {true, :malformed_command} = Sim.quarantined(sim, "root", malformed.id)
    assert {true, :no_capability} = Sim.quarantined(sim, "root", no_capability.id)
    assert {true, :application_denied} = Sim.quarantined(sim, "root", denied.id)

    for reference <- [malformed_ref, no_capability_ref, denied_ref] do
      assert {true, :application_target_quarantined} =
               Sim.quarantined(sim, "root", reference.id)
    end
  end

  test "wrong target kind is decided after causal presence and honored verdict" do
    sim = founded()
    {sim, claim} = Sim.command(sim, "root", :claim, ["key", "not-source"])
    {sim, reference} = Sim.command(sim, "root", :reference, [claim.id])
    sim = Sim.sync_all(sim)

    assert false == Sim.quarantined(sim, "root", claim.id)
    assert {true, :application_wrong_target} = Sim.quarantined(sim, "root", reference.id)
  end

  test "full-frontier conflicts choose one canonical winner after partial-frontier honor" do
    sim = founded()
    {sim, _delegation} = Sim.grant(sim, "root", "peer", ops: [:claim])
    sim = Sim.sync_all(sim) |> Sim.partition("root", "peer")

    {sim, root_claim} = Sim.command(sim, "root", :claim, ["seat", "root"])
    {sim, peer_claim} = Sim.command(sim, "peer", :claim, ["seat", "peer"])

    assert false == Sim.quarantined(sim, "root", root_claim.id)
    assert false == Sim.quarantined(sim, "peer", peer_claim.id)

    sim = sim |> Sim.heal("root", "peer") |> Sim.sync_all()
    [winner_id, loser_id] = Enum.sort([root_claim.id, peer_claim.id])

    assert false == Sim.quarantined(sim, "root", winner_id)
    assert {true, :application_conflict} = Sim.quarantined(sim, "root", loser_id)

    claims =
      for {:claim, "seat", label} <- Sim.state(sim, "root").events,
          do: label

    assert length(claims) == 1
  end

  test "legacy /2 callbacks remain the compatibility adapter" do
    assert function_exported?(Toolshed.Tool, :command_op_status, 2)
    assert function_exported?(Toolshed.Tool, :command_op_status, 3)

    sim =
      Toolshed.Tool
      |> Sim.new("replica:policy-context:legacy", ["owner"], seed: "policy-context-legacy")
      |> Sim.create_replica("owner")
      |> elem(0)

    assert %Log{} = Sim.log(sim, "owner")
  end
end
