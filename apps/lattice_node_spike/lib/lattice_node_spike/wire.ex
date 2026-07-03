defmodule LatticeNodeSpike.Wire do
  @moduledoc """
  Op wire format for the spike: Base64 of `:erlang.term_to_binary/2` with the
  same pinned options as `Lattice.Op.canonical_encoding/1`.

  The receiver decodes with `:safe` (no atom/resource creation from the wire)
  and accepts only a well-formed `%Lattice.Op{}` — every other term is
  `{:error, :malformed_op}`. Integrity is *not* decided here: a syntactically
  valid but tampered op decodes fine and is then quarantined by
  `Lattice.Log.accept/2`'s signature check, which is exactly the property the
  spike must demonstrate surviving the real carrier.

  This encoding is BEAM-specific by design (ADR 0001); a non-BEAM realm (the
  AtomVM/JS browser path) makes canonical CBOR a hard prerequisite (ADR 0005).
  """

  alias Lattice.Op

  @spec encode(Op.t()) :: String.t()
  def encode(%Op{} = op) do
    op
    |> :erlang.term_to_binary([:deterministic, {:minor_version, 2}])
    |> Base.encode64()
  end

  @spec decode(term()) :: {:ok, Op.t()} | {:error, :malformed_op}
  def decode(b64) when is_binary(b64) do
    with {:ok, bin} <- Base.decode64(b64),
         {:ok, %Op{} = op} <- safe_term(bin) do
      {:ok, op}
    else
      _ -> {:error, :malformed_op}
    end
  end

  def decode(_other), do: {:error, :malformed_op}

  @spec decode_all([term()]) :: {:ok, [Op.t()]} | {:error, :malformed_op}
  def decode_all(list) when is_list(list) do
    list
    |> Enum.reduce_while([], fn encoded, acc ->
      case decode(encoded) do
        {:ok, op} -> {:cont, [op | acc]}
        {:error, _} = err -> {:halt, err}
      end
    end)
    |> case do
      {:error, _} = err -> err
      ops -> {:ok, Enum.reverse(ops)}
    end
  end

  def decode_all(_other), do: {:error, :malformed_op}

  defp safe_term(bin) do
    {:ok, :erlang.binary_to_term(bin, [:safe])}
  rescue
    _ -> {:error, :malformed_op}
  end
end
