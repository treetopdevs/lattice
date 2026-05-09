defmodule Lattice.Demo.TabWorker do
  @moduledoc """
  Tab-attached worker used to prove lifecycle cleanup.
  """

  use GenServer

  def start_link(tab_id, args \\ [], opts \\ []) do
    GenServer.start_link(__MODULE__, {tab_id, args, opts})
  end

  def ping(pid), do: GenServer.call(pid, :ping)
  def tab_id(pid), do: GenServer.call(pid, :tab_id)

  @impl true
  def init({tab_id, args, opts}) do
    Process.flag(:trap_exit, true)
    {:ok, %{tab_id: tab_id, args: args, opts: opts}}
  end

  @impl true
  def handle_call(:ping, _from, state), do: {:reply, {:pong, state.tab_id}, state}
  def handle_call(:tab_id, _from, state), do: {:reply, state.tab_id, state}
end
