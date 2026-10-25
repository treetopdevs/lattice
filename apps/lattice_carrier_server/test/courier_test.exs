defmodule LatticeCarrierServer.CourierTest do
  use ExUnit.Case, async: false

  alias Lattice.{Identity, Log, Op, Sync}
  alias LatticeCarrierServer.Holder
  alias LatticeCarrierServer.Operator.ReleaseGate

  @replica "replica:courier"

  defmodule LocalSequence do
    def sync_file(_), do: :ok
    def rename(from, to), do: File.rename(from, to)
    def sync_directory(_), do: :ok
  end

  defmodule FaultSequence do
    def arm(dir, fault), do: :persistent_term.put({__MODULE__, dir}, fault)
    def clear(dir), do: :persistent_term.erase({__MODULE__, dir})

    def sync_file(path) do
      if :persistent_term.get({__MODULE__, Path.dirname(path)}, nil) == :before,
        do: {:error, :injected_before},
        else: :ok
    end

    def rename(from, to), do: File.rename(from, to)

    def sync_directory(dir) do
      case :persistent_term.get({__MODULE__, dir}, nil) do
        :after ->
          {:error, :injected_after}

        {:hang, observer} ->
          send(observer, {:sync_blocked, self()})

          receive do
            :continue -> :ok
          end

        _ ->
          :ok
      end
    end
  end

  setup do
    start_supervised!({ReleaseGate, latch: :atomics.new(1, [])})
    %{owner: ReleaseGate.owner()}
  end

  @tag :tmp_dir
  test "local reviewed delivery persists despite a read-only network realm and replay does not rewrite",
       context do
    {holder, path, author} = holder(context)
    op = Op.new(author, @replica, [], :command, {:post, "signed reference"})
    assert {:error, :read_only} = Holder.relay(holder, author.realm_id, op)
    assert {:error, :durability_not_proven} = Holder.courier_snapshot(holder)
    assert :ok = Holder.prove_durability(holder)
    assert {:ok, snapshot} = Holder.courier_snapshot(holder)
    token = reviewed(snapshot, op)
    assert {:ok, %{reference_id: id, outcome: :delivered}} = Holder.courier(holder, op, token)
    assert id == op.id
    assert {:ok, %{log: disk}} = Log.restore_verified(path)
    assert Map.get(disk.ops, id) == op
    before = file_snapshot(path)
    assert {:ok, snapshot} = Holder.courier_snapshot(holder)
    assert {:ok, %{outcome: :present}} = Holder.courier(holder, op, reviewed(snapshot, op))
    assert file_snapshot(path) == before
  end

  @tag :tmp_dir
  test "a concurrent signed relay invalidates the reviewed snapshot", context do
    {holder, path, author} = holder(context, relay_realms: ["author"])
    assert {:ok, snapshot} = Holder.courier_snapshot(holder)
    reference = Op.new(author, @replica, [], :command, {:post, "reviewed"})
    concurrent = Op.new(author, @replica, [], :command, {:post, "concurrent"})
    assert {:ok, _} = Holder.relay(holder, "author", concurrent)
    before = File.read!(path)

    assert {:error, :stale_served_history} =
             Holder.courier(holder, reference, reviewed(snapshot, reference))

    assert File.read!(path) == before
    assert Holder.op_ids(holder) == [concurrent.id]
  end

  @tag :tmp_dir
  test "changed candidate proof and closed release cannot publish", context do
    {holder, path, author} = holder(context)
    assert :ok = Holder.prove_durability(holder)
    assert {:ok, snapshot} = Holder.courier_snapshot(holder)
    op = Op.new(author, @replica, [], :command, {:post, "candidate"})
    token = Map.put(reviewed(snapshot, op), :candidate_digest, <<0::256>>)
    before = File.read!(path)
    assert {:error, :invalid_courier_review} = Holder.courier(holder, op, token)
    assert {:ok, _} = ReleaseGate.close(context.owner, "attempt", %{})
    assert {:error, :release_closed} = Holder.courier(holder, op, reviewed(snapshot, op))
    assert File.read!(path) == before
  end

  @tag :tmp_dir
  test "a known pre-rename failure remains retryable", context do
    {holder, path, author} = holder(context, durability: FaultSequence)
    assert :ok = Holder.prove_durability(holder)
    assert {:ok, snapshot} = Holder.courier_snapshot(holder)
    op = Op.new(author, @replica, [], :command, {:post, "retryable"})
    before = File.read!(path)
    FaultSequence.arm(context.tmp_dir, :before)
    on_exit(fn -> FaultSequence.clear(context.tmp_dir) end)

    assert {:error, {:persistence_failed, :injected_before}} =
             Holder.courier(holder, op, reviewed(snapshot, op))

    assert File.read!(path) == before
    assert :ok = Holder.ready?(holder)
    FaultSequence.clear(context.tmp_dir)
    assert {:ok, %{outcome: :delivered}} = Holder.courier(holder, op, reviewed(snapshot, op))
  end

  @tag :tmp_dir
  test "an ambiguous post-rename failure fences a different relay and drain", context do
    {holder, path, author} = holder(context, durability: FaultSequence, relay_realms: ["author"])
    assert {:ok, snapshot} = Holder.courier_snapshot(holder)
    op = Op.new(author, @replica, [], :command, {:post, "landed without ack"})
    FaultSequence.arm(context.tmp_dir, :after)
    on_exit(fn -> FaultSequence.clear(context.tmp_dir) end)

    assert {:error, {:persistence_failed, :injected_after}} =
             Holder.courier(holder, op, reviewed(snapshot, op))

    assert {:ok, %{log: disk}} = Log.restore_verified(path)
    assert Map.get(disk.ops, op.id) == op
    before = File.read!(path)
    other = Op.new(author, @replica, [], :command, {:post, "must not overwrite"})
    assert {:error, :persistence_ambiguous} = Holder.relay(holder, "author", other)
    assert {:error, :persistence_ambiguous} = Holder.courier_snapshot(holder)
    assert {:error, :persistence_ambiguous} = Holder.courier(holder, op, reviewed(snapshot, op))
    assert {:error, :persistence_ambiguous} = Holder.ready?(holder)
    assert {:ok, _} = ReleaseGate.close(context.owner, "attempt", %{})

    assert {:error, :persistence_ambiguous} =
             GenServer.call(holder, {:drain_release, context.owner})

    assert File.read!(path) == before
    assert Process.alive?(holder)
  end

  @tag :tmp_dir
  test "a post-rename timeout kills its worker and fences later writes", context do
    {holder, path, author} = holder(context, durability: FaultSequence, relay_realms: ["author"])
    assert {:ok, snapshot} = Holder.courier_snapshot(holder)
    op = Op.new(author, @replica, [], :command, {:post, "timeout"})
    previous = Application.get_env(:lattice_carrier_server, :persistence_timeout_ms)
    Application.put_env(:lattice_carrier_server, :persistence_timeout_ms, 25)
    FaultSequence.arm(context.tmp_dir, {:hang, self()})

    on_exit(fn ->
      FaultSequence.clear(context.tmp_dir)

      if previous,
        do: Application.put_env(:lattice_carrier_server, :persistence_timeout_ms, previous),
        else: Application.delete_env(:lattice_carrier_server, :persistence_timeout_ms)
    end)

    task = Task.async(fn -> Holder.courier(holder, op, reviewed(snapshot, op)) end)
    assert_receive {:sync_blocked, worker}, 1_000
    monitor = Process.monitor(worker)
    assert {:error, {:persistence_failed, :persistence_timeout}} = Task.await(task)
    assert_receive {:DOWN, ^monitor, :process, ^worker, _}
    before = File.read!(path)
    other = Op.new(author, @replica, [], :command, {:post, "later"})
    assert {:error, :persistence_ambiguous} = Holder.relay(holder, "author", other)
    assert File.read!(path) == before
  end

  @tag :tmp_dir
  test "failed isolated proof leaves the target unchanged and can be retried", context do
    {holder, path, _author} = holder(context, durability: FaultSequence)
    before = File.read!(path)
    FaultSequence.arm(context.tmp_dir, :before)
    on_exit(fn -> FaultSequence.clear(context.tmp_dir) end)
    assert {:error, :durability_unsupported} = Holder.prove_durability(holder)
    assert {:error, :durability_not_proven} = Holder.courier_snapshot(holder)
    assert File.read!(path) == before
    assert File.ls!(context.tmp_dir) == ["matter.log"]
    FaultSequence.clear(context.tmp_dir)
    assert :ok = Holder.prove_durability(holder)
  end

  @tag :tmp_dir
  test "unguarded and in-memory holders refuse the courier without crashing", context do
    {memory, _path, _} = holder(context, source: {:log, Log.new(@replica)})
    assert {:error, :unsupported_courier_source} = Holder.prove_durability(memory)
    assert Process.alive?(memory)
    {unowned, _, _} = holder(context, release_owner: nil)
    assert {:error, :unguarded_courier} = Holder.prove_durability(unowned)
    assert Process.alive?(unowned)
  end

  @tag :tmp_dir
  test "holder death also terminates its unlinked persistence worker", context do
    {holder, path, author} = holder(context, durability: FaultSequence)
    assert :ok = Holder.prove_durability(holder)
    assert {:ok, snapshot} = Holder.courier_snapshot(holder)
    op = Op.new(author, @replica, [], :command, {:post, "owner dies"})
    FaultSequence.arm(context.tmp_dir, {:hang, self()})
    on_exit(fn -> FaultSequence.clear(context.tmp_dir) end)
    observer = self()

    spawn(fn ->
      result =
        try do
          Holder.courier(holder, op, reviewed(snapshot, op))
        catch
          :exit, reason -> {:exit, reason}
        end

      send(observer, {:courier_finished, result})
    end)

    assert_receive {:sync_blocked, worker}, 1_000
    monitor = Process.monitor(worker)
    Process.exit(holder, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^worker, _}, 1_000
    assert_receive {:courier_finished, {:exit, _}}, 1_000
    assert {:ok, %{log: disk}} = Log.restore_verified(path)
    assert disk.ops[op.id] == op
    refute Process.alive?(worker)
  end

  defp holder(context, options \\ []) do
    path = Path.join(context.tmp_dir, "matter.log")
    assert :ok = Log.new(@replica) |> Log.dump(path)
    author = Identity.from_seed("author", "courier-test-author")

    opts = [
      name: {:global, make_ref()},
      identity: Identity.from_seed("server", "courier-server"),
      source: {:path, path},
      relay_realms: [],
      durability: LocalSequence,
      release_owner: context.owner,
      release_route: "route"
    ]

    {start_supervised!(
       Supervisor.child_spec({Holder, Keyword.merge(opts, options)},
         id: make_ref(),
         restart: :temporary
       )
     ), path, author}
  end

  defp file_snapshot(path) do
    stat = File.stat!(path, time: :posix)
    {File.read!(path), stat.inode, stat.mtime}
  end

  defp reviewed(snapshot, op) do
    {candidate, _report} = Sync.deliver(snapshot.log, [op])

    snapshot.token
    |> Map.put(:op_id, op.id)
    |> Map.put(
      :candidate_digest,
      :crypto.hash(:sha256, :erlang.term_to_binary(candidate, [:deterministic]))
    )
  end
end
