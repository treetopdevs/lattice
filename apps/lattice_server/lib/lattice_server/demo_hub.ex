defmodule LatticeServer.DemoHub do
  @moduledoc """
  Browser-demo presence and story coordinator.

  This is deliberately outside the authority path. It only observes connected
  WebSocket tabs, broadcasts visual state, and starts demo bridge stories that
  still go through `Lattice.bridge/4` and `Lattice.call/3`.
  """

  use GenServer

  @max_events 80

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def register(tab, opts \\ []) do
    GenServer.call(__MODULE__, {:register, tab, self(), opts})
  end

  def unregister(tab_id), do: GenServer.call(__MODULE__, {:unregister, tab_id})
  def snapshot, do: GenServer.call(__MODULE__, :snapshot)
  def reset, do: GenServer.call(__MODULE__, :reset)
  def event(kind, data \\ %{}), do: GenServer.cast(__MODULE__, {:event, kind, data})

  @impl true
  def init(_opts) do
    {:ok, %{tabs: %{}, order: [], events: [], story_runs: MapSet.new(), sequence: 0}}
  end

  @impl true
  def handle_call({:register, tab, pid, opts}, _from, state) do
    entry = %{
      id: tab.id,
      session_id: tab.session_id,
      pid: pid,
      client_id: Map.get(tab.metadata, :client_id) || Map.get(tab.metadata, "client_id"),
      connected_at: System.system_time(:millisecond),
      label: label_for(length(state.order)),
      hue: hue_for(length(state.order))
    }

    known? = Map.has_key?(state.tabs, tab.id)
    order = if known?, do: state.order, else: state.order ++ [tab.id]
    state = put_in(%{state | order: order}, [:tabs, tab.id], entry)
    state = add_event(state, :tab_connect, %{tab_id: tab.id, label: entry.label})
    broadcast_presence(state)
    broadcast_event(List.first(state.events), state)

    state =
      if Keyword.get(opts, :auto_story?, true) do
        maybe_start_story(state)
      else
        state
      end

    {:reply, snapshot_from(state), state}
  end

  def handle_call({:unregister, tab_id}, _from, state) do
    state = %{
      state
      | tabs: Map.delete(state.tabs, tab_id),
        order: Enum.reject(state.order, &(&1 == tab_id))
    }

    state = add_event(state, :tab_disconnect, %{tab_id: tab_id})
    broadcast_presence(state)
    broadcast_event(List.first(state.events), state)
    {:reply, :ok, state}
  end

  def handle_call(:snapshot, _from, state), do: {:reply, snapshot_from(state), state}

  def handle_call(:reset, _from, _state) do
    {:reply, :ok, %{tabs: %{}, order: [], events: [], story_runs: MapSet.new(), sequence: 0}}
  end

  @impl true
  def handle_cast({:event, kind, data}, state) do
    state = add_event(state, kind, data)
    broadcast_event(List.first(state.events), state)
    {:noreply, state}
  end

  defp maybe_start_story(%{order: [a, b | _], story_runs: runs} = state) do
    pair = pair_key(a, b)

    if MapSet.member?(runs, pair) do
      state
    else
      Task.start(fn -> run_bridge_story(a, b) end)
      %{state | story_runs: MapSet.put(runs, pair)}
    end
  end

  defp maybe_start_story(state), do: state

  defp run_bridge_story(tab_a, tab_b) do
    Process.sleep(650)
    event(:bridge_intent, %{from_tab_id: tab_a, to_tab_id: tab_b})
    send_bridge_pulse(tab_a, tab_b, "first-light")
    Process.sleep(900)
    event(:bridge_intent, %{from_tab_id: tab_b, to_tab_id: tab_a})
    send_bridge_pulse(tab_b, tab_a, "return-light")
  end

  defp send_bridge_pulse(from_tab, to_tab, pulse) do
    case Lattice.bridge(from_tab, to_tab, [:call], ttl: 20_000) do
      {:ok, cap} ->
        event(:bridge_open, %{from_tab_id: from_tab, to_tab_id: to_tab, cap_id: cap.id})

        result =
          Lattice.call(from_tab, cap, %{
            "op" => "story_pulse",
            "pulse" => pulse,
            "from_tab_id" => from_tab,
            "to_tab_id" => to_tab
          })

        event(:bridge_result, %{
          from_tab_id: from_tab,
          to_tab_id: to_tab,
          cap_id: cap.id,
          result: simplify_result(result)
        })

      {:error, reason} ->
        event(:deny, %{from_tab_id: from_tab, to_tab_id: to_tab, reason: inspect(reason)})
    end
  end

  defp simplify_result({:ok, result}), do: result
  defp simplify_result({:error, reason}), do: inspect(reason)

  defp add_event(state, kind, data) do
    event = %{
      id: state.sequence + 1,
      kind: kind,
      data: data,
      at: System.system_time(:millisecond)
    }

    %{state | events: [event | Enum.take(state.events, @max_events - 1)], sequence: event.id}
  end

  defp broadcast_presence(state) do
    broadcast(
      %{
        type: "presence",
        tabs: tabs_from(state),
        audit_count: length(Lattice.audit_events()),
        liveops: liveops_snapshot()
      },
      state
    )
  end

  defp broadcast_event(event, state) when is_map(event) do
    broadcast(
      %{
        type: "server_event",
        event: event,
        audit_count: length(Lattice.audit_events()),
        liveops: liveops_snapshot()
      },
      state
    )
  end

  defp broadcast(frame, state) do
    live_client_ids =
      state.tabs
      |> Enum.map(fn {_tab_id, entry} -> entry.client_id end)
      |> Enum.reject(&is_nil/1)
      |> MapSet.new()

    Enum.each(state.tabs, fn {_tab_id, entry} ->
      send(entry.pid, {:lattice_demo_push, sequence_frame(entry.client_id, frame)})
    end)

    LatticeServer.ResumeProxy.push_disconnected(frame, live_client_ids)
  end

  defp sequence_frame(nil, frame), do: frame

  defp sequence_frame(client_id, frame) do
    case LatticeServer.ResumeProxy.push(client_id, frame) do
      {:ok, sequenced} -> sequenced
      {:error, _reason} -> frame
    end
  end

  defp snapshot_from(state) do
    %{
      type: "snapshot",
      tabs: tabs_from(state),
      events: Enum.reverse(state.events),
      audit_count: length(Lattice.audit_events()),
      liveops: liveops_snapshot()
    }
  end

  defp tabs_from(state) do
    Enum.map(state.order, fn tab_id ->
      entry = Map.fetch!(state.tabs, tab_id)
      Map.take(entry, [:id, :session_id, :connected_at, :label, :hue])
    end)
  end

  defp pair_key(a, b), do: [a, b] |> Enum.sort() |> Enum.join("|")

  defp label_for(index) do
    ["A", "B", "C", "D"]
    |> Enum.at(index, "Z")
  end

  defp hue_for(index) do
    Enum.at([152, 280, 32, 210], rem(index, 4))
  end

  defp liveops_snapshot do
    if Process.whereis(Lattice.LiveOps) do
      Lattice.LiveOps.snapshot()
    else
      nil
    end
  end
end
