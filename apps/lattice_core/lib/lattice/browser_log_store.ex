defmodule Lattice.BrowserLogStore do
  @moduledoc "JSON-safe dump/restore payloads for browser-held Replica logs."

  alias Lattice.{Carrier.Wire, Log}

  @schema "lattice-browser-log-v1"

  @spec dump_payload(Log.t()) :: map()
  def dump_payload(%Log{} = log) do
    %{
      "schema" => @schema,
      "replica" => log.replica,
      "ops" => log |> Log.topo_ops() |> Enum.map(&Wire.encode_op/1),
      "quarantine" => Enum.map(Log.quarantine(log), &encode_quarantine_entry/1)
    }
  end

  @spec restore_payload(map()) ::
          {:ok, Log.t()}
          | {:error, :malformed_store | :malformed_op | {:restore_report, Lattice.Sync.report()}}
  def restore_payload(%{
        "schema" => @schema,
        "replica" => replica,
        "ops" => encoded,
        "quarantine" => quarantine
      })
      when is_binary(replica) and is_list(encoded) and is_list(quarantine) do
    with {:ok, ops} <- Wire.decode_ops(encoded),
         {:ok, log} <- restore_accepted(replica, ops),
         {:ok, quarantine} <- decode_quarantine(quarantine),
         {:ok, log} <- restore_quarantine(log, quarantine) do
      {:ok, log}
    end
  end

  def restore_payload(%{"schema" => @schema, "replica" => replica, "ops" => encoded})
      when is_binary(replica) and is_list(encoded) do
    restore_payload(%{
      "schema" => @schema,
      "replica" => replica,
      "ops" => encoded,
      "quarantine" => []
    })
  end

  def restore_payload(_), do: {:error, :malformed_store}

  defp encode_quarantine_entry(%{op: op, reason: reason}) do
    %{"op" => Wire.encode_op(op), "reason" => Atom.to_string(reason)}
  end

  defp restore_accepted(replica, ops) do
    {log, report} = Lattice.Sync.deliver(Log.new(replica), ops)

    if clean_restore_report?(report) do
      {:ok, log}
    else
      {:error, {:restore_report, report}}
    end
  end

  defp clean_restore_report?(report) do
    report.quarantined == [] and report.rejected == [] and report.pending == []
  end

  defp decode_quarantine(entries) do
    Enum.reduce_while(entries, {:ok, []}, fn
      %{"op" => encoded_op, "reason" => reason}, {:ok, acc} when is_binary(reason) ->
        with {:ok, op} <- Wire.decode_op(encoded_op),
             {:ok, reason} <- existing_atom(reason) do
          {:cont, {:ok, [%{op: op, reason: reason} | acc]}}
        else
          {:error, :malformed_op} -> {:halt, {:error, :malformed_op}}
          _other -> {:halt, {:error, :malformed_store}}
        end

      _other, _acc ->
        {:halt, {:error, :malformed_store}}
    end)
    |> case do
      {:ok, entries} -> {:ok, Enum.reverse(entries)}
      {:error, _reason} = error -> error
    end
  end

  defp restore_quarantine(%Log{} = log, entries) do
    if Enum.all?(entries, &quarantine_reason_matches?/1) do
      {:ok, %{log | quarantine: Enum.reverse(entries)}}
    else
      {:error, :malformed_store}
    end
  end

  defp quarantine_reason_matches?(%{op: op, reason: :bad_signature}),
    do: not Lattice.Op.valid?(op)

  defp quarantine_reason_matches?(_entry), do: false

  defp existing_atom(value) when is_binary(value) do
    {:ok, String.to_existing_atom(value)}
  rescue
    ArgumentError -> {:error, :unknown_atom}
  end
end
