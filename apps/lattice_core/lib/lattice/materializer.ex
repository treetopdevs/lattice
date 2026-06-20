defmodule Lattice.Materializer do
  @moduledoc """
  An ephemeral materialization process for one `{realm, replica}` pair.

  The process *is* the "live" lifecycle state: while it is alive the materialization
  is `:live`; when it stops, `Lattice.Registry` observes the `:DOWN` and transitions
  the pair to `:dormant`. The durable truth (the op-log, the materialized state, the
  inbox cursor) lives in `Lattice.Registry`, not here — the process is a cache and an
  addressable handle for live queries, exactly as design invariant 1 requires.

  Processes are started under `Lattice.MaterializerSupervisor` and registered by key
  in the `Lattice.Materializer.Registry` so they can be found and addressed.
  """

  use GenServer

  @registry Lattice.Materializer.Registry

  @spec child_spec({String.t(), String.t()}) :: Supervisor.child_spec()
  def child_spec(key) do
    %{id: {__MODULE__, key}, start: {__MODULE__, :start_link, [key]}, restart: :temporary}
  end

  @spec start_link({String.t(), String.t()}) :: GenServer.on_start()
  def start_link(key), do: GenServer.start_link(__MODULE__, key, name: via(key))

  @doc "`:via` tuple addressing the materializer for `key`."
  def via(key), do: {:via, Registry, {@registry, key}}

  @doc "Pid of the live materializer for `key`, or nil."
  def whereis(key) do
    case Registry.lookup(@registry, key) do
      [{pid, _}] -> pid
      [] -> nil
    end
  end

  @doc "Issue a live query against the materialization (fast-path)."
  def query(key, q) do
    case whereis(key) do
      nil ->
        {:error, :not_live}

      pid ->
        # The materializer is transient; it may exit between whereis/1 and the call.
        try do
          GenServer.call(pid, {:query, q})
        catch
          :exit, _ -> {:error, :not_live}
        end
    end
  end

  @impl true
  def init(key), do: {:ok, %{key: key}}

  @impl true
  def handle_call({:query, q}, _from, state) do
    {:reply, Lattice.Registry.query(state.key, q), state}
  end
end
