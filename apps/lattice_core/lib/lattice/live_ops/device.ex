defmodule Lattice.LiveOps.Device do
  @moduledoc """
  Simulated LiveOps device actor tied to a tab lifecycle.

  Device operations are reached through normal Lattice capabilities. The device
  never trusts browser role claims; the gateway must already have authorized the
  cap for this device target before this process receives a call.
  """

  use GenServer

  def start_link(tab_id, args, _opts) do
    GenServer.start_link(__MODULE__, {tab_id, Map.new(args)})
  end

  @impl true
  def init({tab_id, attrs}) do
    {:ok,
     %{
       tab_id: tab_id,
       kind: Map.fetch!(attrs, :kind),
       device_id: Map.fetch!(attrs, :device_id),
       role: Map.fetch!(attrs, :role),
       last_payload: nil
     }}
  end

  @impl true
  def handle_call({:lattice_call, envelope}, _from, state) do
    payload = Map.get(envelope, :payload, %{})
    action = action_from(payload)
    expected = Lattice.LiveOps.device_action(state.kind)
    cap_id = Map.get(envelope, :cap_id)
    tab_id = Map.fetch!(envelope, :from_tab_id)

    cond do
      tab_id != state.tab_id ->
        Lattice.LiveOps.record_denial(tab_id, action, :device_owner_mismatch, %{
          cap_id: cap_id,
          device_id: state.device_id
        })

        {:reply, {:error, :device_owner_mismatch}, state}

      action != expected ->
        Lattice.LiveOps.record_denial(tab_id, action, :device_action_not_allowed, %{
          cap_id: cap_id,
          device_id: state.device_id,
          expected_action: expected
        })

        {:reply, {:error, :device_action_not_allowed}, state}

      true ->
        {:ok, _event} =
          Lattice.LiveOps.device_event(
            state.kind,
            tab_id,
            state.device_id,
            action,
            cap_id,
            payload
          )

        {:reply,
         {:ok,
          %{
            device_id: state.device_id,
            device_kind: state.kind,
            action: action,
            accepted: true
          }}, %{state | last_payload: payload}}
    end
  end

  defp action_from(payload) when is_map(payload) do
    payload
    |> Map.get(:action, Map.get(payload, "action"))
    |> normalize_action()
  end

  defp action_from(_payload), do: :unknown

  defp normalize_action(action) when is_atom(action), do: action

  defp normalize_action(action) when is_binary(action) do
    action
    |> String.trim()
    |> String.downcase()
    |> String.replace("-", "_")
    |> String.to_existing_atom()
  rescue
    ArgumentError -> :unknown
  end

  defp normalize_action(_action), do: :unknown
end
