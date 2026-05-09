defmodule Lattice.Audit do
  @moduledoc """
  In-memory audit log for POC validation.

  A production system would stream these events to durable append-only storage.
  The POC keeps them inspectable for tests and demos.
  """

  use GenServer

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  def record(type, metadata \\ %{}) when is_atom(type) and is_map(metadata) do
    GenServer.call(__MODULE__, {:record, type, metadata})
  end

  def events do
    GenServer.call(__MODULE__, :events)
  end

  def reset do
    GenServer.call(__MODULE__, :reset)
  end

  @impl true
  def init(_opts), do: {:ok, []}

  @impl true
  def handle_call({:record, type, metadata}, _from, events) do
    event = %{
      id: length(events) + 1,
      type: type,
      at: System.monotonic_time(:millisecond),
      metadata: metadata
    }

    {:reply, event, [event | events]}
  end

  def handle_call(:events, _from, events) do
    {:reply, Enum.reverse(events), events}
  end

  def handle_call(:reset, _from, _events), do: {:reply, :ok, []}
end
