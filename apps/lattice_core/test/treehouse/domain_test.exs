defmodule Treehouse.DomainTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Log, Op, Sim}
  alias Treehouse.{Invitation, ReadModel, Space, Thread}

  test "creation refuses forged, misindexed, cross-replica and incomplete retained history" do
    sim = Sim.new(Space, "treehouse:retained-input", ["root"], seed: "retained-input")
    root = Sim.identity(sim, "root")
    {:ok, prepared} = Space.prepare_creation(root, Sim.replica(sim), "Canopy")
    [genesis, name] = prepared.pending
    valid = Enum.reduce(prepared.pending, Log.new(prepared.replica), &Log.append!(&2, &1))

    for forged <- [
          %{valid | ops: Map.put(valid.ops, name.id, %{name | sig: <<0::512>>})},
          %{
            valid
            | ops: Map.put(valid.ops, name.id, %{name | body: {:create_space, ["forged"]}})
          },
          %{valid | ops: %{genesis.id => genesis, "wrong-map-key" => name}},
          %{valid | ops: %{name.id => name}},
          %{valid | ops: Map.put(valid.ops, name.id, %{name | replica: "wrong"})},
          %{valid | ops: %{genesis.id => :not_an_op}}
        ] do
      assert {:error, :invalid_retained_log} ==
               Space.prepare_creation(root, prepared.replica, "Canopy", forged)
    end
  end

  test "membership removal needs the actual issuer's independent replica revocations" do
    {space, _} =
      Space
      |> Sim.new("treehouse:remove:space", ["root", "member"], seed: "remove")
      |> Sim.create_replica("root")

    {thread, _} =
      Thread
      |> Sim.new("treehouse:remove:thread", ["root", "member"], seed: "remove")
      |> Sim.create_replica("root")

    {space, space_cap} = Sim.grant(space, "root", "member", live: true)
    {thread, thread_cap} = Sim.grant(thread, "root", "member", ops: [:post], live: true)
    thread = Sim.sync_all(thread)
    recipient = Base.encode64(Sim.identity(space, "member").pub)

    {space, _} =
      Sim.command(space, "root", :create_thread, [Sim.replica(thread), "Retained route"])

    {space, invitation} =
      Sim.command(space, "root", :issue_invitation, [recipient, [Sim.replica(thread)]])

    acceptance = Invitation.accept(Sim.identity(space, "member"), Sim.replica(space), invitation)

    {space, _} =
      Sim.command(space, "root", :admit_member, [invitation.id, recipient, "member", acceptance])

    {space, _} = Sim.command(space, "root", :remove_member, [recipient])
    assert Sim.state(space, "root").members == []
    # This interval is reconciliation work for R14, not an atomic cross-log removal.
    assert Authority.delegation_active?(Sim.log(space, "root"), space_cap.id)

    {thread, pending} =
      Sim.command(thread, "member", :post, ["before actual revocation"], cap: thread_cap.id)

    assert false == Sim.quarantined(thread, "member", pending.id)
    thread = Sim.sync_all(thread)

    forged =
      Space.revoke_grant(Sim.identity(thread, "member"), Sim.log(thread, "member"), thread_cap.id)

    forged_log = Log.append!(Sim.log(thread, "member"), forged)
    assert Authority.analyze(Thread, forged_log).reasons[forged.id] == :unauthorized_revoke
    {space, _} = Sim.revoke(space, "root", space_cap.id)
    {thread, _} = Sim.revoke(thread, "root", thread_cap.id)
    thread = Sim.sync_all(thread)

    {thread, late} =
      Sim.command(thread, "member", :post, ["after revocation"], cap: thread_cap.id)

    assert {true, :revoked_capability} == Sim.quarantined(thread, "member", late.id)
    assert Authority.revoked?(Sim.log(space, "root"), space_cap.id)
    assert length(Sim.state(space, "root").threads) == 1
    assert Sim.state(thread, "root").posts == ["before actual revocation"]
  end

  test "a transferred Thread moderator can archive while the previous holder cannot" do
    {sim, genesis} =
      Thread
      |> Sim.new("treehouse:thread:transfer", ["root", "member"], seed: "thread-transfer")
      |> Sim.create_replica("root")

    {:genesis, parent, _} = genesis.body
    root = Sim.identity(sim, "root")
    member = Sim.identity(sim, "member")

    {transfer, capability} =
      Space.change_moderator(root, Sim.log(sim, "root"), member.pub, parent)

    log = Log.append!(Sim.log(sim, "root"), transfer)

    stale =
      Op.new(root, log.replica, Log.frontier(log), :command, {:archive_thread, []},
        cap: parent.id
      )

    current =
      Op.new(member, log.replica, Log.frontier(log), :command, {:archive_thread, []},
        cap: capability.id
      )

    log = log |> Log.append!(stale) |> Log.append!(current)
    assert Authority.analyze(Thread, log).reasons[stale.id] == :not_holder
    refute Map.has_key?(Authority.analyze(Thread, log).reasons, current.id)
    assert Lattice.state(Thread, log).archived
  end

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
