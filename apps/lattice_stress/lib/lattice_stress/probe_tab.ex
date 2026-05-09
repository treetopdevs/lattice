defmodule LatticeStress.ProbeTab do
  @moduledoc """
  Deterministic tab realm used by the stress lab.

  It is a real `Lattice.Transport` implementation, but it exists only in the
  stress application. Tests use it to prove whether tab-side delivery happened.
  """

  use GenServer

  @behaviour Lattice.Transport

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts)
  end

  def connect(opts \\ []) do
    with {:ok, pid} <- start_link(opts),
         {:ok, tab} <- GenServer.call(pid, :connect) do
      {:ok, pid, tab}
    end
  end

  def messages(pid), do: GenServer.call(pid, :messages)
  def delivered_count(pid), do: GenServer.call(pid, :delivered_count)
  def clear(pid), do: GenServer.call(pid, :clear)
  def call(pid, cap_or_id, payload), do: GenServer.call(pid, {:origin_call, cap_or_id, payload})
  def cast(pid, cap_or_id, payload), do: GenServer.call(pid, {:origin_cast, cap_or_id, payload})
  def crash(pid), do: GenServer.stop(pid, :killed_by_stress)

  @impl Lattice.Transport
  def deliver_call(connection_pid, envelope, timeout) do
    GenServer.call(connection_pid, {:deliver_call, envelope}, timeout)
  end

  @impl Lattice.Transport
  def deliver_cast(connection_pid, envelope) do
    GenServer.cast(connection_pid, {:deliver_cast, envelope})
  end

  @impl true
  def init(opts) do
    {:ok,
     %{
       owner: Keyword.get(opts, :owner),
       tab: nil,
       identity: Keyword.get(opts, :identity, %{}),
       metadata: Keyword.get(opts, :metadata, %{}),
       handlers: Map.new(Keyword.get(opts, :handlers, [])),
       barrier: Keyword.get(opts, :barrier),
       inbox: []
     }}
  end

  @impl true
  def handle_call(:connect, _from, state) do
    attrs = %{
      transport: __MODULE__,
      connection_pid: self(),
      identity: state.identity,
      metadata: state.metadata
    }

    {:ok, tab} = Lattice.connect_tab(attrs)
    {:reply, {:ok, tab}, %{state | tab: tab}}
  end

  def handle_call(:messages, _from, state), do: {:reply, Enum.reverse(state.inbox), state}
  def handle_call(:delivered_count, _from, state), do: {:reply, length(state.inbox), state}
  def handle_call(:clear, _from, state), do: {:reply, :ok, %{state | inbox: []}}

  def handle_call({:origin_call, cap_or_id, payload}, _from, state) do
    {:reply, Lattice.call(state.tab.id, cap_or_id, payload), state}
  end

  def handle_call({:origin_cast, cap_or_id, payload}, _from, state) do
    {:reply, Lattice.cast(state.tab.id, cap_or_id, payload), state}
  end

  def handle_call({:deliver_call, envelope}, _from, state) do
    maybe_notify(state.owner, {:probe_tab_call_started, state.tab.id, envelope})
    maybe_wait(state.barrier)
    payload = Map.get(envelope, :payload, %{})
    op = payload_op(payload)

    result =
      case Map.get(state.handlers, op) do
        nil -> {:ok, %{tab_id: state.tab.id, received: payload}}
        fun -> normalize_reply(fun.(payload))
      end

    maybe_notify(state.owner, {:probe_tab_call_delivered, state.tab.id, envelope})
    {:reply, result, %{state | inbox: [{:call, envelope} | state.inbox]}}
  end

  @impl true
  def handle_cast({:deliver_cast, envelope}, state) do
    maybe_notify(state.owner, {:probe_tab_cast_delivered, state.tab.id, envelope})
    {:noreply, %{state | inbox: [{:cast, envelope} | state.inbox]}}
  end

  defp maybe_wait(nil), do: :ok
  defp maybe_wait(barrier), do: LatticeStress.Barrier.wait(barrier)

  defp payload_op(%{op: op}), do: op_key(op)
  defp payload_op(%{"op" => op}), do: op_key(op)
  defp payload_op(_payload), do: :default

  defp op_key(op) when is_binary(op), do: String.to_atom(op)
  defp op_key(op) when is_atom(op), do: op

  defp normalize_reply({:ok, _} = ok), do: ok
  defp normalize_reply({:error, _} = error), do: error
  defp normalize_reply(other), do: {:ok, other}

  defp maybe_notify(nil, _message), do: :ok
  defp maybe_notify(owner, message), do: send(owner, message)
end
