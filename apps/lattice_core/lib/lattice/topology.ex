defmodule Lattice.Topology do
  @moduledoc """
  Realm connectivity and lifecycle state.

  The default topology is server-star only. Cross-tab delivery is rejected
  unless a bridge was explicitly created and the matching capability is used.
  """

  use GenServer

  alias Lattice.{Audit, Cap, Tab}

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

  def snapshot, do: GenServer.call(__MODULE__, :snapshot)
  def reset, do: GenServer.call(__MODULE__, :reset)

  @impl true
  def init(_opts) do
    {:ok, %{tabs: %{}, bridges: %{}}}
  end

  @impl true
  def handle_call({:connect_tab, attrs}, _from, state) do
    tab = Tab.new(attrs)

    Audit.record(:tab_connect, %{
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
        Audit.record(:worker_spawn, %{tab_id: tab_id, worker: inspect(pid)})
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
    with %Tab{state: :connected} <- Map.get(state.tabs, from_tab_id),
         %Tab{state: :connected} <- Map.get(state.tabs, to_tab_id) do
      bridge = %{
        cap_id: cap.id,
        from_tab_id: from_tab_id,
        to_tab_id: to_tab_id,
        ops: cap.ops,
        expires_at: cap.expires_at,
        created_at: System.monotonic_time(:millisecond)
      }

      Audit.record(:bridge, %{from_tab_id: from_tab_id, to_tab_id: to_tab_id, cap_id: cap.id})
      {:reply, {:ok, bridge}, put_in(state, [:bridges, cap.id], bridge)}
    else
      _ ->
        Audit.record(:deny, %{
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
    {reply, state} = close_tab(state, tab_id, :disconnected, :tab_disconnect, :normal)
    {:reply, reply, state}
  end

  def handle_call({:eject, tab_id, reason}, _from, state) do
    {reply, state} = close_tab(state, tab_id, :ejected, :tab_eject, reason)
    {:reply, reply, state}
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

  def handle_call(:reset, _from, state) do
    state.tabs
    |> Map.values()
    |> Enum.each(&cleanup_workers(&1, :reset))

    {:reply, :ok, %{tabs: %{}, bridges: %{}}}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    case Enum.find(state.tabs, fn {_id, tab} -> tab.connection_ref == ref end) do
      {tab_id, _tab} ->
        {_reply, state} =
          close_tab(state, tab_id, :disconnected, :tab_disconnect, :connection_down)

        Task.start(fn -> Lattice.CapStore.revoke_tab(tab_id, :connection_down) end)
        {:noreply, state}

      nil ->
        {:noreply, remove_dead_worker(state)}
    end
  end

  defp close_tab(state, tab_id, lifecycle_state, audit_type, reason) do
    case Map.fetch(state.tabs, tab_id) do
      {:ok, %Tab{state: :connected} = tab} ->
        cleanup_workers(tab, reason)
        closed_tab = Tab.close(tab, lifecycle_state)

        Audit.record(audit_type, %{
          tab_id: tab_id,
          reason: inspect(reason),
          session_id: tab.session_id
        })

        {{:ok, closed_tab}, put_in(state, [:tabs, tab_id], closed_tab)}

      {:ok, tab} ->
        {{:ok, tab}, state}

      :error ->
        {{:error, :unknown_tab}, state}
    end
  end

  defp cleanup_workers(%Tab{} = tab, reason) do
    Enum.each(tab.owned_workers, fn pid ->
      if Process.alive?(pid) do
        DynamicSupervisor.terminate_child(Lattice.TabWorkerSupervisor, pid)
      end

      Audit.record(:worker_cleanup, %{
        tab_id: tab.id,
        worker: inspect(pid),
        reason: inspect(reason)
      })
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
