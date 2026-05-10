defmodule Lattice.Graph.Inspector do
  @moduledoc """
  Consent-gated process graph inspector target.
  """

  use GenServer

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts)
  end

  @impl true
  def init(_opts), do: {:ok, %{}}

  @impl true
  def handle_call({:lattice_call, %{payload: %{op: :snapshot}}}, _from, state) do
    {:reply, {:ok, Lattice.Graph.Snapshot.build()}, state}
  end

  def handle_call({:lattice_call, %{payload: %{"op" => "snapshot"}}}, _from, state) do
    {:reply, {:ok, Lattice.Graph.Snapshot.build()}, state}
  end

  def handle_call({:lattice_call, _envelope}, _from, state) do
    {:reply, {:error, :unsupported_introspection_op}, state}
  end
end
