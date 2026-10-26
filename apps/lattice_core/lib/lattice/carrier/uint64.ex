defmodule Lattice.Carrier.Uint64 do
  @moduledoc """
  Bounded canonical unsigned integer parsing for raw catalog readers.

  Decimal text is checked lexically before allocating an integer. Reader-specific
  JSON representation and wire admission rules remain with each caller.
  """
  @maximum "18446744073709551615"

  @spec parse_text(term()) :: {:ok, non_neg_integer()} | :error
  def parse_text(value) when is_binary(value) and byte_size(value) in 1..20 do
    if Regex.match?(~r/\A(0|[1-9][0-9]{0,19})\z/, value) and
         (byte_size(value) < 20 or value <= @maximum) do
      {integer, ""} = Integer.parse(value)
      {:ok, integer}
    else
      :error
    end
  end

  def parse_text(_), do: :error

  @doc "Portable JSON representation: safe numbers and canonical high decimal text."
  @spec portable_scalar?(term()) :: boolean()
  def portable_scalar?(value) when is_integer(value),
    do: value >= 0 and value <= 9_007_199_254_740_991

  def portable_scalar?(value) when is_binary(value) do
    case parse_text(value) do
      {:ok, integer} -> integer > 9_007_199_254_740_991
      :error -> false
    end
  end

  def portable_scalar?(_), do: false
end
