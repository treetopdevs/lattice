defmodule Lattice.Demo.EchoServer do
  @moduledoc """
  Server process reachable only by an explicit Lattice capability.
  """

  use GenServer

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def last_cast do
    GenServer.call(__MODULE__, :last_cast)
  end

  @impl true
  def init(_opts), do: {:ok, %{last_cast: nil}}

  @impl true
  def handle_call({:lattice_call, %{from_tab_id: tab_id, payload: payload}}, _from, state) do
    {:reply, {:ok, %{echo: payload, from_tab_id: tab_id}}, state}
  end

  def handle_call(:last_cast, _from, state), do: {:reply, state.last_cast, state}

  @impl true
  def handle_cast({:lattice_cast, envelope}, state) do
    Lattice.Audit.record(:demo_echo_cast, %{
      from_tab_id: envelope.from_tab_id,
      payload: envelope.payload
    })

    {:noreply, %{state | last_cast: envelope}}
  end
end
