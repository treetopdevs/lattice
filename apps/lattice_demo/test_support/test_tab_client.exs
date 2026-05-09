defmodule LatticeDemo.TestTabClient do
  @moduledoc false

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

  def call(pid, cap_or_id, payload), do: GenServer.call(pid, {:origin_call, cap_or_id, payload})

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
       tab: nil,
       identity: Keyword.get(opts, :identity, %{}),
       handlers: Map.new(Keyword.get(opts, :handlers, []))
     }}
  end

  @impl true
  def handle_call(:connect, _from, state) do
    {:ok, tab} =
      Lattice.connect_tab(%{
        transport: __MODULE__,
        connection_pid: self(),
        identity: state.identity,
        metadata: %{}
      })

    {:reply, {:ok, tab}, %{state | tab: tab}}
  end

  def handle_call({:origin_call, cap_or_id, payload}, _from, state) do
    {:reply, Lattice.call(state.tab.id, cap_or_id, payload), state}
  end

  def handle_call({:deliver_call, envelope}, _from, state) do
    payload = Map.get(envelope, :payload, %{})
    op = payload_op(payload)

    result =
      case Map.get(state.handlers, op) do
        nil -> {:ok, %{tab_id: state.tab.id, received: payload}}
        fun -> {:ok, fun.(payload)}
      end

    {:reply, result, state}
  end

  @impl true
  def handle_cast({:deliver_cast, _envelope}, state), do: {:noreply, state}

  defp payload_op(%{op: op}) when is_atom(op), do: op
  defp payload_op(%{op: op}) when is_binary(op), do: String.to_atom(op)
  defp payload_op(%{"op" => op}) when is_binary(op), do: String.to_atom(op)
  defp payload_op(_), do: :default
end
