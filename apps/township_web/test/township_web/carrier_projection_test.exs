defmodule TownshipWeb.CarrierProjectionTest do
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Backoff
  alias Lattice.{Log, Sim}
  alias Township.Matter
  alias TownshipWeb.CarrierProjection

  defmodule PullOnlyCarrier do
    def connect(opts) do
      test_pid = Keyword.fetch!(opts, :test_pid)
      control = Keyword.get(opts, :control)

      case control_mode(control) do
        {:wait_connect, next_mode} ->
          send(test_pid, {:carrier_connect_waiting, self()})

          receive do
            :continue_connect -> Agent.update(control, fn _mode -> next_mode end)
          end

        _mode ->
          :ok
      end

      send(test_pid, :carrier_connected)

      {:ok,
       %{
         control: control,
         ops: Keyword.fetch!(opts, :ops),
         test_pid: Keyword.fetch!(opts, :test_pid)
       }}
    end

    def advertise(conn, %Log{} = log) do
      send(conn.test_pid, {:advertise, Log.op_ids(log)})

      case mode(conn) do
        {:advertise_error, reason} -> {:error, reason}
        {:peer_ops, ops} -> {:ok, MapSet.new(ops, & &1.id), conn}
        :dead_connection -> exit(:noproc)
        _mode -> {:ok, MapSet.new(conn.ops, & &1.id), conn}
      end
    end

    def pull(conn, %MapSet{} = have) do
      send(conn.test_pid, {:pull, have})
      {:ok, Enum.reject(peer_ops(conn), &MapSet.member?(have, &1.id)), conn}
    end

    def push(conn, _ops) do
      send(conn.test_pid, :push_called)
      {:error, :read_only_violation}
    end

    def close(conn) do
      send(conn.test_pid, :carrier_closed)

      case mode(conn) do
        :dead_connection -> exit(:noproc)
        _mode -> :ok
      end
    end

    defp mode(%{control: nil}), do: :ok
    defp mode(%{control: control}), do: Agent.get(control, & &1)

    defp control_mode(nil), do: :ok
    defp control_mode(control), do: Agent.get(control, & &1)

    defp peer_ops(conn) do
      case mode(conn) do
        {:peer_ops, ops} -> ops
        _mode -> conn.ops
      end
    end
  end

  test "pulls a peer log into a fresh instrument projection without pushing" do
    peer_log = peer_log()
    topic = "township:projection:#{System.unique_integer([:positive])}"

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: PullOnlyCarrier,
         connect_opts: [ops: Log.topo_ops(peer_log), test_pid: self()],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: topic,
         schedule: :manual}
      )

    assert {:ok, :connecting} = CarrierProjection.subscribe(projection)
    assert {:ok, {:fresh, payload}} = CarrierProjection.refresh(projection)

    assert_receive {:township_instrument, {:fresh, ^payload}}
    assert_receive {:advertise, advertised}
    assert MapSet.size(advertised) == 0
    assert_receive {:pull, have}
    assert MapSet.size(have) == 0
    refute_receive :push_called

    assert payload.read_model.threads.title == "Projection matter"
    assert payload.read_model.threads.posts == ["clerk: first update"]
    assert payload.causal_replay["schema"] == "township-causal-replay-v1"

    assert payload.provenance.source == :carrier
    assert payload.provenance.freshness == :fresh
    assert payload.provenance.verification == :arrival
    assert payload.provenance.peer_realm == "clerk"
    assert payload.provenance.replica == peer_log.replica
    assert payload.provenance.frontier == Log.frontier(peer_log)
    assert %DateTime{} = payload.provenance.pulled_at
    assert payload.provenance.last_error == nil
  end

  test "withholds state and closes a failed connection before the first snapshot" do
    peer_log = peer_log()
    control = start_supervised!({Agent, fn -> {:advertise_error, :offline} end})
    topic = "township:projection:#{System.unique_integer([:positive])}"

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: PullOnlyCarrier,
         connect_opts: [
           ops: Log.topo_ops(peer_log),
           test_pid: self(),
           control: control
         ],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: topic,
         schedule: :manual}
      )

    assert {:ok, :connecting} = CarrierProjection.subscribe(projection)
    assert {:ok, {:unavailable, :offline}} = CarrierProjection.refresh(projection)
    assert_receive :carrier_closed
    assert_receive {:township_instrument, {:unavailable, :offline}}
    refute_receive :push_called
    assert {:ok, {:unavailable, :offline}} = CarrierProjection.subscribe(projection)
  end

  test "marks the last peer snapshot stale and returns it to fresh after reconnect" do
    peer_log = peer_log()
    control = start_supervised!({Agent, fn -> :ok end})
    topic = "township:projection:#{System.unique_integer([:positive])}"

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: PullOnlyCarrier,
         connect_opts: [
           ops: Log.topo_ops(peer_log),
           test_pid: self(),
           control: control
         ],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: topic,
         schedule: :manual}
      )

    assert {:ok, :connecting} = CarrierProjection.subscribe(projection)
    assert {:ok, {:fresh, fresh}} = CarrierProjection.refresh(projection)
    assert_receive :carrier_connected
    assert_receive {:township_instrument, {:fresh, ^fresh}}

    Agent.update(control, fn _mode -> {:advertise_error, :offline} end)

    assert {:ok, {:stale, stale}} = CarrierProjection.refresh(projection)
    assert_receive :carrier_closed
    assert_receive {:township_instrument, {:stale, ^stale}}
    assert stale.read_model == fresh.read_model
    assert stale.causal_replay == fresh.causal_replay
    assert stale.provenance.freshness == :stale
    assert stale.provenance.last_error == :offline
    assert stale.provenance.pulled_at == fresh.provenance.pulled_at

    Agent.update(control, fn _mode -> :ok end)

    assert {:ok, {:fresh, recovered}} = CarrierProjection.refresh(projection)
    assert_receive :carrier_connected
    assert_receive {:township_instrument, {:fresh, ^recovered}}
    assert recovered.read_model == fresh.read_model
    assert recovered.provenance.freshness == :fresh
    assert recovered.provenance.last_error == nil
    refute_receive :push_called
  end

  test "marks a peer regression stale before pulling from the regressed view" do
    peer_log = peer_log()
    peer_ops = Log.topo_ops(peer_log)
    control = start_supervised!({Agent, fn -> :ok end})
    topic = "township:projection:#{System.unique_integer([:positive])}"

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: PullOnlyCarrier,
         connect_opts: [ops: peer_ops, test_pid: self(), control: control],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: topic,
         schedule: :manual}
      )

    assert {:ok, :connecting} = CarrierProjection.subscribe(projection)
    assert {:ok, {:fresh, fresh}} = CarrierProjection.refresh(projection)
    assert_receive {:township_instrument, {:fresh, ^fresh}}
    assert_receive {:pull, _initial_have}

    regressed_ops = Enum.drop(peer_ops, -1)
    missing_ids = peer_ops -- regressed_ops
    Agent.update(control, fn _mode -> {:peer_ops, regressed_ops} end)

    assert {:ok, {:stale, stale}} = CarrierProjection.refresh(projection)
    assert stale.provenance.last_error == {:peer_regression, Enum.map(missing_ids, & &1.id)}
    assert stale.read_model == fresh.read_model
    assert_receive :carrier_closed
    assert_receive {:township_instrument, {:stale, ^stale}}
    refute_receive {:pull, _regressed_have}
    refute_receive :push_called
  end

  test "scheduled refresh stays subscribable and reconnects after backoff" do
    peer_log = peer_log()

    control =
      start_supervised!({Agent, fn -> {:wait_connect, {:advertise_error, :offline}} end})

    topic = "township:projection:#{System.unique_integer([:positive])}"

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: PullOnlyCarrier,
         connect_opts: [
           ops: Log.topo_ops(peer_log),
           test_pid: self(),
           control: control
         ],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: topic,
         schedule: [
           initial_delay_ms: 50,
           poll_interval_ms: 1_000,
           backoff: Backoff.new(base_ms: 20, max_ms: 20, seed: "projection-test")
         ]}
      )

    assert {:ok, :connecting} = CarrierProjection.subscribe(projection)
    assert_receive {:carrier_connect_waiting, connector}, 1_000

    responsiveness_probe = Task.async(fn -> CarrierProjection.subscribe(projection) end)
    assert {:ok, {:ok, :connecting}} = Task.yield(responsiveness_probe, 200)

    send(connector, :continue_connect)
    assert_receive :carrier_connected
    assert_receive {:township_instrument, {:unavailable, :offline}}, 1_000
    assert_receive :carrier_closed

    Agent.update(control, fn _mode -> :ok end)

    assert_receive :carrier_connected, 1_000
    assert_receive {:township_instrument, {:fresh, payload}}, 1_000
    assert payload.read_model.threads.title == "Projection matter"
    refute_receive :push_called
  end

  test "manual refresh replaces rather than duplicates the pending poll timer" do
    peer_log = peer_log()
    topic = "township:projection:#{System.unique_integer([:positive])}"

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: PullOnlyCarrier,
         connect_opts: [ops: Log.topo_ops(peer_log), test_pid: self()],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: topic,
         schedule: [
           initial_delay_ms: 0,
           poll_interval_ms: 200,
           backoff: Backoff.new(base_ms: 20, max_ms: 20, seed: "timer-test")
         ]}
      )

    assert {:ok, _current} = CarrierProjection.subscribe(projection)
    assert_receive {:pull, _initial_have}, 1_000
    assert_receive {:township_instrument, {:fresh, _initial_payload}}, 1_000

    assert {:ok, {:fresh, _payload}} = CarrierProjection.refresh(projection)
    assert_receive {:pull, _manual_have}

    assert_receive {:pull, _scheduled_have}, 500
    refute_receive {:pull, _duplicate_have}, 80
    refute_receive :push_called
  end

  test "a dead carrier during refresh becomes stale without crashing the projection" do
    peer_log = peer_log()
    control = start_supervised!({Agent, fn -> :ok end})
    topic = "township:projection:#{System.unique_integer([:positive])}"

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: PullOnlyCarrier,
         connect_opts: [
           ops: Log.topo_ops(peer_log),
           test_pid: self(),
           control: control
         ],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: topic,
         schedule: :manual}
      )

    assert {:ok, :connecting} = CarrierProjection.subscribe(projection)
    assert {:ok, {:fresh, fresh}} = CarrierProjection.refresh(projection)
    assert_receive {:township_instrument, {:fresh, ^fresh}}

    Agent.update(control, fn _mode -> :dead_connection end)

    assert {:ok, {:stale, stale}} = CarrierProjection.refresh(projection)
    assert stale.read_model == fresh.read_model
    assert stale.provenance.last_error == {:refresh_worker_down, :noproc}
    assert_receive :carrier_closed
    assert_receive {:township_instrument, {:stale, ^stale}}
    assert Process.alive?(projection)
    refute_receive :push_called
  end

  test "an unchanged successful pull advances freshness without rebroadcasting the model" do
    peer_log = peer_log()
    topic = "township:projection:#{System.unique_integer([:positive])}"

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: PullOnlyCarrier,
         connect_opts: [ops: Log.topo_ops(peer_log), test_pid: self()],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: topic,
         schedule: :manual}
      )

    assert {:ok, :connecting} = CarrierProjection.subscribe(projection)
    assert {:ok, {:fresh, first}} = CarrierProjection.refresh(projection)
    assert_receive {:township_instrument, {:fresh, ^first}}

    assert {:ok, {:fresh, unchanged}} = CarrierProjection.refresh(projection)
    assert unchanged.read_model == first.read_model
    assert unchanged.causal_replay == first.causal_replay
    assert DateTime.compare(unchanged.provenance.pulled_at, first.provenance.pulled_at) == :gt
    assert {:ok, {:fresh, current}} = CarrierProjection.subscribe(projection)
    assert current.provenance.pulled_at == unchanged.provenance.pulled_at
    refute_receive {:township_instrument, _projection_state}, 80
    refute_receive :push_called
  end

  defp peer_log do
    sim = Sim.new(Matter, "replica:matter:projection", ["clerk"], seed: "projection")
    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, _title} = Sim.command(sim, "clerk", :set_title, ["Projection matter"])
    {sim, _post} = Sim.command(sim, "clerk", :post, ["clerk: first update"])
    Sim.log(sim, "clerk")
  end
end
