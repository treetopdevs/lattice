defmodule LatticeCarrierSpike.EchoTarget do
  @moduledoc false

  use GenServer

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts)
  end

  def stats(pid), do: GenServer.call(pid, :stats)

  @impl true
  def init(opts) do
    {:ok, %{owner: Keyword.fetch!(opts, :owner), call_count: 0, calls: []}}
  end

  @impl true
  def handle_call({:lattice_call, envelope}, _from, state) do
    send(state.owner, {:carrier_target_call, envelope})

    reply = %{
      "echo" => envelope.payload,
      "from_tab_id" => envelope.from_tab_id,
      "cap_id" => envelope.cap_id
    }

    {:reply, {:ok, reply},
     %{state | call_count: state.call_count + 1, calls: [envelope | state.calls]}}
  end

  def handle_call(:stats, _from, state) do
    {:reply, %{call_count: state.call_count, calls: Enum.reverse(state.calls)}, state}
  end
end
