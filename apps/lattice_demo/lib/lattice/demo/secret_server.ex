defmodule Lattice.Demo.SecretServer do
  @moduledoc """
  Deliberately present server process that the demo never grants to a tab.
  """

  use GenServer

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def deliveries do
    GenServer.call(__MODULE__, :deliveries)
  end

  def reset_deliveries do
    GenServer.call(__MODULE__, :reset_deliveries)
  end

  @impl true
  def init(_opts), do: {:ok, %{secret: "classified server state", deliveries: []}}

  @impl true
  def handle_call({:lattice_call, _envelope}, _from, state) do
    {:reply, {:ok, %{secret: state.secret}}, %{state | deliveries: [:call | state.deliveries]}}
  end

  def handle_call(:deliveries, _from, state), do: {:reply, Enum.reverse(state.deliveries), state}

  def handle_call(:reset_deliveries, _from, state),
    do: {:reply, :ok, %{state | deliveries: []}}
end
