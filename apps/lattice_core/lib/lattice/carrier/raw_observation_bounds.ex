defmodule Lattice.Carrier.RawObservationBounds do
  @moduledoc """
  Bounded raw JSON observation before canonical allocation.

  This checks only nodes, UTF-8 string bytes and JSON container depth. It proves
  neither wire shape, authenticity nor authority, and permits no operation.
  Shared subterms count at every occurrence; imported names remain binary data.
  """

  # A generic map uses three JSON containers. The frame object and flat
  # delegation array/object/names-array leaf add four without domain depth.
  @max_json_depth 65 * 3 + 4

  @spec within?(term()) :: boolean()
  def within?(value),
    do: observation_bound?([{:value, value, @max_json_depth}], 67_108_864, 67_108_864)

  defp observation_bound?(_pending, nodes, bytes) when nodes < 0 or bytes < 0, do: false
  defp observation_bound?([], _nodes, _bytes), do: true

  defp observation_bound?([{:value, value, _depth} | rest], nodes, bytes) when is_binary(value),
    do: observation_bound?(rest, nodes - 1, bytes - byte_size(value))

  defp observation_bound?([{:value, value, depth} | rest], nodes, bytes)
       when is_list(value) and depth > 0,
       do: observation_bound?([{:list, value, depth - 1} | rest], nodes - 1, bytes)

  defp observation_bound?([{:value, value, depth} | rest], nodes, bytes)
       when is_map(value) and depth > 0,
       do: observation_bound?([{:map, :maps.iterator(value), depth - 1} | rest], nodes - 1, bytes)

  defp observation_bound?([{:value, value, _depth} | rest], nodes, bytes)
       when is_number(value) or is_boolean(value) or is_nil(value),
       do: observation_bound?(rest, nodes - 1, bytes)

  defp observation_bound?([{:list, [], _depth} | rest], nodes, bytes),
    do: observation_bound?(rest, nodes, bytes)

  defp observation_bound?([{:list, [head | tail], depth} | rest], nodes, bytes),
    do: observation_bound?([{:value, head, depth}, {:list, tail, depth} | rest], nodes, bytes)

  defp observation_bound?([{:map, iterator, depth} | rest], nodes, bytes) do
    case :maps.next(iterator) do
      :none ->
        observation_bound?(rest, nodes, bytes)

      {key, value, next} ->
        observation_bound?(
          [{:value, key, depth}, {:value, value, depth}, {:map, next, depth} | rest],
          nodes,
          bytes
        )
    end
  end

  defp observation_bound?(_pending, _nodes, _bytes), do: false
end
