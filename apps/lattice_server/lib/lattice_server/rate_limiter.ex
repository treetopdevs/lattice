defmodule LatticeServer.RateLimiter do
  @moduledoc false

  use GenServer

  @default_limit 120
  @default_window_ms 10_000

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def allow?(key, opts \\ []) do
    limit = Keyword.get(opts, :limit, @default_limit)
    window_ms = Keyword.get(opts, :window_ms, @default_window_ms)
    now = System.monotonic_time(:millisecond)

    case GenServer.whereis(__MODULE__) do
      nil -> true
      _pid -> GenServer.call(__MODULE__, {:allow?, key, limit, window_ms, now})
    end
  end

  @impl true
  def init(_opts), do: {:ok, %{}}

  @impl true
  def handle_call({:allow?, key, limit, window_ms, now}, _from, state) do
    {allowed?, next_state} =
      case Map.get(state, key) do
        {started_at, count} when now - started_at < window_ms and count >= limit ->
          {false, state}

        {started_at, count} when now - started_at < window_ms ->
          {true, Map.put(state, key, {started_at, count + 1})}

        _old_or_missing ->
          {true, Map.put(state, key, {now, 1})}
      end

    {:reply, allowed?, prune(next_state, now - window_ms * 2)}
  end

  defp prune(state, prune_before) do
    Map.reject(state, fn {_key, {started_at, _count}} -> started_at < prune_before end)
  end
end
