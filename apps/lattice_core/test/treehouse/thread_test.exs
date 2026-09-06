defmodule Treehouse.ThreadTest do
  use ExUnit.Case, async: true

  alias Lattice.{Log, Sim, Sync}
  alias Treehouse.Thread

  defp founded do
    {sim, _} =
      Thread
      |> Sim.new("treehouse:thread:test", ["root", "alice", "bob"], seed: "thread")
      |> Sim.create_replica("root")

    {sim, _} = Sim.command(sim, "root", :create_thread, ["Canopy"])
    {sim, _} = Sim.grant(sim, "root", "alice", ops: [:post, :author_edit, :author_tombstone])
    {sim, _} = Sim.grant(sim, "root", "bob", ops: [:post, :author_edit, :author_tombstone])
    Sim.sync_all(sim)
  end

  test "an author edits an honored lineage without moving the original post and cannot revive a tombstone" do
    sim = founded()
    {sim, post} = Sim.command(sim, "alice", :post, ["original"])
    {sim, _second} = Sim.command(sim, "alice", :post, ["second"])
    {sim, edit} = Sim.command(sim, "alice", :author_edit, [post.id, post.id, "edited"])
    {sim, edit2} = Sim.command(sim, "alice", :author_edit, [post.id, edit.id, "latest"])
    assert false == Sim.quarantined(sim, "alice", edit2.id)
    assert Sim.state(sim, "alice").posts == ["latest", "second"]
    {sim, _deleted} = Sim.command(sim, "alice", :author_tombstone, [post.id, edit2.id])
    {sim, revive} = Sim.command(sim, "alice", :author_edit, [post.id, edit2.id, "revived"])
    assert {true, :application_already_tombstoned} == Sim.quarantined(sim, "alice", revive.id)
    assert Sim.state(sim, "alice").posts == ["second"]
  end

  test "causal archive denies post and author changes; moderator can tombstone and repeat archive" do
    sim = founded()
    {sim, post} = Sim.command(sim, "alice", :post, ["retained"])
    sim = Sim.sync_all(sim)
    {sim, archived} = Sim.command(sim, "root", :archive_thread, [])
    {sim, repeat} = Sim.command(sim, "root", :archive_thread, [])
    sim = Sim.sync_all(sim)
    assert archived.id != repeat.id
    assert false == Sim.quarantined(sim, "root", repeat.id)

    for {command, args} <- [
          {:post, ["late"]},
          {:author_edit, [post.id, post.id, "late"]},
          {:author_tombstone, [post.id, post.id]}
        ] do
      {candidate, op} = Sim.command(sim, "alice", command, args)
      assert {true, :application_archived_thread} == Sim.quarantined(candidate, "alice", op.id)
      assert Sim.state(candidate, "alice").posts == ["retained"]
    end

    {sim, tombstone} = Sim.command(sim, "root", :moderator_tombstone, [post.id, post.id])
    assert false == Sim.quarantined(sim, "root", tombstone.id)
    assert Sim.state(sim, "root").archived
    assert Sim.state(sim, "root").posts == []
    assert Map.has_key?(Log.ops(Sim.log(sim, "root")), repeat.id)
  end

  test "concurrent post and edits survive partition while the canonical edit wins" do
    sim = founded()
    {sim, post} = Sim.command(sim, "alice", :post, ["original"])
    sim = Sim.sync_all(sim) |> Sim.partition("root", "alice") |> Sim.partition("bob", "alice")
    {sim, _archive} = Sim.command(sim, "root", :archive_thread, [])
    {sim, concurrent} = Sim.command(sim, "alice", :post, ["concurrent"])
    {sim, edit} = Sim.command(sim, "alice", :author_edit, [post.id, post.id, "edited"])
    sim = sim |> Sim.heal("root", "alice") |> Sim.heal("bob", "alice") |> Sim.sync_all()
    assert false == Sim.quarantined(sim, "root", concurrent.id)
    assert false == Sim.quarantined(sim, "root", edit.id)
    assert Sim.state(sim, "root").posts == ["edited", "concurrent"]
    assert Sim.state(sim, "root") == Sim.state(sim, "alice")
  end

  test "target and author refusals precede archive, and quarantined lineage cannot be laundered" do
    sim = founded()
    {sim, post} = Sim.command(sim, "alice", :post, ["original"])
    sim = Sim.sync_all(sim)
    {sim, wrong_author} = Sim.command(sim, "bob", :author_edit, [post.id, post.id, "forged"])
    sim = Sim.sync_all(sim)
    {sim, _archive} = Sim.command(sim, "root", :archive_thread, [])
    sim = Sim.sync_all(sim)
    {sim, missing} = Sim.command(sim, "bob", :author_edit, ["missing", "missing", "missing"])
    {sim, wrong} = Sim.command(sim, "bob", :author_tombstone, [post.id, post.id])

    {sim, laundering} =
      Sim.command(sim, "alice", :author_edit, [post.id, wrong_author.id, "laundered"])

    sim = Sim.sync_all(sim)
    assert {true, :application_wrong_author} == Sim.quarantined(sim, "root", wrong_author.id)
    assert {true, :application_target_not_visible} == Sim.quarantined(sim, "root", missing.id)
    assert {true, :application_wrong_author} == Sim.quarantined(sim, "root", wrong.id)
    assert {true, :application_target_quarantined} == Sim.quarantined(sim, "root", laundering.id)
    assert Sim.state(sim, "root").posts == ["original"]
  end

  test "two real author forks choose one canonical edit in either delivery order" do
    sim = founded()
    {sim, post} = Sim.command(sim, "alice", :post, ["original"])
    {_, left} = Sim.command(sim, "alice", :author_edit, [post.id, post.id, "left fork"])
    {_, right} = Sim.command(sim, "alice", :author_edit, [post.id, post.id, "right fork"])
    assert left.deps == right.deps
    expected = if left.id > right.id, do: "left fork", else: "right fork"

    for order <- [[left, right], [right, left]] do
      {log, report} = Sync.deliver(Sim.log(sim, "alice"), order)
      assert report.pending == []
      assert Lattice.Authority.quarantine(Thread, log) == MapSet.new()
      assert Lattice.state(Thread, log).posts == [expected]
    end
  end
end
