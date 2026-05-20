defmodule LatticeServer.ResumeProxy do
  @moduledoc """
  Per-browser-client replay buffer for transient WebSocket reconnects.

  Proxies are keyed by browser-generated `client_id`, not by Lattice tab id. The
  Lattice tab lifecycle still revokes authority on disconnect; this process only
  buffers idempotent demo stream frames for a short reconnect window.
  """

  use GenServer

  @registry LatticeServer.ResumeProxyRegistry
  @supervisor LatticeServer.ResumeProxySupervisor
  @default_buffer_size 64
  @default_ttl_ms 15_000

  def start_link(opts) do
    client_id = Keyword.fetch!(opts, :client_id)
    GenServer.start_link(__MODULE__, opts, name: via(client_id))
  end

  def attach(client_id, connection_pid, opts \\ [])
      when is_binary(client_id) and is_pid(connection_pid) do
    with {:ok, pid} <- get_or_start(client_id, opts) do
      GenServer.call(pid, {:attach, connection_pid, opts})
    end
  end

  def detach(nil, _connection_pid), do: :ok

  def detach(client_id, connection_pid) when is_binary(client_id) and is_pid(connection_pid) do
    case lookup(client_id) do
      {:ok, pid} -> GenServer.cast(pid, {:detach, connection_pid})
      :error -> :ok
    end
  end

  def push(client_id, frame) when is_binary(client_id) and is_map(frame) do
    case lookup(client_id) do
      {:ok, pid} -> GenServer.call(pid, {:push, frame})
      :error -> {:error, :not_found}
    end
  end

  def push(nil, _frame), do: {:error, :missing_client_id}

  def push_disconnected(frame, excluded_client_ids \\ MapSet.new()) when is_map(frame) do
    excluded_client_ids = MapSet.new(excluded_client_ids)

    @registry
    |> Registry.select([{{:"$1", :"$2", :"$3"}, [], [{{:"$1", :"$2"}}]}])
    |> Enum.each(fn {client_id, pid} ->
      unless MapSet.member?(excluded_client_ids, client_id) do
        GenServer.cast(pid, {:push_if_disconnected, frame})
      end
    end)

    :ok
  end

  def resume(client_id, from_seq) when is_binary(client_id) and is_integer(from_seq) do
    case lookup(client_id) do
      {:ok, pid} -> GenServer.call(pid, {:resume, from_seq})
      :error -> {:error, :not_found}
    end
  end

  def reset_all! do
    @registry
    |> Registry.select([{{:"$1", :"$2", :"$3"}, [], [:"$2"]}])
    |> Enum.each(&DynamicSupervisor.terminate_child(@supervisor, &1))

    :ok
  end

  @impl true
  def init(opts) do
    {:ok,
     %{
       client_id: Keyword.fetch!(opts, :client_id),
       connection_pid: nil,
       ttl_ref: nil,
       ttl_ms: Keyword.get(opts, :ttl_ms, @default_ttl_ms),
       buffer_size: Keyword.get(opts, :buffer_size, @default_buffer_size),
       seq: 0,
       buffer: []
     }}
  end

  @impl true
  def handle_call({:attach, connection_pid, opts}, _from, state) do
    state =
      state
      |> cancel_ttl()
      |> Map.merge(%{
        connection_pid: connection_pid,
        ttl_ms: Keyword.get(opts, :ttl_ms, state.ttl_ms),
        buffer_size: Keyword.get(opts, :buffer_size, state.buffer_size)
      })

    {:reply, {:ok, %{client_id: state.client_id, seq: state.seq}}, state}
  end

  def handle_call({:push, frame}, _from, state) do
    {sequenced, state} = push_frame(frame, state)
    {:reply, {:ok, sequenced}, state}
  end

  def handle_call({:resume, from_seq}, _from, state) do
    reply =
      case missed_frames(state, from_seq) do
        :out_of_window -> {:error, :out_of_window, state.seq}
        frames -> {:ok, frames, state.seq}
      end

    {:reply, reply, state}
  end

  @impl true
  def handle_cast({:detach, connection_pid}, state) do
    state =
      if state.connection_pid == connection_pid do
        state
        |> Map.put(:connection_pid, nil)
        |> schedule_ttl()
      else
        state
      end

    {:noreply, state}
  end

  def handle_cast({:push_if_disconnected, frame}, %{connection_pid: nil} = state) do
    {_sequenced, state} = push_frame(frame, state)
    {:noreply, state}
  end

  def handle_cast({:push_if_disconnected, _frame}, state), do: {:noreply, state}

  @impl true
  def handle_info(:expire, %{connection_pid: nil} = state), do: {:stop, :normal, state}
  def handle_info(:expire, state), do: {:noreply, %{state | ttl_ref: nil}}

  defp get_or_start(client_id, opts) do
    child_opts =
      opts
      |> Keyword.take([:ttl_ms, :buffer_size])
      |> Keyword.put(:client_id, client_id)

    case DynamicSupervisor.start_child(@supervisor, {__MODULE__, child_opts}) do
      {:ok, pid} -> {:ok, pid}
      {:error, {:already_started, pid}} -> {:ok, pid}
      {:error, reason} -> {:error, reason}
    end
  end

  defp lookup(client_id) do
    case Registry.lookup(@registry, client_id) do
      [{pid, _value}] -> {:ok, pid}
      [] -> :error
    end
  end

  defp via(client_id), do: {:via, Registry, {@registry, client_id}}

  defp push_frame(frame, state) do
    seq = state.seq + 1
    sequenced = Map.put(frame, :seq, seq)
    buffer = [{seq, sequenced} | state.buffer] |> Enum.take(state.buffer_size)
    {sequenced, %{state | seq: seq, buffer: buffer}}
  end

  defp missed_frames(%{seq: seq}, from_seq) when from_seq > seq, do: :out_of_window
  defp missed_frames(%{seq: seq}, from_seq) when from_seq == seq, do: []

  defp missed_frames(%{buffer: []}, 0), do: []
  defp missed_frames(%{buffer: []}, _from_seq), do: :out_of_window

  defp missed_frames(%{buffer: buffer}, from_seq) do
    oldest_seq = buffer |> List.last() |> elem(0)

    if from_seq < oldest_seq - 1 do
      :out_of_window
    else
      buffer
      |> Enum.reverse()
      |> Enum.filter(fn {seq, _frame} -> seq > from_seq end)
      |> Enum.map(fn {_seq, frame} -> frame end)
    end
  end

  defp cancel_ttl(%{ttl_ref: nil} = state), do: state

  defp cancel_ttl(%{ttl_ref: ref} = state) do
    Process.cancel_timer(ref)
    %{state | ttl_ref: nil}
  end

  defp schedule_ttl(state) do
    state = cancel_ttl(state)
    %{state | ttl_ref: Process.send_after(self(), :expire, state.ttl_ms)}
  end
end
