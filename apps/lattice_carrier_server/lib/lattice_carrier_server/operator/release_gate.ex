defmodule LatticeCarrierServer.Operator.ReleaseGate do
  @moduledoc """
  Private release-incarnation admission owner. Closing is irreversible within an
  application incarnation. Process loss invalidates observations; it is never
  evidence that an outstanding filesystem effect drained.

  The application's latch records, before the state change, that a close or an
  invalidation began. A replacement gate therefore starts invalid only after
  that point; replacing a gate that was still accepting starts a fresh
  accepting incarnation, and the rest-for-one runtime restarts every route
  under it.
  """
  use GenServer

  # Latch values: 0 never started, 1 started and accepting, 2 closing began.
  @open 1
  @closed 2

  @type owner :: {pid(), reference()}

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @spec owner() :: owner()
  def owner, do: GenServer.call(__MODULE__, :owner)

  @spec acquire(owner(), term()) :: {:ok, reference()} | {:error, atom()}
  def acquire({pid, incarnation}, key), do: call(pid, {:acquire, incarnation, key})

  @spec complete(owner(), reference(), term(), pid()) :: :ok | {:error, atom()}
  def complete({pid, incarnation}, lease, key, target),
    do: call(pid, {:complete, incarnation, lease, key, target})

  @spec finish(owner(), reference()) :: :ok | {:error, atom()}
  def finish({pid, incarnation}, lease), do: call(pid, {:finish, incarnation, lease})

  @spec abandon(owner(), reference()) :: :ok | {:error, atom()}
  def abandon({pid, incarnation}, lease), do: call(pid, {:abandon, incarnation, lease})

  @spec accepting?(owner()) :: boolean()
  def accepting?({pid, incarnation}), do: call(pid, {:accepting, incarnation}) == true

  @spec close(owner(), binary(), map()) :: {:ok, map()} | {:error, atom()}
  def close({pid, incarnation}, attempt, expected),
    do: call(pid, {:close, incarnation, attempt, expected})

  @spec snapshot(owner(), binary()) :: {:ok, map()} | {:error, atom()}
  def snapshot({pid, incarnation}, attempt), do: call(pid, {:snapshot, incarnation, attempt})

  @spec commit(owner(), binary(), map(), map(), integer()) :: {:ok, map()} | {:error, atom()}
  def commit({pid, incarnation}, attempt, snapshot, evidence, deadline),
    do: call(pid, {:commit, incarnation, attempt, snapshot, evidence, deadline})

  @spec valid?(owner(), map()) :: boolean()
  def valid?({pid, incarnation}, receipt), do: call(pid, {:valid, incarnation, receipt}) == true

  @doc "Begin an irreversible, incarnation-bound stop of an already drained release."
  @spec begin_stop(owner(), map()) :: {:ok, map()} | {:error, atom()}
  def begin_stop({pid, incarnation}, receipt), do: call(pid, {:begin_stop, incarnation, receipt})

  @doc "Record a private observation after every owned route has stopped."
  @spec seal(owner(), map(), map()) :: {:ok, map()} | {:error, atom()}
  def seal({pid, incarnation}, receipt, evidence),
    do: call(pid, {:seal, incarnation, receipt, evidence})

  @spec sealed?(owner(), map()) :: boolean()
  def sealed?({pid, incarnation}, observation),
    do: call(pid, {:sealed, incarnation, observation}) == true

  @impl true
  def init(opts) do
    latch = Keyword.fetch!(opts, :latch)

    phase =
      case :atomics.compare_exchange(latch, 1, 0, @open) do
        :ok -> :accepting
        @open -> :accepting
        _closed -> :invalid
      end

    {:ok,
     %{
       latch: latch,
       incarnation: make_ref(),
       phase: phase,
       attempt: nil,
       expected: nil,
       leases: %{},
       identities: %{},
       epoch: 0,
       receipt: nil,
       stopper: nil
     }}
  end

  @impl true
  def handle_call(:owner, _from, state), do: {:reply, {self(), state.incarnation}, state}

  def handle_call({:acquire, incarnation, key}, {caller, _}, state) do
    if incarnation == state.incarnation and state.phase == :accepting do
      state = forget_dead_identities(state)
      lease = make_ref()
      monitor = Process.monitor(caller)

      {:reply, {:ok, lease},
       %{state | leases: Map.put(state.leases, lease, {caller, monitor, key})}}
    else
      {:reply, {:error, :release_closed}, state}
    end
  end

  def handle_call({:complete, incarnation, lease, key, target}, {caller, _}, state) do
    case state.leases[lease] do
      {^caller, monitor, ^key} when incarnation == state.incarnation ->
        Process.demonitor(monitor, [:flush])
        state = %{state | leases: Map.delete(state.leases, lease)}

        if Process.alive?(target) and not Map.has_key?(state.identities, key) do
          ref = Process.monitor(target)
          identities = Map.put(state.identities, key, {target, ref})
          {:reply, :ok, %{state | identities: identities, epoch: state.epoch + 1}}
        else
          {:reply, {:error, :release_identity_changed}, invalidate(state)}
        end

      _ ->
        {:reply, {:error, :release_closed}, invalidate(state)}
    end
  end

  def handle_call({:finish, incarnation, lease}, {caller, _}, state) do
    case state.leases[lease] do
      {^caller, monitor, _} when incarnation == state.incarnation and state.phase != :invalid ->
        Process.demonitor(monitor, [:flush])
        {:reply, :ok, %{state | leases: Map.delete(state.leases, lease)}}

      _ ->
        {:reply, {:error, :release_closed}, invalidate(state)}
    end
  end

  def handle_call({:abandon, incarnation, lease}, {caller, _}, state) do
    case state.leases[lease] do
      {^caller, monitor, _} when incarnation == state.incarnation and state.phase == :accepting ->
        Process.demonitor(monitor, [:flush])
        {:reply, :ok, %{state | leases: Map.delete(state.leases, lease)}}

      _ ->
        {:reply, {:error, :release_closed}, invalidate(state)}
    end
  end

  def handle_call({:accepting, incarnation}, _from, state),
    do: {:reply, incarnation == state.incarnation and state.phase == :accepting, state}

  def handle_call({:close, incarnation, attempt, expected}, _from, state) do
    cond do
      incarnation != state.incarnation or state.phase == :invalid ->
        {:reply, {:error, :release_closed}, state}

      state.attempt != nil and (state.attempt != attempt or state.expected != expected) ->
        {:reply, {:error, :release_attempt_changed}, state}

      state.phase in [:stopping, :sealed] ->
        {:reply, {:error, :release_closed}, state}

      true ->
        # Written ahead of the phase change: a crash from here on can never
        # hand the application a replacement gate that accepts again.
        :atomics.put(state.latch, 1, @closed)

        next = %{
          state
          | attempt: attempt,
            expected: expected,
            phase: if(state.phase == :drained, do: :drained, else: :quiescing)
        }

        {:reply, {:ok, view(next)}, next}
    end
  end

  def handle_call({:snapshot, incarnation, attempt}, _from, state) do
    if matches?(state, incarnation, attempt) and live?(state),
      do: {:reply, {:ok, view(state)}, state},
      else: {:reply, {:error, :release_closed}, invalidate(state)}
  end

  def handle_call({:commit, incarnation, attempt, snapshot, evidence, deadline}, _from, state) do
    if matches?(state, incarnation, attempt) and live?(state) and
         map_size(state.leases) == 0 and snapshot == view(state) and
         System.monotonic_time(:millisecond) < deadline do
      receipt = %{
        incarnation: incarnation,
        attempt: attempt,
        epoch: state.epoch,
        evidence: evidence
      }

      {:reply, {:ok, receipt}, %{state | phase: :drained, receipt: receipt}}
    else
      {:reply, {:error, :release_changed}, invalidate(state)}
    end
  end

  def handle_call({:valid, incarnation, receipt}, _from, state),
    do:
      {:reply,
       incarnation == state.incarnation and state.phase == :drained and
         state.receipt == receipt and live?(state), state}

  def handle_call({:begin_stop, incarnation, receipt}, {caller, _}, state) do
    if incarnation == state.incarnation and state.phase in [:drained, :stopping] and
         state.receipt == receipt and live?(state) and
         (state.phase == :drained or elem(state.stopper, 0) == caller) do
      stopper = state.stopper || {caller, Process.monitor(caller)}
      {:reply, {:ok, view(state)}, %{state | phase: :stopping, stopper: stopper}}
    else
      {:reply, {:error, :release_closed}, state}
    end
  end

  def handle_call({:seal, incarnation, receipt, evidence}, {caller, _}, state) do
    if incarnation == state.incarnation and state.phase == :stopping and
         state.stopper != nil and elem(state.stopper, 0) == caller and
         state.receipt == receipt and map_size(state.leases) == 0 and
         Map.keys(state.identities) == [:preflight] and live?(state) do
      Process.demonitor(elem(state.stopper, 1), [:flush])
      observation = %{incarnation: incarnation, receipt: receipt, stopped: evidence}
      {:reply, {:ok, observation}, %{state | phase: :sealed, receipt: observation, stopper: nil}}
    else
      {:reply, {:error, :release_closed}, state}
    end
  end

  def handle_call({:sealed, incarnation, observation}, _from, state),
    do:
      {:reply,
       incarnation == state.incarnation and state.phase == :sealed and
         state.receipt == observation and live?(state), state}

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    owned? =
      Enum.any?(state.leases, fn {_, {_, monitor, _}} -> monitor == ref end) or
        Enum.any?(state.identities, fn {_, {_, monitor}} -> monitor == ref end) or
        (state.stopper != nil and elem(state.stopper, 1) == ref)

    next =
      cond do
        not owned? ->
          state

        state.phase == :stopping and planned_route_down?(state, ref, reason) ->
          %{
            state
            | identities: Map.reject(state.identities, fn {_, {_, monitor}} -> monitor == ref end)
          }

        state.phase != :accepting ->
          invalidate(state)

        true ->
          %{
            state
            | leases: Map.reject(state.leases, fn {_, {_, monitor, _}} -> monitor == ref end),
              identities:
                Map.reject(state.identities, fn {_, {_, monitor}} -> monitor == ref end),
              epoch: state.epoch + 1
          }
      end

    {:noreply, next}
  end

  # Anything else is not addressed to this gate; crashing on it would restart
  # every route for no reason.
  def handle_info(_message, state), do: {:noreply, state}

  defp forget_dead_identities(state) do
    identities =
      Enum.reduce(state.identities, %{}, fn {key, {pid, monitor} = identity}, kept ->
        if Process.alive?(pid) do
          Map.put(kept, key, identity)
        else
          Process.demonitor(monitor, [:flush])
          kept
        end
      end)

    if identities == state.identities,
      do: state,
      else: %{state | identities: identities, epoch: state.epoch + 1}
  end

  defp matches?(state, incarnation, attempt),
    do:
      state.incarnation == incarnation and state.attempt == attempt and
        state.phase in [:quiescing, :drained]

  defp live?(state), do: Enum.all?(state.identities, fn {_, {pid, _}} -> Process.alive?(pid) end)

  # A normal process exit is insufficient: its owning supervisor child must
  # already have been explicitly terminated, rather than restarted after a
  # crash while the coordinator was preparing its stop.
  defp planned_route_down?(state, ref, reason) when reason in [:normal, :shutdown] do
    Enum.any?(state.identities, fn
      {{kind, name}, {_, ^ref}} when kind in [:route, :holder, :listener] ->
        Enum.any?(Supervisor.which_children(LatticeCarrierServer.RuntimeSupervisor), fn
          {{LatticeCarrierServer, ^name}, :undefined, _, _} -> true
          _ -> false
        end)

      _ ->
        false
    end)
  catch
    :exit, _ -> false
  end

  defp planned_route_down?(_, _, _), do: false

  defp invalidate(state) do
    :atomics.put(state.latch, 1, @closed)
    %{state | phase: :invalid, receipt: nil}
  end

  defp view(state),
    do:
      Map.take(state, [
        :incarnation,
        :phase,
        :attempt,
        :expected,
        :leases,
        :identities,
        :epoch,
        :receipt
      ])

  defp call(pid, message) do
    GenServer.call(pid, message)
  catch
    :exit, _ -> {:error, :release_closed}
  end
end
