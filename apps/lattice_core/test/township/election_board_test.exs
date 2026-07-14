defmodule Township.ElectionBoardTest do
  use ExUnit.Case, async: true

  alias Lattice.{Log, Sim}
  alias Township.Election.ArtifactRef
  alias Township.ElectionBoard

  @replica "replica:township-election-board:test"
  @max_bytes 1_024
  @commands [
    abort_election: 3,
    attest_close: 3,
    certify_close: 2,
    configure_election: 2,
    open_election: 4,
    propose_close: 2,
    publish_box_seal: 2,
    publish_protocol_artifact: 6,
    publish_roster: 2,
    publish_setup: 2,
    publish_tally: 4,
    submit_ballot: 2
  ]

  test "the board declares the complete command surface and no trusted materialized state" do
    declared =
      ElectionBoard.__lattice_commands__()
      |> Enum.map(fn {name, arity, _args} -> {name, arity} end)
      |> Enum.sort()

    assert declared == Enum.sort(@commands)
    assert ElectionBoard.__lattice_fields__() == []
  end

  test "service capabilities restrict command families and a ballot outer op is box-authored" do
    sim =
      Sim.new(ElectionBoard, @replica, ["supervisor", "registrar", "box", "trustee", "voter"],
        seed: "election-board-roles"
      )

    {sim, _genesis} = Sim.create_replica(sim, "supervisor")
    {sim, registrar_cap} = Sim.grant(sim, "supervisor", "registrar", ops: [:publish_roster])

    {sim, _box_cap} =
      Sim.grant(sim, "supervisor", "box", ops: [:submit_ballot, :publish_box_seal, :attest_close])

    {sim, _trustee_cap} =
      Sim.grant(sim, "supervisor", "trustee", ops: [:publish_protocol_artifact, :publish_tally])

    sim = Sim.sync_all(sim)
    ballot_ref = artifact_term("opaque encrypted ballot")

    {sim, ballot_op} =
      Sim.command(sim, "box", :submit_ballot, ["election-id", ballot_ref])

    assert Sim.quarantined(sim, "box", ballot_op.id) == false
    assert ballot_op.author == Sim.identity(sim, "box").pub
    refute ballot_op.author == Sim.identity(sim, "voter").pub
    assert ballot_op.kind == :command
    assert ballot_op.body == {:submit_ballot, ["election-id", ballot_ref]}
    refute contains?(ballot_op.body, Sim.identity(sim, "voter").pub)

    {sim, wrong_family} =
      Sim.command(sim, "registrar", :submit_ballot, ["election-id", ballot_ref],
        cap: registrar_cap.id
      )

    assert {true, :operation_not_granted} =
             Sim.quarantined(sim, "registrar", wrong_family.id)

    {sim, voter_authored} =
      Sim.command(sim, "voter", :submit_ballot, ["election-id", ballot_ref], cap: :none)

    assert {true, :no_capability} = Sim.quarantined(sim, "voter", voter_authored.id)
    assert Lattice.state(ElectionBoard, Sim.log(sim, "box")) == %{}
  end

  test "append, duplicate delivery, sync, and dump/restore preserve board artifact op ids" do
    sim = Sim.new(ElectionBoard, @replica, ["supervisor", "box"], seed: "election-board-replay")
    {sim, _genesis} = Sim.create_replica(sim, "supervisor")
    {sim, _cap} = Sim.grant(sim, "supervisor", "box", ops: [:submit_ballot])
    sim = Sim.sync_all(sim)

    {sim, ballot_op} =
      Sim.command(sim, "box", :submit_ballot, ["election-id", artifact_term("ballot")])

    supervisor_log = Sim.log(sim, "supervisor")
    {:ok, delivered_once} = Log.accept(supervisor_log, ballot_op)
    {:ok, delivered_twice} = Log.accept(delivered_once, ballot_op)
    assert Log.op_ids(delivered_twice) == Log.op_ids(delivered_once)

    sim = Sim.sync_all(sim)
    assert Log.has?(Sim.log(sim, "supervisor"), ballot_op.id)
    assert Log.has?(Sim.log(sim, "box"), ballot_op.id)

    path =
      Path.join(System.tmp_dir!(), "election_board_#{System.unique_integer([:positive])}.log")

    on_exit(fn -> File.rm(path) end)

    :ok = Log.dump(Sim.log(sim, "supervisor"), path)
    assert {:ok, restored} = Log.restore(path)
    assert Log.op_ids(restored) == Log.op_ids(Sim.log(sim, "supervisor"))
    assert Log.fetch(restored, ballot_op.id) == {:ok, ballot_op}
  end

  defp artifact_term(bytes) do
    {:ok, ref} =
      ArtifactRef.new(bytes,
        codec: "township-artifact-v1",
        profile: "research-profile",
        max_byte_size: @max_bytes
      )

    ArtifactRef.to_canonical_term(ref)
  end

  defp contains?(term, needle) when term == needle, do: true
  defp contains?(term, needle) when is_list(term), do: Enum.any?(term, &contains?(&1, needle))

  defp contains?(term, needle) when is_tuple(term),
    do: term |> Tuple.to_list() |> contains?(needle)

  defp contains?(term, needle) when is_map(term),
    do: Enum.any?(term, fn {key, value} -> contains?(key, needle) or contains?(value, needle) end)

  defp contains?(_term, _needle), do: false
end
