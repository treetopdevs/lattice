defmodule Lattice.Topology do
  @moduledoc """
  Realm connectivity and lifecycle state.

  The default topology is server-star only. Cross-tab delivery is rejected
  unless a bridge was explicitly created and the matching capability is used.

  ## Audit outages (row 313)

  Every Audit record goes through one bounded `Lattice.Audit.Backlog`, as in
  `Lattice.CapStore`, so an Audit restart no longer exits Topology and wipes
  the in-memory tabs. Connects, worker registration, disconnects, ejects,
  connection-down closes and their worker and bridge cleanup always commit and
  defer their records. `create_bridge/3` is the one authority-increasing action:
  it flushes first and is refused with `{:error, :audit_unavailable}`, state
  unchanged, while the backlog is full. A stalled Audit still exits Topology.
  """

  use GenServer

  alias Lattice.Audit.Backlog
  alias Lattice.{Cap, Tab}

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def connect_tab(attrs), do: GenServer.call(__MODULE__, {:connect_tab, attrs})
  def get_tab(tab_id), do: GenServer.call(__MODULE__, {:get_tab, tab_id})
  def tab_connected?(tab_id), do: GenServer.call(__MODULE__, {:tab_connected?, tab_id})
  def disconnect_tab(tab_id), do: GenServer.call(__MODULE__, {:disconnect_tab, tab_id})
  def eject(tab_id, reason), do: GenServer.call(__MODULE__, {:eject, tab_id, reason})

  def register_cap(tab_id, cap_id),
    do: GenServer.call(__MODULE__, {:register_cap, tab_id, cap_id})

  def register_worker(tab_id, pid),
    do: GenServer.call(__MODULE__, {:register_worker, tab_id, pid})

  def unregister_worker(tab_id, pid),
    do: GenServer.call(__MODULE__, {:unregister_worker, tab_id, pid})

  def create_bridge(from_tab_id, to_tab_id, %Cap{} = cap),
    do: GenServer.call(__MODULE__, {:bridge, from_tab_id, to_tab_id, cap})

  def bridge_allowed?(from_tab_id, to_tab_id, cap_id),
    do: GenServer.call(__MODULE__, {:bridge_allowed?, from_tab_id, to_tab_id, cap_id})

  def deliver_to_tab(tab_id, envelope, timeout \\ 5_000) do
    with {:ok, {transport, connection_pid}} <-
           GenServer.call(__MODULE__, {:delivery_info, tab_id}) do
      transport.deliver_call(connection_pid, envelope, timeout)
    end
  end

  def deliver_cast_to_tab(tab_id, envelope) do
    with {:ok, {transport, connection_pid}} <-
           GenServer.call(__MODULE__, {:delivery_info, tab_id}) do
      transport.deliver_cast(connection_pid, envelope)
    end
  end

  def snapshot, do: GenServer.call(__MODULE__, :snapshot)
  def reset, do: GenServer.call(__MODULE__, :reset)

  @doc """
  Replays Audit records deferred while `Lattice.Audit` was unavailable.

  Same contract as `Lattice.CapStore.flush_audit/0`:
  `{:ok, %{flushed: n, pending: m, gap: g}}`.
  """
  def flush_audit, do: GenServer.call(__MODULE__, :flush_audit)

  @impl true
  def init(_opts) do
    {:ok, fresh_state(Backlog.new(__MODULE__))}
  end

  @impl true
  def handle_call({:connect_tab, attrs}, _from, state) do
    tab = Tab.new(attrs)

    state =
      state
      |> prepare_audit()
      |> audit(:tab_connect, %{
        tab_id: tab.id,
        session_id: tab.session_id,
        identity: tab.identity
      })

    {:reply, {:ok, tab}, put_in(state, [:tabs, tab.id], tab)}
  end

  def handle_call({:get_tab, tab_id}, _from, state) do
    {:reply, Map.fetch(state.tabs, tab_id), state}
  end

  def handle_call({:tab_connected?, tab_id}, _from, state) do
    {:reply, match?(%Tab{state: :connected}, Map.get(state.tabs, tab_id)), state}
  end

  def handle_call({:register_cap, tab_id, cap_id}, _from, state) do
    case Map.fetch(state.tabs, tab_id) do
      {:ok, %Tab{state: :connected} = tab} ->
        {:reply, :ok, put_in(state, [:tabs, tab_id], Tab.put_cap(tab, cap_id))}

      {:ok, _tab} ->
        {:reply, {:error, :tab_not_connected}, state}

      :error ->
        {:reply, {:error, :unknown_tab}, state}
    end
  end

  def handle_call({:register_worker, tab_id, pid}, _from, state) do
    case Map.fetch(state.tabs, tab_id) do
      {:ok, %Tab{state: :connected} = tab} ->
        Process.monitor(pid)

        state =
          state
          |> prepare_audit()
          |> audit(:worker_spawn, %{tab_id: tab_id, worker: inspect(pid)})

        {:reply, :ok, put_in(state, [:tabs, tab_id], Tab.put_worker(tab, pid))}

      {:ok, _tab} ->
        {:reply, {:error, :tab_not_connected}, state}

      :error ->
        {:reply, {:error, :unknown_tab}, state}
    end
  end

  def handle_call({:unregister_worker, tab_id, pid}, _from, state) do
    state =
      update_in(state, [:tabs, tab_id], fn
        nil -> nil
        tab -> Tab.remove_worker(tab, pid)
      end)

    {:reply, :ok, state}
  end

  def handle_call({:bridge, from_tab_id, to_tab_id, %Cap{} = cap}, _from, state) do
    state = prepare_audit(state)

    with %Tab{state: :connected} <- Map.get(state.tabs, from_tab_id),
         %Tab{state: :connected} <- Map.get(state.tabs, to_tab_id) do
      if Backlog.full?(state.audit) do
        state =
          audit(state, :deny, %{
            reason: :audit_unavailable,
            from_tab_id: from_tab_id,
            to_tab_id: to_tab_id,
            cap_id: cap.id
          })

        {:reply, {:error, :audit_unavailable}, state}
      else
        bridge = %{
          cap_id: cap.id,
          from_tab_id: from_tab_id,
          to_tab_id: to_tab_id,
          ops: cap.ops,
          expires_at: cap.expires_at,
          created_at: System.monotonic_time(:millisecond)
        }

        state =
          audit(state, :bridge, %{from_tab_id: from_tab_id, to_tab_id: to_tab_id, cap_id: cap.id})

        {:reply, {:ok, bridge}, put_in(state, [:bridges, cap.id], bridge)}
      end
    else
      _ ->
        state =
          audit(state, :deny, %{
            reason: :bridge_tab_not_connected,
            from_tab_id: from_tab_id,
            to_tab_id: to_tab_id
          })

        {:reply, {:error, :tab_not_connected}, state}
    end
  end

  def handle_call({:bridge_allowed?, from_tab_id, to_tab_id, cap_id}, _from, state) do
    allowed? =
      case Map.get(state.bridges, cap_id) do
        %{from_tab_id: ^from_tab_id, to_tab_id: ^to_tab_id} -> true
        _ -> false
      end

    {:reply, allowed?, state}
  end

  def handle_call({:delivery_info, tab_id}, _from, state) do
    case Map.fetch(state.tabs, tab_id) do
      {:ok, %Tab{state: :connected, transport: transport, connection_pid: connection_pid}} ->
        {:reply, {:ok, {transport, connection_pid}}, state}

      {:ok, _tab} ->
        {:reply, {:error, :tab_not_connected}, state}

      :error ->
        {:reply, {:error, :unknown_tab}, state}
    end
  end

  def handle_call({:disconnect_tab, tab_id}, _from, state) do
    {reply, state} =
      close_tab(prepare_audit(state), tab_id, :disconnected, :tab_disconnect, :normal)

    {:reply, reply, state}
  end

  def handle_call({:eject, tab_id, reason}, _from, state) do
    {reply, state} = close_tab(prepare_audit(state), tab_id, :ejected, :tab_eject, reason)
    {:reply, reply, state}
  end

  def handle_call(:flush_audit, _from, state) do
    {audit, %{flushed: flushed, outcome: outcome}} = Backlog.flush(state.audit)
    state = arm_audit_retry(%{state | audit: audit}, outcome)
    {:reply, {:ok, Map.put(Backlog.status(state.audit), :flushed, flushed)}, state}
  end

  def handle_call(:snapshot, _from, state) do
    {:reply,
     %{
       tabs: state.tabs,
       bridges: state.bridges,
       connected_tab_ids:
         state.tabs
         |> Enum.filter(fn {_id, tab} -> tab.state == :connected end)
         |> Enum.map(fn {id, _tab} -> id end)
         |> MapSet.new()
     }, state}
  end

  # Cleanup records are written (or queued) before the drain; what Audit cannot
  # take is counted in a `:reset` gap carried into the fresh state (D-241).
  def handle_call(:reset, _from, state) do
    state =
      state.tabs
      |> Map.values()
      |> Enum.reduce(prepare_audit(state), &cleanup_workers(&2, &1, :reset))

    cancel_audit_retry(state)
    audit = state.audit |> Backlog.drain() |> Backlog.discard_into_gap(:reset)
    {:reply, :ok, arm_audit_retry(fresh_state(audit), :unavailable)}
  end

  @impl true
  def handle_info(:flush_audit, state) do
    {audit, %{outcome: outcome}} = Backlog.flush(state.audit)
    {:noreply, arm_audit_retry(%{state | audit: audit, audit_retry: nil}, outcome)}
  end

  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    case Enum.find(state.tabs, fn {_id, tab} -> tab.connection_ref == ref end) do
      {tab_id, _tab} ->
        {_reply, state} =
          state
          |> prepare_audit()
          |> close_tab(tab_id, :disconnected, :tab_disconnect, :connection_down)

        Task.start(fn -> Lattice.CapStore.revoke_tab(tab_id, :connection_down) end)
        {:noreply, state}

      nil ->
        {:noreply, remove_dead_worker(state)}
    end
  end

  defp close_tab(state, tab_id, lifecycle_state, audit_type, reason) do
    case Map.fetch(state.tabs, tab_id) do
      {:ok, %Tab{state: :connected} = tab} ->
        state = cleanup_workers(state, tab, reason)
        closed_tab = Tab.close(tab, lifecycle_state)
        {bridges, removed_bridge_ids} = remove_tab_bridges(state.bridges, tab_id)

        state =
          audit(state, audit_type, %{
            tab_id: tab_id,
            reason: inspect(reason),
            session_id: tab.session_id
          })

        state =
          Enum.reduce(removed_bridge_ids, state, fn bridge_id, state ->
            audit(state, :bridge_cleanup, %{
              tab_id: tab_id,
              bridge_id: bridge_id,
              reason: inspect(reason)
            })
          end)

        state =
          state
          |> put_in([:tabs, tab_id], closed_tab)
          |> Map.put(:bridges, bridges)

        {{:ok, closed_tab}, state}

      {:ok, tab} ->
        {{:ok, tab}, state}

      :error ->
        {{:error, :unknown_tab}, state}
    end
  end

  defp cleanup_workers(state, %Tab{} = tab, reason) do
    Enum.reduce(tab.owned_workers, state, fn pid, state ->
      if Process.alive?(pid) do
        DynamicSupervisor.terminate_child(Lattice.TabWorkerSupervisor, pid)
      end

      audit(state, :worker_cleanup, %{
        tab_id: tab.id,
        worker: inspect(pid),
        reason: inspect(reason)
      })
    end)
  end

  defp fresh_state(audit), do: %{tabs: %{}, bridges: %{}, audit: audit, audit_retry: nil}

  # The audit helpers below mirror `Lattice.CapStore` (row 313).
  defp prepare_audit(state) do
    if Backlog.owed?(state.audit) do
      {audit, %{outcome: outcome}} = Backlog.flush(state.audit)
      arm_audit_retry(%{state | audit: audit}, outcome)
    else
      state
    end
  end

  defp audit(state, type, metadata) do
    case Backlog.record(state.audit, type, metadata) do
      {:written, audit} -> %{state | audit: audit}
      {_deferred_or_dropped, audit} -> arm_audit_retry(%{state | audit: audit}, :unavailable)
    end
  end

  defp arm_audit_retry(state, outcome) do
    cond do
      not Backlog.owed?(state.audit) ->
        state

      outcome == :more ->
        cancel_audit_retry(state)
        %{state | audit_retry: Process.send_after(self(), :flush_audit, 0)}

      state.audit_retry == nil ->
        %{state | audit_retry: Process.send_after(self(), :flush_audit, Backlog.retry_ms())}

      true ->
        state
    end
  end

  defp cancel_audit_retry(%{audit_retry: nil}), do: :ok

  defp cancel_audit_retry(%{audit_retry: ref}) do
    if Process.cancel_timer(ref) == false do
      receive do
        :flush_audit -> :ok
      after
        0 -> :ok
      end
    end

    :ok
  end

  defp remove_tab_bridges(bridges, tab_id) do
    Enum.reduce(bridges, {%{}, []}, fn {id, bridge}, {kept, removed} ->
      if bridge.from_tab_id == tab_id or bridge.to_tab_id == tab_id do
        {kept, [id | removed]}
      else
        {Map.put(kept, id, bridge), removed}
      end
    end)
  end

  defp remove_dead_worker(state) do
    update_in(state.tabs, fn tabs ->
      Map.new(tabs, fn {id, tab} ->
        live_workers = Enum.filter(tab.owned_workers, &Process.alive?/1)
        {id, %{tab | owned_workers: MapSet.new(live_workers)}}
      end)
    end)
  end
end
