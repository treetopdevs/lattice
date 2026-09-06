defmodule Treehouse.DomainTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Log, Op, Sim}
  alias Treehouse.{Invitation, ReadModel, Space, Thread}

  test "root-only creation reports retained progress and retries the exact signed name" do
    sim = Sim.new(Space, "treehouse:creation", ["root"], seed: "creation")
    root = Sim.identity(sim, "root")
    assert {:ok, prepared} = Space.prepare_creation(root, Sim.replica(sim), "Canopy")
    assert prepared.status == :uninitialized
    assert prepared.profile == :legacy_root_only
    assert [genesis, name] = prepared.pending
    assert {:genesis, _, %{}} = genesis.body
    assert name.deps == [genesis.id]
    log = Log.append!(Log.new(prepared.replica), genesis)
    assert ReadModel.observe(Space, log).initialization == :incomplete
    assert Lattice.state(Space, log).name == ""
    assert {:ok, retry} = Space.prepare_creation(root, prepared.replica, "Canopy", log)
    assert retry.status == :incomplete
    assert retry.pending == [name]
    ready = Log.append!(log, name)
    assert ReadModel.observe(Space, ready).initialization == :ready

    assert {:ok, %{status: :ready, pending: []}} =
             Space.prepare_creation(root, prepared.replica, "Canopy", ready)

    assert {:error, :different_initialization} =
             Space.prepare_creation(root, prepared.replica, "Other", ready)

    assert {:error, :wrong_replica} =
             Space.prepare_creation(root, prepared.replica, "Canopy", Log.new("other"))

    assert Lattice.state(Space, ready).name == "Canopy"
  end

  test "moderator and admin vocabulary transfers actual independent holders in one signed op" do
    {sim, genesis} =
      Space
      |> Sim.new("treehouse:roles", ["root", "alice", "bob"], seed: "roles")
      |> Sim.create_replica("root")

    root = Sim.identity(sim, "root")
    alice = Sim.identity(sim, "alice")
    bob = Sim.identity(sim, "bob")
    {:genesis, parent, _} = genesis.body
    log = Sim.log(sim, "root")
    {mod_op, mod_cap} = Space.change_moderator(root, log, alice.pub, parent)
    assert {:transfer, :moderator, ^mod_cap, 0} = mod_op.body
    log = Log.append!(log, mod_op)
    assert ReadModel.observe(Space, log).holders == %{admin: root.pub, moderator: alice.pub}
    {admin_op, admin_cap} = Space.transfer_admin(root, log, bob.pub, parent)
    log = Log.append!(log, admin_op)
    assert ReadModel.observe(Space, log).holders == %{admin: bob.pub, moderator: alice.pub}
    {stale, _} = Space.change_moderator(root, log, bob.pub, parent)
    {current, _} = Space.change_moderator(alice, log, bob.pub, mod_cap)
    log = log |> Log.append!(stale) |> Log.append!(current)
    assert Authority.analyze(Space, log).reasons[stale.id] == :transfer_not_holder
    refute Map.has_key?(Authority.analyze(Space, log).reasons, current.id)
    assert Authority.holder(Space, log, :moderator) == bob.pub

    name =
      Op.new(bob, log.replica, Log.frontier(log), :command, {:create_space, ["New admin"]},
        cap: admin_cap.id
      )

    log = Log.append!(log, name)
    assert Lattice.state(Space, log).name == "New admin"
    assert map_size(Log.ops(log)) == 6
    assert Lattice.state(Space, log).moderator_actions == nil
  end

  test "a recipient accepts the exact causal invitation before root admission" do
    sim = Sim.new(Space, "treehouse:space:domain", ["root", "member"], seed: "treehouse-domain")
    {sim, _genesis} = Sim.create_replica(sim, "root")
    {sim, _create} = Sim.command(sim, "root", :create_space, ["Canopy"])
    {sim, _thread} = Sim.command(sim, "root", :create_thread, ["treehouse:thread:one", "One"])
    recipient = sim |> Sim.identity("member") |> Map.fetch!(:pub) |> Base.encode64()

    {sim, invite} =
      Sim.command(sim, "root", :issue_invitation, [recipient, ["treehouse:thread:one"]])

    acceptance = Invitation.accept(Sim.identity(sim, "member"), Sim.replica(sim), invite)

    {sim, admitted} =
      Sim.command(sim, "root", :admit_member, [invite.id, recipient, "member", acceptance])

    sim = Sim.sync_all(sim)

    assert false == Sim.quarantined(sim, "member", admitted.id)
    assert Sim.state(sim, "member").name == "Canopy"
    assert Sim.state(sim, "member").members == [recipient]
    assert Sim.state(sim, "root") == Sim.state(sim, "member")
  end

  test "malformed Space values never enter state through an otherwise authorized command" do
    {sim, _} =
      Space
      |> Sim.new("treehouse:space:shapes", ["root"], seed: "shape")
      |> Sim.create_replica("root")

    for {command, args} <- [
          {:create_space, [%{}]},
          {:create_space, [<<255>>]},
          {:create_thread, [nil, 42]},
          {:create_thread, ["", "title"]},
          {:create_thread, ["thread", %{}]},
          {:remove_member, ["not-a-key"]}
        ] do
      {candidate, op} = Sim.command(sim, "root", command, args)
      assert {true, :malformed_command} == Sim.quarantined(candidate, "root", op.id)
      assert Sim.state(candidate, "root") == Sim.state(sim, "root")
    end
  end

  test "archive retains the authorized Space reference and unavailable history is not an empty Thread" do
    {space, _} =
      Space
      |> Sim.new("treehouse:space:reference", ["root"], seed: "references")
      |> Sim.create_replica("root")

    {thread, _} =
      Thread
      |> Sim.new("treehouse:thread:reference", ["root"], seed: "references")
      |> Sim.create_replica("root")

    {space, reference} =
      Sim.command(space, "root", :create_thread, [Sim.replica(thread), "Retained"])

    {thread, post} = Sim.command(thread, "root", :post, ["history"])

    {thread, edit} =
      Sim.command(thread, "root", :author_edit, [post.id, post.id, "edited history"])

    {thread, _} = Sim.command(thread, "root", :archive_thread, [])
    {thread, repeat} = Sim.command(thread, "root", :archive_thread, [])
    space_log = Sim.log(space, "root")
    thread_log = Sim.log(thread, "root")

    assert {:error, :thread_unavailable} == ReadModel.thread(space_log, Sim.replica(thread), nil)
    assert {:error, :wrong_replica} == ReadModel.thread(space_log, Sim.replica(thread), space_log)

    assert {:error, :thread_not_authorized} ==
             ReadModel.thread(space_log, "extra-route", thread_log)

    assert {:ok, view} = ReadModel.thread(space_log, Sim.replica(thread), thread_log)
    assert view.state.archived
    assert view.posts == [%{id: post.id, author: post.author, text: "edited history"}]
    assert view.operation_count == 5
    assert edit.id in view.order and repeat.id in view.order
    assert Map.has_key?(Lattice.Log.ops(space_log), reference.id)

    assert Sim.state(space, "root").threads == [
             %{"replica" => Sim.replica(thread), "title" => "Retained"}
           ]
  end
end
