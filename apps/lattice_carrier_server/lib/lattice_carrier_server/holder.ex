defmodule LatticeCarrierServer.Holder do
  @moduledoc false

  use GenServer

  alias Lattice.{Identity, Log, Sync}

  @frontier_limit 64

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.fetch!(opts, :name))
  end

  @spec via(term()) :: GenServer.name()
  def via(instance) do
    {:via, Registry, {LatticeCarrierServer.Registry, {:holder, instance}}}
  end

  @spec session_context(GenServer.server()) :: {Identity.t(), String.t()}
  def session_context(holder), do: GenServer.call(holder, :session_context)

  @spec op_ids(GenServer.server()) :: [Lattice.Op.id()]
  def op_ids(holder), do: GenServer.call(holder, :op_ids)

  @spec missing_for(GenServer.server(), [Lattice.Op.id()]) :: [Lattice.Op.t()]
  def missing_for(holder, have_ids), do: GenServer.call(holder, {:missing_for, have_ids})

  @spec relay(GenServer.server(), String.t(), Lattice.Op.t()) ::
          {:ok, Sync.report()} | {:error, term()}
  def relay(holder, peer_realm, op), do: GenServer.call(holder, {:relay, peer_realm, op})

  @spec subscribe(GenServer.server(), pid()) :: {:ok, map()}
  def subscribe(holder, subscriber) when is_pid(subscriber) do
    GenServer.call(holder, {:subscribe, subscriber})
  end

  @spec unsubscribe(GenServer.server(), pid()) :: :ok
  def unsubscribe(holder, subscriber) when is_pid(subscriber) do
    GenServer.call(holder, {:unsubscribe, subscriber})
  end

  @spec acknowledge(GenServer.server(), pid(), non_neg_integer()) :: {:ok, map() | nil}
  def acknowledge(holder, subscriber, generation)
      when is_pid(subscriber) and is_integer(generation) and generation >= 0 do
    GenServer.call(holder, {:acknowledge, subscriber, generation})
  end

  @impl GenServer
  def init(opts) do
    identity = Keyword.fetch!(opts, :identity)
    source = Keyword.fetch!(opts, :source)

    case load_source(source) do
      {:ok, log} ->
        {:ok,
         %{
           identity: identity,
           log: log,
           source: source,
           relay_realms: opts |> Keyword.fetch!(:relay_realms) |> MapSet.new(),
           subscribers: %{}
         }}

      {:error, reason} ->
        {:stop, {:source_error, reason}}
    end
  end

  @impl GenServer
  def handle_call(:session_context, _from, state) do
    {:reply, {state.identity, state.log.replica}, state}
  end

  def handle_call(:op_ids, _from, state) do
    {:reply, state.log |> Log.op_ids() |> Enum.sort(), state}
  end

  def handle_call({:missing_for, have_ids}, _from, state) do
    {:reply, Sync.missing(state.log, MapSet.new(have_ids)), state}
  end

  def handle_call({:subscribe, subscriber}, _from, state) do
    subscribers =
      Map.put_new_lazy(state.subscribers, subscriber, fn ->
        %{monitor: Process.monitor(subscriber), outstanding_generation: nil}
      end)

    {:reply, {:ok, availability(state.log)}, %{state | subscribers: subscribers}}
  end

  def handle_call({:unsubscribe, subscriber}, _from, state) do
    {entry, subscribers} = Map.pop(state.subscribers, subscriber)

    if entry do
      Process.demonitor(entry.monitor, [:flush])
    end

    {:reply, :ok, %{state | subscribers: subscribers}}
  end

  def handle_call({:acknowledge, subscriber, generation}, _from, state) do
    case Map.fetch(state.subscribers, subscriber) do
      {:ok, %{outstanding_generation: ^generation} = entry} ->
        latest = availability(state.log)
        reply = if latest.generation > generation, do: latest, else: nil
        entry = %{entry | outstanding_generation: nil}
        subscribers = Map.put(state.subscribers, subscriber, entry)
        {:reply, {:ok, reply}, %{state | subscribers: subscribers}}

      _other ->
        {:reply, {:ok, nil}, state}
    end
  end

  def handle_call({:relay, peer_realm, op}, _from, state) do
    if MapSet.member?(state.relay_realms, peer_realm) do
      {log, report} = Sync.deliver(state.log, [op])
      persist_relay(log, report, state)
    else
      {:reply, {:error, :read_only}, state}
    end
  end

  @impl GenServer
  def handle_info({:DOWN, monitor, :process, subscriber, _reason}, state) do
    subscribers =
      case Map.fetch(state.subscribers, subscriber) do
        {:ok, %{monitor: ^monitor}} -> Map.delete(state.subscribers, subscriber)
        _other -> state.subscribers
      end

    {:noreply, %{state | subscribers: subscribers}}
  end

  defp load_source({:log, %Log{} = log}), do: {:ok, log}

  defp load_source({:path, path}) when is_binary(path) do
    with :ok <- preload_lattice_core(), do: Log.restore(path)
  end

  defp load_source(_source), do: {:error, :invalid_source}

  defp persist_relay(log, report, %{log: log} = state) do
    {:reply, {:ok, report}, state}
  end

  defp persist_relay(log, report, %{source: {:path, path}} = state) do
    case atomic_dump(log, path) do
      :ok ->
        availability = availability(log)
        subscribers = notify_subscribers(state.subscribers, availability)
        state = %{state | log: log, subscribers: subscribers}
        {:reply, {:ok, report}, state}

      {:error, reason} ->
        {:reply, {:error, {:persistence_failed, reason}}, state}
    end
  end

  defp atomic_dump(log, path) do
    suffix = System.unique_integer([:monotonic, :positive])
    temp_path = "#{path}.tmp.#{suffix}"

    result =
      with :ok <- Log.dump(log, temp_path),
           :ok <- File.rename(temp_path, path) do
        :ok
      end

    _ = File.rm(temp_path)
    result
  end

  defp availability(log) do
    frontier = log |> Log.frontier() |> Enum.sort()

    %{
      generation: Log.size(log) + length(Log.quarantine(log)),
      frontier: Enum.take(frontier, @frontier_limit),
      frontier_truncated: length(frontier) > @frontier_limit
    }
  end

  defp notify_subscribers(subscribers, availability) do
    holder = self()

    Map.new(subscribers, fn
      {subscriber, %{outstanding_generation: nil} = entry} ->
        send(subscriber, {:lattice_carrier_ops_available, holder, availability})
        {subscriber, %{entry | outstanding_generation: availability.generation}}

      subscriber_entry ->
        subscriber_entry
    end)
  end

  defp preload_lattice_core do
    :lattice_core
    |> Application.spec(:modules)
    |> List.wrap()
    |> Enum.reduce_while(:ok, fn module, :ok ->
      case Code.ensure_loaded(module) do
        {:module, ^module} -> {:cont, :ok}
        {:error, reason} -> {:halt, {:error, {:module_load_failed, module, reason}}}
      end
    end)
  end
end
