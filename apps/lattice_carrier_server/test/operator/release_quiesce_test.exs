defmodule LatticeCarrierServer.Operator.ReleaseQuiesceTest do
  use ExUnit.Case, async: false
  alias Lattice.{Identity, Log, Op}
  alias LatticeCarrierServer.Holder
  alias LatticeCarrierServer.Operator.ReleaseGate

  defmodule LocalSequence do
    def sync_file(_), do: :ok
    def rename(from, to), do: File.rename(from, to)
    def sync_directory(_), do: :ok
  end

  @tag :tmp_dir
  test "closing actual owned Holder refuses a valid signed relay without changing bytes", %{
    tmp_dir: dir
  } do
    start_supervised!({ReleaseGate, latch: :atomics.new(1, [])})
    owner = ReleaseGate.owner()
    identity = Identity.from_seed("relay", "quiesce")
    path = Path.join(dir, "log")
    :ok = Log.new("replica:quiesce") |> Log.dump(path)

    holder =
      start_supervised!(
        {Holder,
         name: {:global, make_ref()},
         identity: identity,
         source: {:path, path},
         relay_realms: ["relay"],
         durability: LocalSequence,
         release_owner: owner,
         release_route: "route"}
      )

    before = File.read!(path)
    assert {:ok, _} = ReleaseGate.close(owner, "attempt", %{})
    op = Op.new(identity, "replica:quiesce", [], :command, {:post, "after-close"})
    assert Op.valid?(op)
    assert {:error, :release_closed} = Holder.relay(holder, "relay", op)
    assert File.read!(path) == before
  end

  defmodule GatedRehearsal do
    def sync_file(_) do
      send(:persistent_term.get({__MODULE__, :observer}), {:rehearsal, self()})

      receive do
        :finish_rehearsal -> :ok
      end
    end

    def rename(from, to), do: File.rename(from, to)
    def sync_directory(_), do: :ok
  end

  @tag :tmp_dir
  test "actual startup rehearsal retains lease until completion; no new startup after close", %{
    tmp_dir: dir
  } do
    start_supervised!({ReleaseGate, latch: :atomics.new(1, [])})
    owner = ReleaseGate.owner()
    :persistent_term.put({GatedRehearsal, :observer}, self())
    on_exit(fn -> :persistent_term.erase({GatedRehearsal, :observer}) end)
    path = Path.join(dir, "startup")
    :ok = Log.new("replica:startup") |> Log.dump(path)
    parent = self()

    runner =
      spawn_link(fn ->
        result =
          Holder.start_link(
            name: {:global, make_ref()},
            identity: Identity.from_seed("relay", "startup"),
            source: {:path, path},
            relay_realms: ["relay"],
            durability: GatedRehearsal,
            release_owner: owner,
            release_route: "starting"
          )

        send(parent, {:started, result})

        receive do
          :stop ->
            case result do
              {:ok, pid} -> GenServer.stop(pid)
              _ -> :ok
            end
        end
      end)

    on_exit(fn -> send(runner, :stop) end)
    assert_receive {:rehearsal, holder}, 2_000
    assert {:ok, snapshot} = ReleaseGate.close(owner, "attempt", %{})
    assert map_size(snapshot.leases) == 1
    assert {:error, :release_closed} = ReleaseGate.acquire(owner, {:holder, "late"})
    send(holder, :finish_rehearsal)
    assert_receive {:started, {:ok, ^holder}}, 2_000
    assert {:ok, snapshot} = ReleaseGate.snapshot(owner, "attempt")
    assert map_size(snapshot.leases) == 0
    assert Map.has_key?(snapshot.identities, {:holder, "starting"})
  end

  test "replacing a gate that was still accepting starts a fresh accepting incarnation" do
    latch = :atomics.new(1, [])
    start_supervised!({ReleaseGate, latch: latch})
    previous = ReleaseGate.owner()
    assert ReleaseGate.accepting?(previous)
    stop_supervised!(ReleaseGate)
    start_supervised!({ReleaseGate, latch: latch})
    current = ReleaseGate.owner()
    refute current == previous
    assert ReleaseGate.accepting?(current)
    refute ReleaseGate.accepting?(previous)
    assert {:error, :release_closed} = ReleaseGate.acquire(previous, :replacement)
  end

  test "replacement gate after a close began remains closed with new incarnation" do
    latch = :atomics.new(1, [])
    start_supervised!({ReleaseGate, latch: latch})
    previous = ReleaseGate.owner()
    assert {:ok, _} = ReleaseGate.close(previous, "attempt", %{})
    stop_supervised!(ReleaseGate)
    start_supervised!({ReleaseGate, latch: latch})
    current = ReleaseGate.owner()
    refute current == previous
    refute ReleaseGate.accepting?(current)
    assert {:error, :release_closed} = ReleaseGate.acquire(current, :replacement)
  end

  test "replacement gate after an accepting-phase invalidation remains closed" do
    latch = :atomics.new(1, [])
    start_supervised!({ReleaseGate, latch: latch})
    previous = ReleaseGate.owner()
    assert {:error, :release_closed} = ReleaseGate.finish(previous, make_ref())
    stop_supervised!(ReleaseGate)
    start_supervised!({ReleaseGate, latch: latch})
    refute ReleaseGate.accepting?(ReleaseGate.owner())
  end

  test "an unrelated message does not disturb the gate" do
    start_supervised!({ReleaseGate, latch: :atomics.new(1, [])})
    owner = {pid, _} = ReleaseGate.owner()
    send(pid, :unrelated)
    assert ReleaseGate.accepting?(owner)
  end
end
