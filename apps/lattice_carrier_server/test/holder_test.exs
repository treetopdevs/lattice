defmodule LatticeCarrierServer.HolderTest do
  use ExUnit.Case, async: true

  alias Lattice.{Identity, Log, Op}
  alias LatticeCarrierServer.Holder

  @replica "replica:carrier-holder:test"

  @tag :tmp_dir
  test "startup removes orphaned atomic-dump temp files", %{tmp_dir: tmp_dir} do
    server_identity = Identity.from_seed("town-node", "carrier-holder-orphan-cleanup")
    path = Path.join(tmp_dir, "matter.log")
    orphan_paths = ["#{path}.tmp.1", "#{path}.tmp.2"]
    assert :ok = @replica |> Log.new() |> Log.dump(path)

    for orphan_path <- orphan_paths do
      assert :ok = File.write(orphan_path, "stale")
    end

    holder = start_holder(server_identity, path)

    assert Holder.op_ids(holder) == []
    assert Path.wildcard("#{path}.tmp.*") == []
  end

  @tag :tmp_dir
  test "startup refuses an orphan it cannot remove", %{tmp_dir: tmp_dir} do
    server_identity = Identity.from_seed("town-node", "carrier-holder-orphan-refusal")
    path = Path.join(tmp_dir, "matter.log")
    orphan_path = "#{path}.tmp.blocked"
    assert :ok = @replica |> Log.new() |> Log.dump(path)
    assert :ok = File.mkdir(orphan_path)
    assert :ok = File.write(Path.join(orphan_path, "still-here"), "stale")
    previous_flag = Process.flag(:trap_exit, true)

    try do
      assert {:error, {:source_error, {:orphan_cleanup_failed, ^orphan_path, reason}}} =
               Holder.start_link(
                 name: {:global, {__MODULE__, make_ref()}},
                 identity: server_identity,
                 source: {:path, path},
                 relay_realms: []
               )

      assert reason in [:eisdir, :eperm]
    after
      Process.flag(:trap_exit, previous_flag)
    end
  end

  @tag :tmp_dir
  test "subscription returns a bounded baseline from the durable log", %{tmp_dir: tmp_dir} do
    author = Identity.from_seed("author", "carrier-holder-baseline")
    server_identity = Identity.from_seed("town-node", "carrier-holder-server")

    log =
      Enum.reduce(1..70, Log.new(@replica), fn index, log ->
        Log.append!(log, Op.new(author, @replica, [], :command, {:post, "head #{index}"}))
      end)

    path = Path.join(tmp_dir, "matter.log")
    assert :ok = Log.dump(log, path)
    holder = start_holder(server_identity, path)

    assert {:ok,
            %{
              generation: 70,
              frontier: frontier,
              frontier_truncated: true
            }} = Holder.subscribe(holder, self())

    assert length(frontier) == 64
    assert frontier == log |> Log.frontier() |> Enum.sort() |> Enum.take(64)
    assert :ok = Holder.unsubscribe(holder, self())
  end

  @tag :tmp_dir
  test "a durable relay notifies subscribers once after persistence", %{tmp_dir: tmp_dir} do
    author = Identity.from_seed("author", "carrier-holder-relay-author")
    relay_identity = Identity.from_seed("resident", "carrier-holder-relay-client")
    server_identity = Identity.from_seed("town-node", "carrier-holder-relay-server")
    base = Op.new(author, @replica, [], :command, {:post, "base"})
    relayed = Op.new(relay_identity, @replica, [base.id], :command, {:post, "relayed"})
    path = Path.join(tmp_dir, "matter.log")
    assert :ok = @replica |> Log.new() |> Log.append!(base) |> Log.dump(path)
    holder = start_holder(server_identity, path, [relay_identity.realm_id])

    assert {:ok, %{generation: 1}} = Holder.subscribe(holder, self())

    assert {:ok, %{accepted: [relayed_id]}} =
             Holder.relay(holder, relay_identity.realm_id, relayed)

    assert relayed_id == relayed.id

    assert_receive {:lattice_carrier_ops_available, ^holder,
                    %{generation: 2, frontier: [frontier], frontier_truncated: false}}

    assert frontier == relayed.id
    assert {:ok, persisted} = Log.restore(path)
    assert persisted |> Log.op_ids() |> Enum.sort() == [base.id, relayed.id] |> Enum.sort()

    assert {:ok, %{accepted: []}} = Holder.relay(holder, relay_identity.realm_id, relayed)
    refute_receive {:lattice_carrier_ops_available, ^holder, _availability}, 50
  end

  @tag :tmp_dir
  test "a slow subscriber has one outstanding hint and acknowledges the latest generation", %{
    tmp_dir: tmp_dir
  } do
    author = Identity.from_seed("author", "carrier-holder-coalesce-author")
    relay_identity = Identity.from_seed("resident", "carrier-holder-coalesce-client")
    server_identity = Identity.from_seed("town-node", "carrier-holder-coalesce-server")
    base = Op.new(author, @replica, [], :command, {:post, "base"})
    first = Op.new(relay_identity, @replica, [base.id], :command, {:post, "first"})
    second = Op.new(relay_identity, @replica, [first.id], :command, {:post, "second"})
    third = Op.new(relay_identity, @replica, [second.id], :command, {:post, "third"})
    path = Path.join(tmp_dir, "matter.log")
    assert :ok = @replica |> Log.new() |> Log.append!(base) |> Log.dump(path)
    holder = start_holder(server_identity, path, [relay_identity.realm_id])

    assert {:ok, %{generation: 1}} = Holder.subscribe(holder, self())

    for op <- [first, second, third] do
      assert {:ok, %{accepted: [accepted_id]}} =
               Holder.relay(holder, relay_identity.realm_id, op)

      assert accepted_id == op.id
    end

    assert_receive {:lattice_carrier_ops_available, ^holder, %{generation: 2}}
    refute_receive {:lattice_carrier_ops_available, ^holder, _availability}, 50

    assert {:ok, %{generation: 4, frontier: [frontier], frontier_truncated: false}} =
             Holder.acknowledge(holder, self(), 2)

    assert frontier == third.id
    refute_receive {:lattice_carrier_ops_available, ^holder, _availability}, 50
  end

  @tag :tmp_dir
  test "subscriptions monitor their owners and clean up after exit", %{tmp_dir: tmp_dir} do
    server_identity = Identity.from_seed("town-node", "carrier-holder-monitor-server")
    path = Path.join(tmp_dir, "matter.log")
    assert :ok = @replica |> Log.new() |> Log.dump(path)
    holder = start_holder(server_identity, path)
    subscriber = spawn(fn -> Process.sleep(:infinity) end)

    assert {:ok, %{generation: 0}} = Holder.subscribe(holder, subscriber)
    assert {:monitors, monitors} = Process.info(holder, :monitors)
    assert {:process, subscriber} in monitors

    Process.exit(subscriber, :kill)

    assert eventually(fn ->
             {:monitors, monitors} = Process.info(holder, :monitors)
             {:process, subscriber} not in monitors
           end)
  end

  @tag :tmp_dir
  test "quarantine generation is durable and restart-stable", %{tmp_dir: tmp_dir} do
    author = Identity.from_seed("author", "carrier-holder-quarantine-author")
    relay_identity = Identity.from_seed("resident", "carrier-holder-quarantine-client")
    server_identity = Identity.from_seed("town-node", "carrier-holder-quarantine-server")
    base = Op.new(author, @replica, [], :command, {:post, "base"})
    forged = Op.new(relay_identity, @replica, [base.id], :command, {:post, "forged"})
    forged = %{forged | sig: <<0::512>>}
    path = Path.join(tmp_dir, "matter.log")
    assert :ok = @replica |> Log.new() |> Log.append!(base) |> Log.dump(path)
    holder = start_holder(server_identity, path, [relay_identity.realm_id])

    assert {:ok, %{generation: 1}} = Holder.subscribe(holder, self())

    assert {:ok, %{quarantined: [{forged_id, :bad_signature}]}} =
             Holder.relay(holder, relay_identity.realm_id, forged)

    assert forged_id == forged.id

    assert_receive {:lattice_carrier_ops_available, ^holder,
                    %{generation: 2, frontier: [frontier], frontier_truncated: false}}

    assert frontier == base.id

    assert {:ok, %{quarantined: [{^forged_id, :already_quarantined}]}} =
             Holder.relay(holder, relay_identity.realm_id, forged)

    refute_receive {:lattice_carrier_ops_available, ^holder, _availability}, 50
    assert :ok = stop_supervised(Holder)
    restarted = start_holder(server_identity, path, [relay_identity.realm_id])
    assert {:ok, %{generation: 2}} = Holder.subscribe(restarted, self())
  end

  @tag :tmp_dir
  test "non-durable and non-changing relays stay silent", %{tmp_dir: tmp_dir} do
    author = Identity.from_seed("author", "carrier-holder-silent-author")
    relay_identity = Identity.from_seed("resident", "carrier-holder-silent-client")
    server_identity = Identity.from_seed("town-node", "carrier-holder-silent-server")
    base = Op.new(author, @replica, [], :command, {:post, "base"})
    accepted = Op.new(relay_identity, @replica, [base.id], :command, {:post, "accepted"})
    pending = Op.new(relay_identity, @replica, ["missing"], :command, {:post, "pending"})
    rejected = Op.new(relay_identity, "replica:wrong", [], :command, {:post, "rejected"})
    path = Path.join(tmp_dir, "matter.log")
    assert :ok = @replica |> Log.new() |> Log.append!(base) |> Log.dump(path)
    holder = start_holder(server_identity, path, [relay_identity.realm_id])
    assert {:ok, %{generation: 1}} = Holder.subscribe(holder, self())

    assert {:ok, %{pending: [pending_id]}} =
             Holder.relay(holder, relay_identity.realm_id, pending)

    assert pending_id == pending.id

    assert {:ok, %{rejected: [{rejected_id, :wrong_replica}]}} =
             Holder.relay(holder, relay_identity.realm_id, rejected)

    assert rejected_id == rejected.id
    assert {:error, :read_only} = Holder.relay(holder, "realm:read-only", accepted)
    refute_receive {:lattice_carrier_ops_available, ^holder, _availability}, 50

    assert :ok = Holder.unsubscribe(holder, self())

    assert {:ok, %{accepted: [accepted_id]}} =
             Holder.relay(holder, relay_identity.realm_id, accepted)

    assert accepted_id == accepted.id
    refute_receive {:lattice_carrier_ops_available, ^holder, _availability}, 50

    assert {:ok, %{generation: 2}} = Holder.subscribe(holder, self())
    assert :ok = File.rm(path)
    assert :ok = File.mkdir(path)
    next = Op.new(relay_identity, @replica, [accepted.id], :command, {:post, "not durable"})

    assert {:error, {:persistence_failed, _reason}} =
             Holder.relay(holder, relay_identity.realm_id, next)

    refute_receive {:lattice_carrier_ops_available, ^holder, _availability}, 50
  end

  defp start_holder(identity, path, relay_realms \\ []) do
    start_supervised!(
      {Holder,
       name: {:global, {__MODULE__, make_ref()}},
       identity: identity,
       source: {:path, path},
       relay_realms: relay_realms}
    )
  end

  defp eventually(fun, attempts \\ 50)

  defp eventually(fun, attempts) when attempts > 0 do
    if fun.() do
      true
    else
      Process.sleep(10)
      eventually(fun, attempts - 1)
    end
  end

  defp eventually(_fun, 0), do: false
end
