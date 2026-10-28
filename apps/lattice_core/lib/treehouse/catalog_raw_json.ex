defmodule Treehouse.CatalogRawJson do
  @moduledoc """
  Bounded JSON number-value interpretation for catalog histories and metadata.

  JavaScript JSON numbers have no separate integral-float type. This view makes
  safe integral numeric values decode identically without changing ordinary wire
  admission or artifact JSON text. Callers retain the original raw frame.
  """
  alias Lattice.Carrier.{RawObservationBounds, Wire}
  @max_safe 9_007_199_254_740_991
  @frame_fields ~w(v id replica author deps kind body cap sig)

  @doc "Safe nonnegative JSON number value; numeric text and booleans are distinct."
  @spec safe_integer?(term()) :: boolean()
  def safe_integer?(value) when is_integer(value), do: value >= 0 and value <= @max_safe

  def safe_integer?(value) when is_float(value) and value >= 0 and value <= @max_safe,
    do: trunc(value) == value

  def safe_integer?(_), do: false

  @spec frame_view(term()) :: {:ok, map()} | {:error, :malformed_op}
  def frame_view(frame) when is_map(frame) and map_size(frame) == 9 do
    if Enum.all?(@frame_fields, &Map.has_key?(frame, &1)) and RawObservationBounds.within?(frame),
      do: {:ok, numeric_values(frame)},
      else: {:error, :malformed_op}
  end

  def frame_view(_), do: {:error, :malformed_op}

  @spec authenticate_frame(term()) :: {:ok, map()} | {:error, :malformed_op}
  def authenticate_frame(frame) do
    with {:ok, view} <- frame_view(frame), do: Wire.authenticate_observation(view)
  end

  @spec decode_frame(term()) :: {:ok, Lattice.Op.t()} | {:error, :malformed_op}
  def decode_frame(frame) do
    with {:ok, view} <- frame_view(frame), do: Wire.decode_op(view)
  end

  defp numeric_values(value) when is_float(value) do
    if safe_integer?(value), do: trunc(value), else: value
  end

  defp numeric_values(values) when is_list(values), do: Enum.map(values, &numeric_values/1)

  defp numeric_values(values) when is_map(values),
    do: Map.new(values, fn {key, value} -> {key, numeric_values(value)} end)

  defp numeric_values(value), do: value
end
