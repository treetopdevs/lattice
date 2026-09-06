defmodule Treehouse.CatalogCutoff do
  @moduledoc """
  Exact authenticated recovery-cutoff bytes, including retained rejected evidence.

  This read-only observation proves integrity of the supplied complete log. It
  neither establishes semantic authority nor proves absence of withheld history.
  Unsupported evidence refuses the observation instead of disappearing from it.
  """

  alias Lattice.{Canonical, Log, Op}
  alias Lattice.Carrier.Wire

  @spec derive(term()) ::
          {:ok, map()} | {:error, :invalid_verified_history | :unsupported_cutoff}
  def derive(log) do
    case Log.verify_authenticity(log) do
      :ok -> derive_verified(log)
      {:error, _} -> {:error, :invalid_verified_history}
    end
  end

  defp derive_verified(log) do
    accepted = log |> Log.ops() |> Map.values() |> Enum.sort_by(& &1.id)
    rejected = log |> Log.quarantine() |> Enum.sort_by(& &1.op.id)

    if Enum.all?(accepted, &portable?/1) and
         Enum.all?(rejected, &portable?(&1.op)) do
      ops = Enum.map(accepted, &record/1)
      rejected = Enum.map(rejected, &Map.put(record(&1.op), :reason, :bad_signature))
      bytes = Canonical.term(["lattice-treehouse-recovery-cutoff-v1", log.replica, ops, rejected])

      {:ok,
       %{
         cutoff: %{
           replica: log.replica,
           frontier: Log.frontier(log),
           log_digest: :crypto.hash(:sha256, bytes) |> Base.url_encode64(padding: false)
         },
         canonical_bytes: bytes,
         ops: ops,
         rejected: rejected
       }}
    else
      {:error, :unsupported_cutoff}
    end
  rescue
    _ -> {:error, :unsupported_cutoff}
  end

  defp record(%Op{} = op),
    do: %{id: op.id, bytes: Canonical.op_payload(op), sig: op.sig}

  defp portable?(%Op{} = op) do
    # Round-trip the ordinary JSON/header/term representation without interpreting
    # a rejected op's supplied ID or signature as authenticated identity slots.
    with {:ok, encoded} <- Jason.encode(Wire.encode_op(op)),
         {:ok, frame} <- Jason.decode(encoded),
         {:ok, ^op} <- Wire.decode_op(frame) do
      true
    else
      _ -> false
    end
  end
end
