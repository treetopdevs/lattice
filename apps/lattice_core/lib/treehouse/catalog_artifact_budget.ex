defmodule Treehouse.CatalogArtifactBudget do
  @moduledoc """
  CatalogTrust's retained-artifact budgets for an authoring preflight (rows 355, 525).

  `Treehouse.CatalogTrust` refuses retained evidence as `control_history_limit` when it holds
  more than `max_artifacts/0` artifacts, when one artifact's JSON is over
  `max_artifact_bytes/0`, or when the artifacts' JSON totals more than `max_total_bytes/0`.
  These limits mirror CatalogTrust's private ones. A test pins the per-artifact limit against
  the verifier's JSON decoders; the count and total stay private there, so nothing pins them.

  `artifact_json_bytes/1` measures an envelope as compact JSON of its carrier term, which is
  the length the operator distribution (`PublicHistory.canonical`) emits. It is a lower bound:
  a verifier that receives the same artifact padded with whitespace measures more, so passing
  this check does not prove a distributor's copy fits (non-claim).
  """

  alias Lattice.Carrier.Wire
  alias Treehouse.TransportCatalog

  @max_artifacts 1_024
  @max_artifact_bytes 131_072
  @max_total_bytes 16 * 1_024 * 1_024

  @spec max_artifacts() :: pos_integer()
  def max_artifacts, do: @max_artifacts

  @spec max_artifact_bytes() :: pos_integer()
  def max_artifact_bytes, do: @max_artifact_bytes

  @spec max_total_bytes() :: pos_integer()
  def max_total_bytes, do: @max_total_bytes

  @doc """
  Compact JSON length of a catalog or rotation envelope's carrier term.

  An envelope that does not normalize as a catalog or rotation envelope, or that normalizes but
  holds a value the wire codec refuses (a float version such as `1.0`, which the normalizer's
  `==` admits), measures one byte over the per-artifact limit, so `check/1` fails closed on it
  (the TS twin's codec does the same).
  """
  @spec artifact_json_bytes(term()) :: non_neg_integer()
  def artifact_json_bytes(envelope) do
    case normalize(envelope) do
      {:ok, normalized} -> encoded_bytes(normalized)
      :error -> @max_artifact_bytes + 1
    end
  end

  defp encoded_bytes(normalized) do
    normalized |> Wire.encode_value() |> Jason.encode!() |> byte_size()
  rescue
    _error in [ArgumentError, Jason.EncodeError] -> @max_artifact_bytes + 1
  end

  @doc """
  Refuses a size list CatalogTrust would refuse: count, per-artifact or total.

  Every size must be a non-negative integer and the list must be proper; anything else fails
  closed. The walk stops at the first size over the per-artifact limit or once the running
  total passes the total limit.
  """
  @spec check(term()) :: :ok | {:error, :control_history_limit}
  def check(sizes) do
    if within_count?(sizes, 0), do: total(sizes, 0), else: {:error, :control_history_limit}
  end

  @doc """
  Measures envelopes lazily and checks them as `check/1` would, stopping at the first refusal
  so an oversized history is not serialized in full. A non-list or improper list fails closed.
  """
  @spec check_envelopes(term()) :: :ok | {:error, :control_history_limit}
  def check_envelopes(envelopes) do
    if within_count?(envelopes, 0),
      do: envelopes |> Stream.map(&artifact_json_bytes/1) |> total(0),
      else: {:error, :control_history_limit}
  end

  # A proper list of at most @max_artifacts elements; stops walking once the count is exceeded.
  defp within_count?([], _count), do: true
  defp within_count?([_ | _], count) when count >= @max_artifacts, do: false
  defp within_count?([_ | rest], count), do: within_count?(rest, count + 1)
  defp within_count?(_improper, _count), do: false

  defp total(sizes, sum) do
    Enum.reduce_while(sizes, {:ok, sum}, fn
      size, {:ok, acc}
      when is_integer(size) and size >= 0 and size <= @max_artifact_bytes and
             acc + size <= @max_total_bytes ->
        {:cont, {:ok, acc + size}}

      _size, _acc ->
        {:halt, {:error, :control_history_limit}}
    end)
    |> case do
      {:ok, _sum} -> :ok
      error -> error
    end
  end

  defp normalize(%{catalog: catalog, signature: signature} = envelope)
       when map_size(envelope) == 2 do
    with true <- signature?(signature),
         {:ok, normalized} <- TransportCatalog.normalize_catalog(catalog) do
      {:ok, %{catalog: normalized, signature: signature}}
    else
      _ -> :error
    end
  end

  defp normalize(%{rotation: rotation, old_signature: old, new_signature: new} = envelope)
       when map_size(envelope) == 3 do
    with true <- signature?(old) and signature?(new),
         {:ok, normalized} <- TransportCatalog.normalize_rotation(rotation) do
      {:ok, %{rotation: normalized, old_signature: old, new_signature: new}}
    else
      _ -> :error
    end
  end

  defp normalize(_envelope), do: :error

  defp signature?(value), do: is_binary(value) and byte_size(value) == 64
end
