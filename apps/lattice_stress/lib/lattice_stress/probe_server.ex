defmodule LatticeStress.ProbeServer do
  @moduledoc """
  Instrumented server target for authority and race tests.

  It records every Lattice-delivered call/cast and optionally notifies the test
  process. Denial tests assert the probe count does not change.
  """

  use GenServer

  def start_link(opts \\ []) do
    case Keyword.get(opts, :registered_name) do
      nil -> GenServer.start_link(__MODULE__, opts)
      name -> GenServer.start_link(__MODULE__, opts, name: name)
    end
  end

  def stats(pid), do: GenServer.call(pid, :stats)
  def reset(pid), do: GenServer.call(pid, :reset)
  def set_barrier(pid, barrier), do: GenServer.call(pid, {:set_barrier, barrier})

  def crash(pid) do
    Process.unlink(pid)
    Process.exit(pid, :kill)
    :ok
  end

  @impl true
  def init(opts) do
    {:ok,
     %{
       owner: Keyword.get(opts, :owner),
       name: Keyword.get(opts, :name, :probe),
       barrier: Keyword.get(opts, :barrier),
       calls: [],
       casts: []
     }}
  end

  @impl true
  def handle_call(:stats, _from, state) do
    {:reply,
     %{
       call_count: length(state.calls),
       cast_count: length(state.casts),
       calls: Enum.reverse(state.calls),
       casts: Enum.reverse(state.casts)
     }, state}
  end

  def handle_call(:reset, _from, state), do: {:reply, :ok, %{state | calls: [], casts: []}}

  def handle_call({:set_barrier, barrier}, _from, state),
    do: {:reply, :ok, %{state | barrier: barrier}}

  def handle_call({:lattice_call, envelope}, _from, state) do
    maybe_notify(state.owner, {:probe_call_started, state.name, envelope})
    maybe_wait(state.barrier)
    maybe_crash(envelope)
    maybe_notify(state.owner, {:probe_call_delivered, state.name, envelope})

    reply =
      {:ok, %{probe: state.name, from_tab_id: envelope.from_tab_id, payload: envelope.payload}}

    {:reply, reply, %{state | calls: [envelope | state.calls]}}
  end

  @impl true
  def handle_cast({:lattice_cast, envelope}, state) do
    maybe_notify(state.owner, {:probe_cast_delivered, state.name, envelope})
    {:noreply, %{state | casts: [envelope | state.casts]}}
  end

  defp maybe_wait(nil), do: :ok

  defp maybe_wait(barrier) do
    LatticeStress.Barrier.wait(barrier)
  end

  defp maybe_crash(%{payload: payload}) do
    if payload_value(payload, :crash) || payload_value(payload, "crash") do
      exit(:probe_crash)
    end
  end

  defp payload_value(payload, key) when is_map(payload), do: Map.get(payload, key)
  defp payload_value(_payload, _key), do: nil

  defp maybe_notify(nil, _message), do: :ok
  defp maybe_notify(owner, message), do: send(owner, message)
end
