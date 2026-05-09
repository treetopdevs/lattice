defmodule LatticeStress.Barrier do
  @moduledoc """
  Small deterministic barrier used by race tests.

  A process that calls `wait/2` blocks until the test process calls
  `release/1`. Tests can wait until a specific number of participants are
  blocked before committing a revoke, disconnect, or eject.
  """

  use GenServer

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts)
  end

  def wait(pid, timeout \\ 5_000), do: GenServer.call(pid, :wait, timeout)
  def release(pid), do: GenServer.call(pid, :release)
  def waiting_count(pid), do: GenServer.call(pid, :waiting_count)

  def await_waiting(pid, count, timeout \\ 1_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_await_waiting(pid, count, deadline)
  end

  @impl true
  def init(_opts), do: {:ok, %{released?: false, waiters: []}}

  @impl true
  def handle_call(:wait, from, %{released?: false} = state) do
    {:noreply, %{state | waiters: [from | state.waiters]}}
  end

  def handle_call(:wait, _from, %{released?: true} = state), do: {:reply, :ok, state}

  def handle_call(:release, _from, state) do
    Enum.each(state.waiters, &GenServer.reply(&1, :ok))
    {:reply, :ok, %{state | released?: true, waiters: []}}
  end

  def handle_call(:waiting_count, _from, state), do: {:reply, length(state.waiters), state}

  defp do_await_waiting(pid, count, deadline) do
    cond do
      waiting_count(pid) >= count ->
        :ok

      System.monotonic_time(:millisecond) >= deadline ->
        {:error, {:timeout, waiting_count(pid)}}

      true ->
        Process.sleep(5)
        do_await_waiting(pid, count, deadline)
    end
  end
end
