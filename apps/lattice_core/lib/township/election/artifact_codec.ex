defmodule Township.Election.ArtifactCodec do
  @moduledoc """
  Canonical JSON document encoding used by the research close contracts.

  Maps must have UTF-8 string keys, integers are non-negative, and decoded bytes
  must re-encode identically. Opaque construction artifacts remain opaque bytes;
  this codec is only for the versioned public documents defined in this layer.
  """

  alias Jason.OrderedObject

  @spec encode(term()) :: {:ok, binary()} | {:error, :noncanonical_artifact}
  def encode(term) do
    with {:ok, ordered} <- order(term),
         {:ok, bytes} <- Jason.encode(ordered) do
      {:ok, bytes}
    else
      _ -> {:error, :noncanonical_artifact}
    end
  rescue
    _ -> {:error, :noncanonical_artifact}
  end

  @spec decode(binary()) :: {:ok, term()} | {:error, :noncanonical_artifact}
  def decode(bytes) when is_binary(bytes) do
    with {:ok, term} <- Jason.decode(bytes),
         {:ok, ^bytes} <- encode(term) do
      {:ok, term}
    else
      _ -> {:error, :noncanonical_artifact}
    end
  rescue
    _ -> {:error, :noncanonical_artifact}
  end

  def decode(_bytes), do: {:error, :noncanonical_artifact}

  defp order(nil), do: {:ok, nil}
  defp order(value) when is_boolean(value), do: {:ok, value}
  defp order(value) when is_integer(value) and value >= 0, do: {:ok, value}

  defp order(value) when is_binary(value) do
    if String.valid?(value), do: {:ok, value}, else: {:error, :noncanonical_artifact}
  end

  defp order(values) when is_list(values) do
    if proper_list?(values) do
      reduce_list(values, [])
    else
      {:error, :noncanonical_artifact}
    end
  end

  defp order(map) when is_map(map) and not is_struct(map) do
    map
    |> Enum.sort_by(fn {key, _value} -> key end)
    |> Enum.reduce_while({:ok, []}, fn
      {key, value}, {:ok, pairs} when is_binary(key) ->
        if String.valid?(key) do
          case order(value) do
            {:ok, ordered} -> {:cont, {:ok, [{key, ordered} | pairs]}}
            {:error, _reason} = error -> {:halt, error}
          end
        else
          {:halt, {:error, :noncanonical_artifact}}
        end

      _entry, _acc ->
        {:halt, {:error, :noncanonical_artifact}}
    end)
    |> case do
      {:ok, pairs} -> {:ok, pairs |> Enum.reverse() |> OrderedObject.new()}
      {:error, _reason} = error -> error
    end
  rescue
    _ -> {:error, :noncanonical_artifact}
  end

  defp order(_other), do: {:error, :noncanonical_artifact}

  defp reduce_list([], acc), do: {:ok, Enum.reverse(acc)}

  defp reduce_list([head | tail], acc) do
    case order(head) do
      {:ok, ordered} -> reduce_list(tail, [ordered | acc])
      {:error, _reason} = error -> error
    end
  end

  defp proper_list?([]), do: true
  defp proper_list?([_head | tail]), do: proper_list?(tail)
  defp proper_list?(_other), do: false
end
