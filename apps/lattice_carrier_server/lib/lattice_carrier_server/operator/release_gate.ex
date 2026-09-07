defmodule LatticeCarrierServer.Operator.ReleaseGate do
  @moduledoc """
  Private release-incarnation admission owner. Closing is irreversible within an
  application incarnation. Process loss invalidates observations; it is never
  evidence that an outstanding filesystem effect drained.
  """
  use GenServer

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

  @impl true
  def init(opts) do
    first? = :atomics.compare_exchange(Keyword.fetch!(opts, :latch), 1, 0, 1) == :ok

    {:ok,
     %{
       incarnation: make_ref(),
       phase: if(first?, do: :accepting, else: :invalid),
       attempt: nil,
       expected: nil,
       leases: %{},
       identities: %{},
       epoch: 0,
       receipt: nil
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

      true ->
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

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    owned? =
      Enum.any?(state.leases, fn {_, {_, monitor, _}} -> monitor == ref end) or
        Enum.any?(state.identities, fn {_, {_, monitor}} -> monitor == ref end)

    next =
      cond do
        not owned? ->
          state

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
  defp invalidate(state), do: %{state | phase: :invalid, receipt: nil}

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
