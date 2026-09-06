defmodule Lattice2.CommandEffectsTest do
  use ExUnit.Case, async: true

  alias Lattice.{Op, Sim}

  defmodule Effects do
    use Lattice.Replica

    state do
      field(:title, merge: :lww, default: "")
      field(:items, merge: :causal_list)
      field(:members, merge: :or_set)
      field(:guarded, authority: :moderator, default: false)
    end

    command(:effects, [:effects], do: effects)
    command(:denied, [:value], do: [{:title, {:write, value}}, {:items, {:append, value}}])
    command(:required_value, [:input], do: [{:title, {:write, Map.fetch!(input, "value")}}])
    command(:divide, [:denominator], do: [{:title, {:write, div(10, denominator)}}])

    def command_op_status(%Op{body: {:denied, [_]}}, _, _), do: {:error, :application_denied}
    def command_op_status(_, _, _), do: :ok
  end

  defp founded do
    Effects
    |> Sim.new("replica:effects", ["root", "peer"], seed: "effects")
    |> Sim.create_replica("root")
    |> elem(0)
  end

  test "a malformed later effect refuses the whole signed command" do
    sim = founded()

    for bad <- [
          {:missing, {:write, "bad"}},
          {:items, {:write, "bad"}},
          {:items, {:delete, 7}},
          {:title, :malformed},
          :malformed
        ] do
      {candidate, op} = Sim.command(sim, "root", :effects, [[{:title, {:write, "partial"}}, bad]])
      assert {true, :malformed_command} == Sim.quarantined(candidate, "root", op.id)
      assert Sim.state(candidate, "root") == Sim.state(sim, "root")
    end
  end

  test "application evaluator errors quarantine hostile signed arguments without stopping replay" do
    sim = founded()

    for {command, args} <- [{:required_value, [%{}]}, {:divide, [0]}] do
      {candidate, op} = Sim.command(sim, "root", command, args)
      assert {true, :malformed_command} == Sim.quarantined(candidate, "root", op.id)
      assert Sim.state(candidate, "root") == Sim.state(sim, "root")
      {candidate, valid} = Sim.command(candidate, "root", :required_value, [%{"value" => "safe"}])
      assert false == Sim.quarantined(candidate, "root", valid.id)
      assert Sim.state(candidate, "root").title == "safe"
    end
  end

  test "ordered effects share one op while keeping all inserted elements and last same-op write" do
    sim = founded()

    {sim, op} =
      Sim.command(sim, "root", :effects, [
        [
          {:title, {:write, "z"}},
          {:items, {:append, "first"}},
          {:title, {:write, "a"}},
          {:items, {:append, "second"}},
          {:members, {:add, "member"}},
          {:members, {:remove, "member"}}
        ]
      ])

    assert false == Sim.quarantined(sim, "root", op.id)
    assert Sim.state(sim, "root").title == "a"
    assert Sim.state(sim, "root").items == ["first", "second"]
    assert Sim.state(sim, "root").members == []
    assert map_size(Lattice.Log.ops(Sim.log(sim, "root"))) == 2
  end

  test "a later authority effect and application refusal each deny every effect" do
    sim = founded()
    {sim, _} = Sim.grant(sim, "root", "peer", ops: [:effects, :denied])
    sim = Sim.sync_all(sim)

    {sim, denied_role} =
      Sim.command(sim, "peer", :effects, [
        [{:title, {:write, "partial"}}, {:guarded, {:write, true}}]
      ])

    {sim, denied_policy} = Sim.command(sim, "root", :denied, ["partial"])
    sim = Sim.sync_all(sim)
    assert {true, :role_not_granted} == Sim.quarantined(sim, "root", denied_role.id)
    assert {true, :application_denied} == Sim.quarantined(sim, "root", denied_policy.id)
    assert Sim.state(sim, "root").title == ""
    assert Sim.state(sim, "root").items == []
  end

  test "ordered same-target list edits choose the last effect even when its text sorts lower" do
    sim = founded()
    {sim, post} = Sim.command(sim, "root", :effects, [[{:items, {:append, "original"}}]])

    {sim, edit} =
      Sim.command(sim, "root", :effects, [
        [{:items, {:edit, post.id, "z"}}, {:items, {:edit, post.id, "a"}}]
      ])

    assert false == Sim.quarantined(sim, "root", edit.id)
    assert Sim.state(sim, "root").items == ["a"]
  end
end
