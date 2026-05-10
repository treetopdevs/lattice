defmodule Lattice.Cap.Membrane do
  @moduledoc """
  Membrane helpers that keep confused-deputy demos capability-shaped.

  A membrane request carries only a cap id plus payload. Raw pids, registered
  names, or target override fields are rejected before a deputy can be tricked
  into using ambient authority.
  """

  alias Lattice.Cap

  @forbidden_target_keys [:target, "target", :pid, "pid", :registered_name, "registered_name"]

  def request(%Cap{} = cap, payload), do: request(cap.id, payload)

  def request(cap_id, payload) when is_binary(cap_id) and is_map(payload) do
    if Enum.any?(@forbidden_target_keys, &Map.has_key?(payload, &1)) do
      {:error, :ambient_target_rejected}
    else
      {:ok, %{cap_id: cap_id, payload: payload}}
    end
  end

  def call(tab_id, cap_or_id, payload) do
    with {:ok, request} <- request(Cap.token(cap_or_id), payload) do
      Lattice.call(tab_id, request.cap_id, request.payload)
    end
  end
end
