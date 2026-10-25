defmodule LatticeCarrierServer.Operator.PublicHistory do
  @moduledoc """
  Canonical public JSON and authenticated frame histories for operator evidence.

  Callers own their closed envelope, product/profile and resource policies. This
  decoder verifies complete signed histories; it grants no authority or trust.
  """
  alias Lattice.{Log, Op}
  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.Operator.CatalogCeremony.Atoms

  @frame_keys ~w(author body cap deps id kind replica sig v)
  @max_frames 4000

  @spec decode(term(), term(), keyword()) :: {:ok, Log.t()} | {:error, :invalid_public_history}
  def decode(replica, frames, opts \\ [])

  def decode(replica, frames, opts)
      when is_binary(replica) and is_list(frames) and length(frames) in 1..@max_frames do
    Atoms.load()

    with {:ok, ops} <- decode_frames(replica, frames, Keyword.get(opts, :push_bytes)),
         ids = Enum.map(ops, & &1.id),
         true <- ids == Enum.sort(ids) and ids == Enum.uniq(ids),
         log = Log.from_ops(replica, Map.new(ops, &{&1.id, &1})),
         :ok <- Log.verify_authenticity(log) do
      {:ok, log}
    else
      _ -> {:error, :invalid_public_history}
    end
  rescue
    _ -> {:error, :invalid_public_history}
  catch
    _, _ -> {:error, :invalid_public_history}
  end

  def decode(_, _, _), do: {:error, :invalid_public_history}

  defp decode_frames(replica, frames, push_bytes) do
    Enum.reduce_while(frames, {:ok, []}, fn frame, {:ok, acc} ->
      with true <- is_map(frame) and Enum.sort(Map.keys(frame)) == @frame_keys,
           true <- fits?(frame, push_bytes),
           {:ok, %Op{replica: ^replica} = op} <- Wire.decode_op(frame),
           true <- Wire.encode_op(op) == frame do
        {:cont, {:ok, [op | acc]}}
      else
        _ -> {:halt, :error}
      end
    end)
    |> case do
      {:ok, reversed} -> {:ok, Enum.reverse(reversed)}
      _ -> :error
    end
  end

  defp fits?(_frame, nil), do: true

  defp fits?(frame, cap) when is_integer(cap) and cap > 0,
    do: byte_size(canonical(%{"type" => "push", "ops" => [frame]})) <= cap

  defp fits?(_, _), do: false

  @spec frames(Log.t()) :: [map()]
  def frames(%Log{ops: ops}),
    do: ops |> Map.values() |> Enum.sort_by(& &1.id) |> Enum.map(&Wire.encode_op/1)

  @doc "Compact JSON with recursively sorted object keys."
  @spec canonical(term()) :: binary()
  def canonical(map) when is_map(map) do
    "{" <>
      (map
       |> Enum.sort_by(&elem(&1, 0))
       |> Enum.map_join(",", fn {key, value} ->
         JSON.encode!(key) <> ":" <> canonical(value)
       end)) <> "}"
  end

  def canonical(list) when is_list(list), do: "[" <> Enum.map_join(list, ",", &canonical/1) <> "]"
  def canonical(value), do: JSON.encode!(value)
end
