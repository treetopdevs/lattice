defmodule LatticeCarrierServer.DurabilityTest do
  @moduledoc """
  Persist-before-acknowledge durability contract (plan 158).

  A path-backed relay may be acknowledged only after the full sequence:
  write temp file -> fsync file -> atomic rename -> fsync containing
  directory. These tests drive the sequence through an injectable durability
  implementation, interrupt it before and after the rename and before the
  directory sync, and require a relay-enabled path holder to rehearse the
  sequence at startup so an incapable platform refuses instead of serving.
  """

  use ExUnit.Case, async: true

  alias Lattice.{Identity, Log, Op}
  alias LatticeCarrierServer.{Durability, Holder}

  @replica "replica:carrier-durability:test"

  defmodule InjectedDurability do
    @moduledoc """
    Test durability implementation keyed by the log's directory.

    Records each call to the registered listener pid and fails at the armed
    stage. Arming happens after holder startup, so the startup rehearsal can
    also be exercised independently by arming before start.
    """

    def listen(dir), do: :persistent_term.put({__MODULE__, :listener, dir}, self())

    def arm_failure(dir, stage), do: :persistent_term.put({__MODULE__, :fail, dir}, stage)

    def disarm(dir) do
      :persistent_term.erase({__MODULE__, :fail, dir})
      :persistent_term.erase({__MODULE__, :listener, dir})
    end

    def sync_file(path) do
      dir = Path.dirname(path)
      record(dir, {:sync_file, path})

      case armed(dir) do
        :sync_file -> {:error, :injected_sync_file}
        _other -> :ok
      end
    end

    def rename(temp_path, path) do
      dir = Path.dirname(path)
      record(dir, {:rename, temp_path, path})

      case armed(dir) do
        :rename -> {:error, :injected_rename}
        _other -> File.rename(temp_path, path)
      end
    end

    def sync_directory(dir) do
      record(dir, {:sync_directory, dir})

      case armed(dir) do
        :sync_directory -> {:error, :injected_directory_sync}
        _other -> :ok
      end
    end

    defp record(dir, event) do
      case :persistent_term.get({__MODULE__, :listener, dir}, nil) do
        nil -> :ok
        pid -> send(pid, {:durability, event})
      end
    end

    defp armed(dir), do: :persistent_term.get({__MODULE__, :fail, dir}, nil)
  end

  @tag :tmp_dir
  test "a pre-existing rehearsal namespace is never overwritten or removed", %{tmp_dir: tmp_dir} do
    collision = Path.join(tmp_dir, ".lattice-durability-rehearsal.42")
    File.write!(collision, "live deployment data")
    Process.put({__MODULE__, :suffix}, 41)

    next_suffix = fn ->
      suffix = Process.get({__MODULE__, :suffix}) + 1
      Process.put({__MODULE__, :suffix}, suffix)
      suffix
    end

    assert :ok = Durability.rehearse(InjectedDurability, tmp_dir, unique: next_suffix)
    assert File.read!(collision) == "live deployment data"
  end

  @tag :tmp_dir
  test "a relay acknowledgement follows file sync, rename, then directory sync", %{
    tmp_dir: tmp_dir
  } do
    %{holder: holder, path: path, relay_identity: relay_identity, relayed: relayed} =
      durable_holder(tmp_dir)

    InjectedDurability.listen(tmp_dir)

    assert {:ok, %{accepted: [relayed_id]}} =
             Holder.relay(holder, relay_identity.realm_id, relayed)

    assert relayed_id == relayed.id

    assert_received {:durability, {:sync_file, temp_path}}
    assert String.starts_with?(temp_path, path <> ".tmp.")
    assert_received {:durability, {:rename, ^temp_path, ^path}}
    dir = tmp_dir
    assert_received {:durability, {:sync_directory, ^dir}}
    refute_received {:durability, _event}
  end

  @tag :tmp_dir
  test "an interruption before the rename refuses the ack and leaves the log unchanged", %{
    tmp_dir: tmp_dir
  } do
    %{
      holder: holder,
      path: path,
      base: base,
      relay_identity: relay_identity,
      relayed: relayed
    } = durable_holder(tmp_dir)

    for stage <- [:sync_file, :rename] do
      InjectedDurability.arm_failure(tmp_dir, stage)

      assert {:error, {:persistence_failed, reason}} =
               Holder.relay(holder, relay_identity.realm_id, relayed)

      assert reason in [:injected_sync_file, :injected_rename]
      assert Holder.op_ids(holder) == [base.id]
      assert {:ok, persisted} = Log.restore(path)
      assert persisted |> Log.op_ids() |> Enum.sort() == [base.id]
      assert Path.wildcard("#{path}.tmp.*") == []
    end
  end

  @tag :tmp_dir
  test "an interruption after the rename but before the directory sync refuses the ack", %{
    tmp_dir: tmp_dir
  } do
    %{
      holder: holder,
      path: path,
      base: base,
      relay_identity: relay_identity,
      relayed: relayed
    } = durable_holder(tmp_dir)

    assert {:ok, _baseline} = Holder.subscribe(holder, self())
    InjectedDurability.arm_failure(tmp_dir, :sync_directory)

    assert {:error, {:persistence_failed, :injected_directory_sync}} =
             Holder.relay(holder, relay_identity.realm_id, relayed)

    # No acknowledgement, no availability hint, no in-memory state advance.
    assert Holder.op_ids(holder) == [base.id]
    refute_receive {:lattice_carrier_ops_available, ^holder, _availability}, 50

    # The rename already landed, so the durable file may hold the op: that is
    # at-least-once persistence without an ack — a redelivery of the same
    # content-addressed op is idempotent.
    assert {:ok, persisted} = Log.restore(path)
    assert relayed.id in Log.op_ids(persisted)
  end

  @tag :tmp_dir
  test "a relay-enabled path holder rehearses the durability sequence at startup", %{
    tmp_dir: tmp_dir
  } do
    server_identity = Identity.from_seed("town-node", "carrier-durability-rehearsal")
    relay_identity = Identity.from_seed("resident", "carrier-durability-rehearsal-client")
    path = Path.join(tmp_dir, "matter.log")
    assert :ok = @replica |> Log.new() |> Log.dump(path)

    InjectedDurability.arm_failure(tmp_dir, :sync_directory)
    on_exit(fn -> InjectedDurability.disarm(tmp_dir) end)
    previous_flag = Process.flag(:trap_exit, true)

    try do
      assert {:error, {:durability_unsupported, :injected_directory_sync}} =
               Holder.start_link(
                 name: {:global, {__MODULE__, make_ref()}},
                 identity: server_identity,
                 source: {:path, path},
                 relay_realms: [relay_identity.realm_id],
                 durability: InjectedDurability
               )
    after
      Process.flag(:trap_exit, previous_flag)
    end

    # No rehearsal residue may remain in the durable directory.
    assert tmp_dir |> File.ls!() |> Enum.sort() == ["matter.log"]
  end

  defp durable_holder(tmp_dir) do
    server_identity = Identity.from_seed("town-node", "carrier-durability-server")
    relay_identity = Identity.from_seed("resident", "carrier-durability-client")
    author = Identity.from_seed("author", "carrier-durability-author")
    base = Op.new(author, @replica, [], :command, {:post, "base"})
    relayed = Op.new(relay_identity, @replica, [base.id], :command, {:post, "relayed"})
    path = Path.join(tmp_dir, "matter.log")
    assert :ok = @replica |> Log.new() |> Log.append!(base) |> Log.dump(path)

    on_exit(fn -> InjectedDurability.disarm(tmp_dir) end)

    holder =
      start_supervised!(
        {Holder,
         name: {:global, {__MODULE__, make_ref()}},
         identity: server_identity,
         source: {:path, path},
         relay_realms: [relay_identity.realm_id],
         durability: InjectedDurability}
      )

    %{
      holder: holder,
      path: path,
      base: base,
      relay_identity: relay_identity,
      relayed: relayed
    }
  end
end
