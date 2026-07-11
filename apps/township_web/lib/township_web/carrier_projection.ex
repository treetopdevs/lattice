defmodule TownshipWeb.CarrierProjection do
  @moduledoc """
  Pull-only Township instrument projection over an authenticated carrier.

  The projection owns its peer log, carrier connection, read-model derivation,
  and PubSub publication. It never transfers local operations to the peer.
  """

  use GenServer

  alias Lattice.Carrier.Backoff
  alias Lattice.{Log, Sync}
  alias Township.ReadModel

  @event :township_instrument
  @refresh_result :township_carrier_projection_refresh

  @type payload :: %{
          read_model: ReadModel.t(),
          causal_replay: map(),
          provenance: map()
        }
  @type projection_state ::
          :connecting | {:fresh, payload()} | {:stale, payload()} | {:unavailable, term()}

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    case Keyword.get(opts, :name) do
      nil -> GenServer.start_link(__MODULE__, opts)
      name -> GenServer.start_link(__MODULE__, opts, name: name)
    end
  end

  @doc "Subscribe the caller to projection events and return the latest state."
  @spec subscribe(GenServer.server()) :: {:ok, projection_state()}
  def subscribe(server \\ __MODULE__) do
    {pubsub, topic} = GenServer.call(server, :subscription)
    :ok = Phoenix.PubSub.subscribe(pubsub, topic)
    {:ok, GenServer.call(server, :current)}
  end

  @doc "Pull and project the peer's current log now."
  @spec refresh(GenServer.server()) :: {:ok, projection_state()}
  def refresh(server \\ __MODULE__), do: GenServer.call(server, :refresh, 15_000)

  @impl GenServer
  def init(opts) do
    replica = Keyword.fetch!(opts, :replica)

    state =
      %{
        carrier: Keyword.get(opts, :carrier, Lattice.Carrier.WebSocket),
        connect_opts: Keyword.fetch!(opts, :connect_opts),
        replica: replica,
        peer_realm: Keyword.fetch!(opts, :peer_realm),
        pubsub: Keyword.get(opts, :pubsub, TownshipWeb.PubSub),
        topic: Keyword.get(opts, :topic, "township:instrument"),
        labels: Keyword.get(opts, :labels, %{}),
        vouches: Keyword.get(opts, :vouches, []),
        conn: nil,
        log: Log.new(replica),
        current: :connecting,
        schedule: normalize_schedule(Keyword.get(opts, :schedule, :manual), replica),
        attempt: Backoff.reset_attempt(),
        poll_timer: nil,
        refresh_job: nil,
        waiters: []
      }

    {:ok, schedule_initial_refresh(state)}
  end

  @impl GenServer
  def handle_call(:subscription, _from, state) do
    {:reply, {state.pubsub, state.topic}, state}
  end

  def handle_call(:current, _from, state), do: {:reply, state.current, state}

  def handle_call(:refresh, from, state) do
    {:noreply, queue_refresh(state, from)}
  end

  @impl GenServer
  def handle_info(
        {:scheduled_refresh, token},
        %{poll_timer: %{token: token}} = state
      ) do
    {:noreply, state |> Map.put(:poll_timer, nil) |> queue_refresh(nil)}
  end

  def handle_info({:scheduled_refresh, _stale_token}, state), do: {:noreply, state}

  def handle_info(
        {@refresh_result, token, result},
        %{refresh_job: %{token: token, monitor: monitor}} = state
      ) do
    Process.demonitor(monitor, [:flush])
    {:noreply, complete_refresh(result, %{state | refresh_job: nil})}
  end

  def handle_info(
        {:DOWN, monitor, :process, _pid, reason},
        %{refresh_job: %{monitor: monitor}} = state
      ) do
    state = state |> Map.put(:refresh_job, nil) |> disconnect()
    {:noreply, complete_refresh({:error, {:refresh_worker_down, reason}, state}, state)}
  end

  def handle_info(_message, state), do: {:noreply, state}

  @impl GenServer
  def terminate(_reason, state) do
    _ = cancel_poll_timer(state)
    if state.refresh_job, do: Process.exit(state.refresh_job.pid, :shutdown)
    _ = disconnect(state)
    :ok
  end

  defp queue_refresh(%{refresh_job: nil} = state, waiter) do
    token = make_ref()
    owner = self()
    snapshot = %{state | refresh_job: nil, waiters: []}

    {:ok, pid} =
      Task.start(fn ->
        send(owner, {@refresh_result, token, pull_projection(snapshot)})
      end)

    monitor = Process.monitor(pid)

    %{
      state
      | refresh_job: %{token: token, pid: pid, monitor: monitor},
        waiters: add_waiter(state.waiters, waiter)
    }
  end

  defp queue_refresh(state, waiter) do
    %{state | waiters: add_waiter(state.waiters, waiter)}
  end

  defp add_waiter(waiters, nil), do: waiters
  defp add_waiter(waiters, waiter), do: [waiter | waiters]

  defp complete_refresh({:ok, payload, pulled_state}, state) do
    current = {:fresh, payload}
    unchanged_fresh? = match?({:fresh, _payload}, state.current) and state.log == pulled_state.log

    state = merge_pull_state(state, pulled_state)

    state
    |> maybe_publish(current, unchanged_fresh?)
    |> reply_waiters(current)
    |> schedule_next_refresh(:success)
  end

  defp complete_refresh({:error, reason, pulled_state}, state) do
    current = failure_state(state.current, reason)

    state
    |> merge_pull_state(pulled_state)
    |> publish(current)
    |> reply_waiters(current)
    |> schedule_next_refresh(:failure)
  end

  defp merge_pull_state(state, pulled_state) do
    %{state | conn: pulled_state.conn, log: pulled_state.log}
  end

  defp publish(state, current) do
    :ok = Phoenix.PubSub.broadcast(state.pubsub, state.topic, {@event, current})
    %{state | current: current}
  end

  defp maybe_publish(state, current, true), do: %{state | current: current}
  defp maybe_publish(state, current, false), do: publish(state, current)

  defp reply_waiters(state, current) do
    Enum.each(state.waiters, &GenServer.reply(&1, {:ok, current}))
    %{state | waiters: []}
  end

  defp schedule_initial_refresh(%{schedule: :manual} = state), do: state

  defp schedule_initial_refresh(state) do
    arm_scheduled_refresh(state, state.schedule.initial_delay_ms)
  end

  defp schedule_next_refresh(%{schedule: :manual} = state, _result), do: state

  defp schedule_next_refresh(state, :success) do
    state
    |> Map.put(:attempt, Backoff.reset_attempt())
    |> arm_scheduled_refresh(state.schedule.poll_interval_ms)
  end

  defp schedule_next_refresh(state, :failure) do
    delay_ms = Backoff.delay_ms(state.schedule.backoff, state.attempt)

    state
    |> Map.put(:attempt, state.attempt + 1)
    |> arm_scheduled_refresh(delay_ms)
  end

  defp arm_scheduled_refresh(state, delay_ms) do
    state = cancel_poll_timer(state)
    token = make_ref()
    timer_ref = Process.send_after(self(), {:scheduled_refresh, token}, delay_ms)
    %{state | poll_timer: %{ref: timer_ref, token: token}}
  end

  defp cancel_poll_timer(%{poll_timer: nil} = state), do: state

  defp cancel_poll_timer(state) do
    _ = Process.cancel_timer(state.poll_timer.ref)
    %{state | poll_timer: nil}
  end

  defp normalize_schedule(:manual, _replica), do: :manual

  defp normalize_schedule(opts, replica) when is_list(opts) do
    opts =
      Keyword.validate!(opts,
        initial_delay_ms: 0,
        poll_interval_ms: 1_000,
        backoff: Backoff.new(base_ms: 250, max_ms: 10_000, seed: replica)
      )

    %{
      initial_delay_ms: Keyword.fetch!(opts, :initial_delay_ms),
      poll_interval_ms: Keyword.fetch!(opts, :poll_interval_ms),
      backoff: Keyword.fetch!(opts, :backoff)
    }
  end

  defp pull_projection(state) do
    case ensure_connected(state) do
      {:ok, conn} -> pull_connected(%{state | conn: conn})
      {:error, reason} -> {:error, reason, state}
    end
  end

  defp pull_connected(state) do
    with {:ok, peer_ids, conn} <- state.carrier.advertise(state.conn, state.log),
         :ok <- ensure_no_peer_regression(state.log, peer_ids),
         {:ok, ops, conn} <- state.carrier.pull(conn, Log.op_ids(state.log)),
         {log, report} = Sync.deliver(state.log, ops),
         :ok <- ensure_complete_delivery(report) do
      payload = project(log, state)
      {:ok, payload, %{state | conn: conn, log: log}}
    else
      {:error, reason} -> {:error, reason, disconnect(state)}
    end
  end

  defp ensure_connected(%{conn: nil} = state), do: state.carrier.connect(state.connect_opts)
  defp ensure_connected(state), do: {:ok, state.conn}

  defp disconnect(%{conn: nil} = state), do: state

  defp disconnect(state) do
    _ = safe_close(state.carrier, state.conn)
    %{state | conn: nil}
  end

  defp safe_close(carrier, conn) do
    carrier.close(conn)
  catch
    _kind, _reason -> :ok
  end

  defp ensure_no_peer_regression(log, peer_ids) do
    missing_ids = log |> Log.op_ids() |> MapSet.difference(peer_ids) |> Enum.sort()

    case missing_ids do
      [] -> :ok
      ids -> {:error, {:peer_regression, ids}}
    end
  end

  defp ensure_complete_delivery(%{rejected: [], pending: []}), do: :ok

  defp ensure_complete_delivery(report) do
    {:error, {:incomplete_delivery, Map.take(report, [:rejected, :pending])}}
  end

  defp failure_state({:fresh, payload}, reason), do: {:stale, stale(payload, reason)}
  defp failure_state({:stale, payload}, reason), do: {:stale, stale(payload, reason)}
  defp failure_state(_current, reason), do: {:unavailable, reason}

  defp stale(payload, reason) do
    provenance = %{payload.provenance | freshness: :stale, last_error: reason}
    %{payload | provenance: provenance}
  end

  defp project(log, state) do
    %{
      read_model: ReadModel.observe(log, labels: state.labels, vouches: state.vouches),
      causal_replay: ReadModel.replay(log),
      provenance: %{
        source: :carrier,
        freshness: :fresh,
        verification: :arrival,
        verified: true,
        peer_realm: state.peer_realm,
        replica: state.replica,
        frontier: Log.frontier(log),
        pulled_at: DateTime.utc_now(),
        last_error: nil
      }
    }
  end
end
