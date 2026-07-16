defmodule Lattice.Transport.WebSocket.Envelope do
  @moduledoc """
  Strict JSON envelope parser for untrusted WebSocket input.

  This module deliberately uses JSON only. It never calls `binary_to_term/1` or
  `:erlang.binary_to_term/1` on browser-provided data.

  `encode/1` is transport-generic. The `parse/1` allowlist remains the inbound
  browser-tab vocabulary owned by the `lattice_server` boundary; keeping both
  functions here avoids making the reusable client depend on that server app.
  """

  @allowed_types ~w(hello resume state_request grant_request call cast liveops_action disconnect tab_render_result)

  def parse(text) when is_binary(text) and byte_size(text) <= 65_536 do
    with {:ok, decoded} <- Jason.decode(text),
         :ok <- validate_map(decoded),
         {:ok, type} <- fetch_type(decoded),
         :ok <- validate_type(type) do
      {:ok, Map.put(decoded, "type", type)}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :malformed}
    end
  end

  def parse(_), do: {:error, :malformed}

  def encode(map) when is_map(map), do: Jason.encode!(stringify_keys(map))

  defp validate_map(map) when is_map(map), do: :ok
  defp validate_map(_), do: {:error, :malformed}

  defp fetch_type(%{"type" => type}) when is_binary(type), do: {:ok, type}
  defp fetch_type(_), do: {:error, :missing_type}

  defp validate_type(type) when type in @allowed_types, do: :ok
  defp validate_type(_), do: {:error, :unknown_type}

  defp stringify_keys(map) do
    Map.new(map, fn
      {key, value} when is_atom(key) -> {Atom.to_string(key), stringify_value(value)}
      {key, value} -> {key, stringify_value(value)}
    end)
  end

  defp stringify_value(value) when is_map(value), do: stringify_keys(value)
  defp stringify_value(value) when is_list(value), do: Enum.map(value, &stringify_value/1)
  defp stringify_value(value) when is_boolean(value) or is_nil(value), do: value
  defp stringify_value(value) when is_atom(value), do: Atom.to_string(value)
  defp stringify_value(value), do: value
end
