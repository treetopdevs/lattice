defmodule LatticeCarrierSpike.Message do
  @moduledoc false

  @max_frame_bytes 16_384
  @max_id_bytes 256

  def decode(frame) when is_binary(frame), do: decode_text(frame)

  def decode(frame) when is_list(frame) do
    if printable_charlist?(frame) do
      frame
      |> to_string()
      |> decode_text()
    else
      {:error, :not_logical_json}
    end
  end

  def decode(_frame), do: {:error, :not_logical_json}

  defp decode_text(text) when byte_size(text) <= @max_frame_bytes do
    with {:ok, decoded} <- Jason.decode(text),
         {:ok, request} <- validate(decoded) do
      {:ok, request}
    else
      {:error, %Jason.DecodeError{}} -> {:error, :malformed_json}
      {:error, reason} -> {:error, reason}
    end
  end

  defp decode_text(_text), do: {:error, :frame_too_large}

  defp validate(%{
         "type" => "lattice_call",
         "request_id" => request_id,
         "tab_id" => tab_id,
         "cap_id" => cap_id,
         "payload" => payload
       })
       when is_map(payload) do
    with :ok <- safe_id?(request_id),
         :ok <- safe_id?(tab_id),
         :ok <- safe_id?(cap_id) do
      {:ok,
       %{
         request_id: request_id,
         tab_id: tab_id,
         cap_id: cap_id,
         payload: payload
       }}
    end
  end

  defp validate(_decoded), do: {:error, :unsupported_message}

  defp safe_id?(value) when is_binary(value) do
    trimmed = String.trim(value)

    cond do
      trimmed == "" -> {:error, :invalid_identifier}
      byte_size(trimmed) > @max_id_bytes -> {:error, :invalid_identifier}
      String.match?(trimmed, ~r/^[A-Za-z0-9_.:@-]+$/) -> :ok
      true -> {:error, :invalid_identifier}
    end
  end

  defp safe_id?(_value), do: {:error, :invalid_identifier}

  defp printable_charlist?(value) do
    List.ascii_printable?(value) and length(value) <= @max_frame_bytes
  end
end
