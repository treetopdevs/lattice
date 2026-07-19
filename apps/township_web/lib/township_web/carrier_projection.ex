defmodule TownshipWeb.CarrierProjection do
  @moduledoc """
  Verified-pull Township instrument projection over an authenticated carrier.

  The projection owns its peer log, carrier connection, read-model derivation,
  and PubSub publication. Availability hints may wake a pull but never materialize
  state directly, and the projection never transfers local operations to the peer.
  """

  use GenServer

  alias Lattice.{Authority, Carrier.Backoff, Log, Sync}
  alias Township.{Matter, ReadModel}

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
    # Carrier wire decoding permits only existing atoms, so load the trusted schema before pulling.
    # SuccessionCertificate owns the witnessed-recovery policy vocabulary
    # (:witnesses, :threshold, :version, :successor) carried by valid-genesis ops.
    Code.ensure_loaded!(Authority)
    Code.ensure_loaded!(Authority.SuccessionCertificate)
    Code.ensure_loaded!(Matter)

    replica = Keyword.fetch!(opts, :replica)
    carrier = Keyword.get(opts, :carrier, Lattice.Carrier.WebSocket)
    feed = Keyword.get(opts, :feed, :poll)

    case validate_feed(carrier, feed) do
      :ok ->
        state =
          %{
            carrier: carrier,
            feed: feed,
            owner: self(),
            connect_opts: Keyword.fetch!(opts, :connect_opts),
            replica: replica,
            peer_realm: Keyword.fetch!(opts, :peer_realm),
            pubsub: Keyword.get(opts, :pubsub, TownshipWeb.PubSub),
            topic: Keyword.get(opts, :topic, "township:instrument"),
            labels: Keyword.get(opts, :labels, %{}),
            vouches: Keyword.get(opts, :vouches, []),
            conn: nil,
            connection_epoch: 0,
            feed_ref: nil,
            pending_feed_ref: nil,
            feed_generation: nil,
            refresh_trigger: nil,
            log: Log.new(replica),
            current: :connecting,
            schedule: normalize_schedule(Keyword.get(opts, :schedule, :manual), replica),
            attempt: Backoff.reset_attempt(),
            poll_timer: nil,
            refresh_job: nil,
            trailing_refresh: nil,
            waiters: []
          }

        {:ok, schedule_initial_refresh(state)}

      {:error, reason} ->
        {:stop, reason}
    end
  end

  @impl GenServer
  def handle_call(:subscription, _from, state) do
    {:reply, {state.pubsub, state.topic}, state}
  end

  def handle_call(:current, _from, state), do: {:reply, state.current, state}

  def handle_call(:refresh, from, state) do
    {:noreply, queue_refresh(state, from, :manual)}
  end

  @impl GenServer
  def handle_info(
        {:scheduled_refresh, token},
        %{poll_timer: %{token: token}} = state
      ) do
    trigger = state.poll_timer.trigger
    {:noreply, state |> Map.put(:poll_timer, nil) |> queue_refresh(nil, trigger)}
  end

  def handle_info({:scheduled_refresh, _stale_token}, state), do: {:noreply, state}

  def handle_info(
        {:lattice_carrier, ref, %{"type" => "ops_available", "generation" => generation}},
        %{feed: :server_push} = state
      )
      when is_reference(ref) and is_integer(generation) and generation >= 0 do
    if active_feed_ref?(state, ref) and newer_generation?(generation, state.feed_generation) do
      state = %{state | feed_generation: generation}
      {:noreply, queue_refresh(state, nil, :server_push)}
    else
      {:noreply, state}
    end
  end

  def handle_info(
        {:lattice_carrier, ref, {:closed, reason}},
        %{feed: :server_push} = state
      )
      when is_reference(ref) do
    if active_feed_ref?(state, ref) do
      failure = {:carrier_closed, reason}
      current = failure_state(state.current, failure)

      state =
        state
        |> disconnect()
        |> publish(current)
        |> queue_refresh(nil, :server_push)

      {:noreply, state}
    else
      {:noreply, state}
    end
  end

  def handle_info(
        {@refresh_result, token, result},
        %{refresh_job: %{token: token, monitor: monitor} = job} = state
      ) do
    Process.demonitor(monitor, [:flush])

    state = %{state | refresh_job: nil}

    state =
      if job.connection_epoch == state.connection_epoch do
        complete_refresh(result, state)
      else
        state
        |> close_discarded_connection(result)
        |> reply_waiters(state.current)
      end

    state = maybe_queue_trailing(state)
    {:noreply, state}
  end

  def handle_info(
        {:DOWN, monitor, :process, _pid, reason},
        %{refresh_job: %{monitor: monitor} = job} = state
      ) do
    state =
      if job.connection_epoch == state.connection_epoch do
        state = state |> Map.put(:refresh_job, nil) |> disconnect()
        complete_refresh({:error, {:refresh_worker_down, reason}, state}, state)
      else
        state |> Map.put(:refresh_job, nil) |> reply_waiters(state.current)
      end

    state = maybe_queue_trailing(state)

    {:noreply, state}
  end

  def handle_info(_message, state), do: {:noreply, state}

  @impl GenServer
  def terminate(_reason, state) do
    _ = cancel_poll_timer(state)
    if state.refresh_job, do: Process.exit(state.refresh_job.pid, :shutdown)
    _ = disconnect(state)
    :ok
  end

  defp queue_refresh(%{refresh_job: nil} = state, waiter, trigger) do
    state = prepare_feed_subscription(state)
    token = make_ref()
    owner = self()
    snapshot = %{state | refresh_job: nil, waiters: [], refresh_trigger: trigger}

    {:ok, pid} =
      Task.start(fn ->
        send(owner, {@refresh_result, token, pull_projection(snapshot)})
      end)

    monitor = Process.monitor(pid)

    %{
      state
      | refresh_job: %{
          token: token,
          pid: pid,
          monitor: monitor,
          connection_epoch: state.connection_epoch
        },
        waiters: add_waiter(state.waiters, waiter)
    }
  end

  defp queue_refresh(state, waiter, :server_push) do
    %{
      state
      | trailing_refresh: :server_push,
        waiters: add_waiter(state.waiters, waiter)
    }
  end

  defp queue_refresh(state, waiter, _trigger) do
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
    %{
      state
      | conn: pulled_state.conn,
        connection_epoch: pulled_state.connection_epoch,
        feed_ref: state.feed_ref || pulled_state.feed_ref,
        pending_feed_ref: pulled_state.pending_feed_ref,
        feed_generation: newest_generation(state.feed_generation, pulled_state.feed_generation),
        log: pulled_state.log
    }
  end

  defp maybe_queue_trailing(%{trailing_refresh: nil} = state), do: state

  defp maybe_queue_trailing(state) do
    trigger = state.trailing_refresh
    state |> Map.put(:trailing_refresh, nil) |> queue_refresh(nil, trigger)
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
    arm_scheduled_refresh(state, state.schedule.initial_delay_ms, :initial)
  end

  defp schedule_next_refresh(%{schedule: :manual} = state, _result), do: state

  defp schedule_next_refresh(state, :success) do
    state
    |> Map.put(:attempt, Backoff.reset_attempt())
    |> arm_scheduled_refresh(state.schedule.poll_interval_ms, :poll)
  end

  defp schedule_next_refresh(state, :failure) do
    delay_ms = Backoff.delay_ms(state.schedule.backoff, state.attempt)

    state
    |> Map.put(:attempt, state.attempt + 1)
    |> arm_scheduled_refresh(delay_ms, :poll)
  end

  defp arm_scheduled_refresh(state, delay_ms, trigger) do
    state = cancel_poll_timer(state)
    token = make_ref()
    timer_ref = Process.send_after(self(), {:scheduled_refresh, token}, delay_ms)
    %{state | poll_timer: %{ref: timer_ref, token: token, trigger: trigger}}
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

  defp validate_feed(_carrier, :poll), do: :ok

  defp validate_feed(carrier, :server_push) do
    if Code.ensure_loaded?(carrier) and function_exported?(carrier, :subscribe, 3) do
      :ok
    else
      {:error, {:unsupported_carrier_feed, carrier}}
    end
  end

  defp validate_feed(_carrier, feed), do: {:error, {:invalid_feed, feed}}

  defp pull_projection(state) do
    case ensure_connected(state) do
      {:ok, state} -> pull_connected(state)
      {:error, reason, state} -> {:error, reason, state}
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
      {:error, reason} ->
        {:error, reason, disconnect(state)}
    end
  end

  defp ensure_connected(%{conn: nil, feed: :poll} = state) do
    case state.carrier.connect(state.connect_opts) do
      {:ok, conn} -> {:ok, %{state | conn: conn}}
      {:error, reason} -> {:error, reason, state}
    end
  end

  defp ensure_connected(%{conn: nil, feed: :server_push} = state) do
    case state.carrier.connect(state.connect_opts) do
      {:ok, conn} -> subscribe_connected(state, conn)
      {:error, reason} -> {:error, reason, clear_pending_feed_ref(state)}
    end
  end

  defp ensure_connected(state), do: {:ok, state}

  defp subscribe_connected(%{pending_feed_ref: ref} = state, conn) when is_reference(ref) do
    case state.carrier.subscribe(conn, state.owner, ref) do
      {:ok, %{ref: ^ref, generation: generation}, conn}
      when is_integer(generation) and generation >= 0 ->
        if newer_or_equal_generation?(generation, state.feed_generation) do
          {:ok,
           %{
             state
             | conn: conn,
               feed_ref: ref,
               pending_feed_ref: nil,
               feed_generation: generation
           }}
        else
          _ = safe_close(state.carrier, conn)

          {:error, {:feed_generation_regression, state.feed_generation, generation},
           clear_pending_feed_ref(state)}
        end

      {:error, reason} ->
        _ = safe_close(state.carrier, conn)
        {:error, reason, clear_pending_feed_ref(state)}

      _other ->
        _ = safe_close(state.carrier, conn)
        {:error, :malformed_subscription, clear_pending_feed_ref(state)}
    end
  end

  defp subscribe_connected(state, conn) do
    _ = safe_close(state.carrier, conn)
    {:error, :missing_pending_subscription, clear_pending_feed_ref(state)}
  end

  defp disconnect(%{conn: nil, feed_ref: nil, pending_feed_ref: nil} = state), do: state

  defp disconnect(%{conn: nil} = state) do
    %{
      state
      | connection_epoch: state.connection_epoch + 1,
        feed_ref: nil,
        pending_feed_ref: nil
    }
  end

  defp disconnect(state) do
    _ = safe_close(state.carrier, state.conn)

    %{
      state
      | conn: nil,
        connection_epoch: state.connection_epoch + 1,
        feed_ref: nil,
        pending_feed_ref: nil
    }
  end

  defp safe_close(carrier, conn) do
    carrier.close(conn)
  catch
    _kind, _reason -> :ok
  end

  defp close_discarded_connection(state, {_status, _value, %{conn: nil}}), do: state

  defp close_discarded_connection(state, {_status, _value, %{conn: conn}}) do
    _ = safe_close(state.carrier, conn)
    state
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
        refresh_trigger: state.refresh_trigger,
        feed_generation: state.feed_generation,
        pulled_at: DateTime.utc_now(),
        last_error: nil
      }
    }
  end

  defp newer_generation?(_generation, nil), do: true
  defp newer_generation?(generation, current), do: generation > current

  defp newer_or_equal_generation?(_generation, nil), do: true
  defp newer_or_equal_generation?(generation, current), do: generation >= current

  defp newest_generation(nil, generation), do: generation
  defp newest_generation(generation, nil), do: generation
  defp newest_generation(left, right), do: max(left, right)

  defp prepare_feed_subscription(%{feed: :server_push, conn: nil, pending_feed_ref: nil} = state) do
    %{state | pending_feed_ref: make_ref()}
  end

  defp prepare_feed_subscription(state), do: state

  defp clear_pending_feed_ref(state), do: %{state | pending_feed_ref: nil}

  defp active_feed_ref?(state, ref) do
    ref == state.feed_ref or ref == state.pending_feed_ref
  end
end
