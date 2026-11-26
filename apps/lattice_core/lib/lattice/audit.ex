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

  @doc """
  Records an event, or reports `{:error, :unavailable}` when Audit is not there.

  This is for projection-side writers that keep their own copy of every event
  and replay it later (for example `Lattice.LiveOps`, row 310). It returns
  `{:error, :unavailable}` without calling when no `Lattice.Audit` process is
  registered, and when the call exits because the process is gone or stopping
  (`:noproc`, `:normal`, `:shutdown`, `{:shutdown, _}`, `:killed`). Any other
  exit, including `{:timeout, _}` from a stalled Audit, is re-raised unchanged.

  `record/2` stays loud for every other caller: it still exits when Audit is
  down.
  """
  def try_record(type, metadata \\ %{}) when is_atom(type) and is_map(metadata) do
    if Process.whereis(__MODULE__) do
      {:ok, GenServer.call(__MODULE__, {:record, type, metadata})}
    else
      {:error, :unavailable}
    end
  catch
    :exit, reason ->
      if unavailable_exit?(reason) do
        {:error, :unavailable}
      else
        :erlang.raise(:exit, reason, __STACKTRACE__)
      end
  end

  defp unavailable_exit?({reason, {GenServer, :call, _args}}), do: unavailable_reason?(reason)
  defp unavailable_exit?(reason), do: unavailable_reason?(reason)

  defp unavailable_reason?(:noproc), do: true
  defp unavailable_reason?({:noproc, _}), do: true
  defp unavailable_reason?(:normal), do: true
  defp unavailable_reason?(:shutdown), do: true
  defp unavailable_reason?({:shutdown, _}), do: true
  defp unavailable_reason?(:killed), do: true
  defp unavailable_reason?(_reason), do: false

  def events do
    GenServer.call(__MODULE__, :events)
  end

  @doc """
  Returns the number of recorded events, counted inside the Audit process.

  This is a projection counter for UI snapshots (LiveOps, DemoHub), not
  evidence. It returns `0` when Audit is not running (for example mid-restart)
  or exits during the call, so those cases do not crash the snapshot's caller.
  It does not protect against a stalled Audit: the inner call then hits its
  5 s timeout, which is the same deadline as the caller's own outer call.
  Evidence readers must use `events/0`, which still fails loudly when Audit is
  down.
  """
  def count do
    GenServer.call(__MODULE__, :count)
  catch
    :exit, _reason -> 0
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

  def handle_call(:count, _from, events), do: {:reply, length(events), events}

  def handle_call(:reset, _from, _events), do: {:reply, :ok, []}
end
