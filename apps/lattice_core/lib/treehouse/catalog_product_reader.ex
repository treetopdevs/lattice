defmodule Treehouse.CatalogProductReader do
  @moduledoc """
  Product-reader integer contexts for authenticated raw catalog histories.

  Wire shape, signature, cutoff vocabulary and bounds stay with their existing
  owners. Ordinary values must fit JavaScript's exact integer range; beacon and
  policy metadata retain the existing bounded uint64 representation. This does
  not judge authority or semantic honor and does not apply to rejected evidence.
  """
  alias Lattice.Carrier.Uint64
  @max_safe 9_007_199_254_740_991

  @spec readable_frame?(term()) :: boolean()
  def readable_frame?(%{"body" => body, "cap" => cap} = frame),
    do: body_readable?(frame["kind"], body) and readable?(cap, :strict)

  def readable_frame?(_), do: false

  defp body_readable?("authority", ["tuple", [["atom", "beacon"], ["int", epoch]]]),
    do: integer?(epoch, :metadata)

  defp body_readable?("authority", ["tuple", [["atom", "beacon"], epoch, certificate]]),
    do: readable?(epoch, :strict) and readable?(certificate, :certificate)

  defp body_readable?("authority", ["tuple", [["atom", "genesis"], delegation, ["map", policies]]]) do
    readable?(delegation, :strict) and
      Enum.all?(policies, fn
        [key, value] ->
          readable?(key, :strict) and
            readable?(value, if(key == ["atom", "__beacon__"], do: :metadata, else: :strict))

        _ ->
          false
      end)
  end

  defp body_readable?(_kind, body), do: readable?(body, :strict)

  defp readable?(["int", value], context), do: integer?(value, context)

  defp readable?([tag, values], context)
       when tag in ["list", "tuple", "mapset"] and is_list(values),
       do: Enum.all?(values, &readable?(&1, child(context)))

  defp readable?(["map", pairs], context) when is_list(pairs) do
    Enum.all?(pairs, fn
      [key, value] ->
        value_context =
          cond do
            context == :certificate and key == ["atom", "claim"] ->
              :claim

            context == :claim and key == ["atom", "epoch"] and match?(["int", _], value) ->
              :strict

            true ->
              child(context)
          end

        readable?(key, child(context)) and readable?(value, value_context)

      _ ->
        false
    end)
  end

  defp readable?(["delegation", fields], _context) when is_map(fields) do
    not Map.has_key?(fields, "expires_epoch") or
      (is_integer(fields["expires_epoch"]) and fields["expires_epoch"] >= 0 and
         fields["expires_epoch"] <= @max_safe)
  end

  defp readable?([tag, _], _context) when tag in ["atom", "bin", "bool"], do: true
  defp readable?(["nil"], _context), do: true
  defp readable?(_, _context), do: false
  defp child(:strict), do: :strict
  defp child(_), do: :metadata

  defp integer?(value, context) when is_integer(value),
    do:
      value >= 0 and
        value <= if(context == :strict, do: @max_safe, else: 18_446_744_073_709_551_615)

  defp integer?(value, context) do
    case Uint64.parse_text(value) do
      {:ok, integer} -> context != :strict or integer <= @max_safe
      :error -> false
    end
  end
end
