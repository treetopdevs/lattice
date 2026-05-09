defmodule Lattice.Demo.SecretServer do
  @moduledoc """
  Deliberately present server process that the demo never grants to a tab.
  """

  use GenServer

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts), do: {:ok, %{secret: "classified server state"}}

  @impl true
  def handle_call({:lattice_call, _envelope}, _from, state) do
    {:reply, {:ok, %{secret: state.secret}}, state}
  end
end
