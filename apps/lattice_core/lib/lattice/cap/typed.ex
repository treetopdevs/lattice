defmodule Lattice.Cap.Typed do
  @moduledoc """
  Runtime payload type checks for capabilities.

  This is intentionally a small executable contract system rather than static
  typing. It gives demos a concrete session/type boundary while keeping the
  research claim honest: these checks are runtime validation, not formal proof.
  """

  def validate(nil, _payload), do: :ok

  def validate(schema, payload) when is_map(schema) and is_map(payload) do
    Enum.reduce_while(schema, :ok, fn {field, spec}, :ok ->
      optional? = optional?(spec)
      type = unwrap_optional(spec)

      case fetch_field(payload, field) do
        {:ok, value} ->
          if matches?(type, value) do
            {:cont, :ok}
          else
            {:halt, {:error, {:payload_type_mismatch, field, type}}}
          end

        :error when optional? ->
          {:cont, :ok}

        :error ->
          {:halt, {:error, {:payload_field_required, field}}}
      end
    end)
  end

  def validate(_schema, _payload), do: {:error, :payload_schema_requires_map}

  defp fetch_field(payload, field) do
    cond do
      Map.has_key?(payload, field) ->
        {:ok, Map.fetch!(payload, field)}

      is_atom(field) and Map.has_key?(payload, Atom.to_string(field)) ->
        {:ok, Map.fetch!(payload, Atom.to_string(field))}

      is_binary(field) ->
        try do
          atom = String.to_existing_atom(field)
          if Map.has_key?(payload, atom), do: {:ok, Map.fetch!(payload, atom)}, else: :error
        rescue
          ArgumentError -> :error
        end

      true ->
        :error
    end
  end

  defp optional?({:optional, _type}), do: true
  defp optional?(_type), do: false

  defp unwrap_optional({:optional, type}), do: type
  defp unwrap_optional(type), do: type

  defp matches?(:any, _value), do: true
  defp matches?(:number, value), do: is_number(value)
  defp matches?(:integer, value), do: is_integer(value)
  defp matches?(:string, value), do: is_binary(value)
  defp matches?(:atom, value), do: is_atom(value)
  defp matches?(:boolean, value), do: is_boolean(value)
  defp matches?(:map, value), do: is_map(value)
  defp matches?({:one_of, values}, value), do: value in values
end
