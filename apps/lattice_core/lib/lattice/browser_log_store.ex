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
      "quarantine" => []
    }
  end

  @spec restore_payload(map()) :: {:ok, Log.t()} | {:error, :malformed_store | :malformed_op}
  def restore_payload(%{"schema" => @schema, "replica" => replica, "ops" => encoded})
      when is_binary(replica) and is_list(encoded) do
    with {:ok, ops} <- Wire.decode_ops(encoded) do
      {log, _report} = Lattice.Sync.deliver(Log.new(replica), ops)
      {:ok, log}
    end
  end

  def restore_payload(_), do: {:error, :malformed_store}
end
