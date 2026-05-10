defmodule Lattice.Causality do
  @moduledoc """
  Capability-attested causality prototype.

  Each event commits to the prior hash, the capability id, and the event body.
  This is an executable sketch of causality carrying authority provenance, not
  durable distributed consensus.
  """

  alias Lattice.Cap

  def new(%Cap{} = cap, label) do
    root = hash({:root, cap.id, cap.root_id, label})
    %{root: root, last_hash: root, label: label, events: []}
  end

  def attest(trace, %Cap{} = cap, event) when is_map(trace) do
    entry = %{
      index: length(trace.events) + 1,
      cap_id: cap.id,
      root_id: cap.root_id,
      parent_id: cap.parent_id,
      event: event,
      previous_hash: trace.last_hash
    }

    entry = Map.put(entry, :hash, hash(entry))
    %{trace | last_hash: entry.hash, events: trace.events ++ [entry]}
  end

  def verify(%{root: root, events: events}) do
    events
    |> Enum.reduce_while({:ok, root}, fn event, {:ok, previous_hash} ->
      expected = hash(Map.delete(event, :hash))

      cond do
        event.previous_hash != previous_hash ->
          {:halt, {:error, {:broken_previous_hash, event.index}}}

        event.hash != expected ->
          {:halt, {:error, {:invalid_event_hash, event.index}}}

        true ->
          {:cont, {:ok, event.hash}}
      end
    end)
    |> case do
      {:ok, _last_hash} -> :ok
      {:error, _reason} = error -> error
    end
  end

  defp hash(term) do
    :crypto.hash(:sha256, :erlang.term_to_binary(term))
    |> Base.url_encode64(padding: false)
  end
end
