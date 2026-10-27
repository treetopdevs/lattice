defmodule Treehouse.CatalogJSON do
  @moduledoc """
  Bounded raw catalog-artifact JSON with unsigned safe decimal number tokens.

  Numeric spelling is checked before Jason can allocate an integer. Quoted and
  escaped strings stay opaque; Jason remains the JSON syntax/structure owner.
  This supplies neither record normalization nor semantic/installed trust.
  """
  alias Lattice.Carrier.Uint64
  @maximum 131_072
  @safe_maximum 9_007_199_254_740_991

  @spec decode(term()) :: {:ok, term()} | {:error, :malformed_catalog | :control_history_limit}
  def decode(value) when is_binary(value) and byte_size(value) > @maximum,
    do: {:error, :control_history_limit}

  def decode(value) when is_binary(value) do
    with true <- numbers?(value, :outside),
         {:ok, decoded} <- Jason.decode(value),
         do: {:ok, decoded},
         else: (_ -> {:error, :malformed_catalog})
  end

  def decode(_), do: {:error, :malformed_catalog}

  defp numbers?(<<>>, :outside), do: true
  defp numbers?(<<>>, :string), do: false
  defp numbers?(<<92, _escaped, rest::binary>>, :string), do: numbers?(rest, :string)
  defp numbers?(<<34, rest::binary>>, :string), do: numbers?(rest, :outside)
  defp numbers?(<<_byte, rest::binary>>, :string), do: numbers?(rest, :string)
  defp numbers?(<<34, rest::binary>>, :outside), do: numbers?(rest, :string)
  defp numbers?(<<45, _::binary>>, :outside), do: false

  defp numbers?(<<digit, _::binary>> = input, :outside) when digit in ?0..?9 do
    with {:ok, size, rest} <- digits(input, 0),
         {:ok, integer} <- Uint64.parse_text(binary_part(input, 0, size)),
         true <- integer <= @safe_maximum,
         false <- fraction_or_exponent?(rest) do
      numbers?(rest, :outside)
    else
      _ -> false
    end
  end

  defp numbers?(<<_byte, rest::binary>>, :outside), do: numbers?(rest, :outside)
  defp digits(<<digit, _::binary>>, 20) when digit in ?0..?9, do: :error
  defp digits(<<digit, rest::binary>>, size) when digit in ?0..?9, do: digits(rest, size + 1)
  defp digits(rest, size), do: {:ok, size, rest}
  defp fraction_or_exponent?(<<byte, _::binary>>) when byte in [?., ?e, ?E], do: true
  defp fraction_or_exponent?(_), do: false
end
