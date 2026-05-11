defmodule Lattice.Gateway do
  @moduledoc """
  The only legal path across realms.

  Tab-originated work is validated by cap owner, operation, target, expiry,
  revocation state, and use count before any forwarding occurs.
  """

  alias Lattice.{Audit, Cap, CapStore, Topology}

  def call(tab_id, cap_or_id, payload, timeout \\ 5_000) do
    with {:ok, cap} <- CapStore.authorize(tab_id, cap_or_id, :call, payload),
         :ok <- validate_target(tab_id, cap),
         {:ok, result} <- forward_call(tab_id, cap, payload, timeout) do
      {:ok, result}
    else
      {:error, reason} ->
        {:error, reason}
    end
  end

  def cast(tab_id, cap_or_id, payload) do
    with {:ok, cap} <- CapStore.authorize(tab_id, cap_or_id, :cast, payload),
         :ok <- validate_target(tab_id, cap),
         :ok <- forward_cast(tab_id, cap, payload) do
      :ok
    else
      {:error, reason} ->
        {:error, reason}
    end
  end

  defp validate_target(tab_id, %Cap{target: {:tab, tab_id}}), do: :ok

  defp validate_target(tab_id, %Cap{target: {:tab, target_tab_id}, id: cap_id}) do
    if Topology.bridge_allowed?(tab_id, target_tab_id, cap_id) do
      :ok
    else
      Audit.record(:deny, %{
        tab_id: tab_id,
        target_tab_id: target_tab_id,
        cap_id: cap_id,
        reason: :bridge_required
      })

      {:error, :bridge_required}
    end
  end

  defp validate_target(_tab_id, %Cap{target: {:server_pid, pid}}) when is_pid(pid), do: :ok
  defp validate_target(_tab_id, %Cap{target: {:server_name, name}}) when is_atom(name), do: :ok

  defp validate_target(tab_id, %Cap{id: cap_id, target: target}) do
    Audit.record(:deny, %{
      tab_id: tab_id,
      cap_id: cap_id,
      target: inspect(target),
      reason: :invalid_target
    })

    {:error, :invalid_target}
  end

  defp forward_call(tab_id, %Cap{target: {:server_pid, pid}}, payload, timeout) do
    safe_server_call(tab_id, pid, payload, timeout)
  end

  defp forward_call(tab_id, %Cap{target: {:server_name, name}}, payload, timeout) do
    case Process.whereis(name) do
      nil -> {:error, :target_down}
      pid -> safe_server_call(tab_id, pid, payload, timeout)
    end
  end

  defp forward_call(tab_id, %Cap{target: {:tab, target_tab_id}, id: cap_id}, payload, timeout) do
    envelope = %{
      type: :call,
      from_tab_id: tab_id,
      target_tab_id: target_tab_id,
      cap_id: cap_id,
      payload: payload
    }

    case Topology.deliver_to_tab(target_tab_id, envelope, timeout) do
      {:error, reason} = error ->
        audit_tab_delivery_denied(tab_id, target_tab_id, cap_id, reason)
        error

      other ->
        other
    end
  end

  defp forward_cast(tab_id, %Cap{target: {:server_pid, pid}, id: cap_id}, payload) do
    if Process.alive?(pid) do
      GenServer.cast(
        pid,
        {:lattice_cast, %{from_tab_id: tab_id, cap_id: cap_id, payload: payload}}
      )
    else
      {:error, :target_down}
    end
  end

  defp forward_cast(tab_id, %Cap{target: {:server_name, name}, id: cap_id}, payload) do
    case Process.whereis(name) do
      nil ->
        {:error, :target_down}

      pid ->
        GenServer.cast(
          pid,
          {:lattice_cast, %{from_tab_id: tab_id, cap_id: cap_id, payload: payload}}
        )
    end
  end

  defp forward_cast(tab_id, %Cap{target: {:tab, target_tab_id}, id: cap_id}, payload) do
    envelope = %{
      type: :cast,
      from_tab_id: tab_id,
      target_tab_id: target_tab_id,
      cap_id: cap_id,
      payload: payload
    }

    case Topology.deliver_cast_to_tab(target_tab_id, envelope) do
      {:error, reason} = error ->
        audit_tab_delivery_denied(tab_id, target_tab_id, cap_id, reason)
        error

      other ->
        other
    end
  end

  defp safe_server_call(tab_id, pid, payload, timeout) do
    try do
      GenServer.call(pid, {:lattice_call, %{from_tab_id: tab_id, payload: payload}}, timeout)
    catch
      :exit, _ -> {:error, :target_down}
    end
  end

  defp audit_tab_delivery_denied(tab_id, target_tab_id, cap_id, reason) do
    Audit.record(:deny, %{
      tab_id: tab_id,
      target_tab_id: target_tab_id,
      cap_id: cap_id,
      reason: reason
    })
  end
end
