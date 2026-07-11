defmodule LatticeCarrierServer.WebSocket do
  @moduledoc false

  @behaviour :cowboy_websocket

  alias Lattice.Carrier.{Session, Telemetry, Wire}
  alias LatticeCarrierServer.Holder

  @max_frame_size 64_000

  @impl :cowboy_websocket
  def init(req, state) do
    {:cowboy_websocket, req, state, %{idle_timeout: 10_000, max_frame_size: @max_frame_size}}
  end

  @impl :cowboy_websocket
  def websocket_init(state), do: {:ok, state}

  @impl :cowboy_websocket
  def websocket_handle({:text, text}, state) do
    {reply, state} =
      case Jason.decode(text) do
        {:ok, %{"type" => "carrier_challenge"} = challenge} ->
          authenticate(challenge, state)

        {:ok, %{"type" => type} = message} ->
          authenticated_message(type, message, state)

        _other ->
          {%{type: "error", reason: "malformed"}, state}
      end

    {:reply, {:text, Jason.encode!(reply)}, state}
  end

  def websocket_handle(_frame, state) do
    {:reply, {:text, Jason.encode!(%{type: "error", reason: "unsupported_frame"})}, state}
  end

  @impl :cowboy_websocket
  def websocket_info(_message, state), do: {:ok, state}

  defp authenticate(challenge, state) do
    with %{"local_realm" => peer_realm, "replica" => replica, "wire_version" => version} <-
           challenge,
         {:ok, peer_pubkey} <- Map.fetch(state.trusted_peers, peer_realm),
         {identity, ^replica} <- Holder.session_context(state.holder),
         true <- version == Wire.version(),
         :ok <-
           Session.verify_challenge(challenge,
             expected_realm: peer_realm,
             expected_pubkey: peer_pubkey
           ) do
      response = Session.respond(challenge, identity, identity.realm_id)

      {response,
       state
       |> Map.put(:authenticated?, true)
       |> Map.put(:peer_realm, peer_realm)
       |> Map.put(:realm, identity.realm_id)}
    else
      reason -> authentication_failure(reason, challenge, state)
    end
  end

  defp authentication_failure(reason, challenge, state) do
    peer_realm = Map.get(challenge, "local_realm")

    Telemetry.execute(
      [:lattice, :carrier, :auth_failure],
      %{},
      %{
        reason: auth_failure_reason(reason),
        expected_realm: peer_realm,
        peer_realm: peer_realm,
        side: :server
      }
    )

    {%{type: "error", reason: "unauthenticated"}, state}
  end

  defp auth_failure_reason({:error, reason}), do: reason
  defp auth_failure_reason(:error), do: :unknown_peer
  defp auth_failure_reason(false), do: :unsupported_wire_version
  defp auth_failure_reason({_identity, _replica}), do: :wrong_replica
  defp auth_failure_reason(_reason), do: :malformed_session

  defp authenticated_message(type, message, %{authenticated?: true} = state) do
    {handle_message(type, message, state), state}
  end

  defp authenticated_message(_type, _message, state) do
    {%{type: "error", reason: "unauthenticated"}, state}
  end

  defp handle_message("frontier", _message, state) do
    %{type: "frontier_result", ids: Holder.op_ids(state.holder)}
  end

  defp handle_message("pull", %{"have" => have}, state) when is_list(have) do
    ops = state.holder |> Holder.missing_for(have) |> Enum.map(&Wire.encode_op/1)
    %{type: "ops", ops: ops}
  end

  defp handle_message("relay", %{"op" => encoded_op}, state) do
    with {:ok, op} <- Wire.decode_op(encoded_op),
         {:ok, report} <- Holder.relay(state.holder, state.peer_realm, op) do
      report |> Wire.encode_report() |> Map.put("type", "relay_result")
    else
      {:error, :read_only} ->
        %{type: "error", reason: "read_only"}

      {:error, :malformed_op} ->
        %{type: "error", reason: "malformed"}

      {:error, {:persistence_failed, _reason} = reason} ->
        Telemetry.execute(
          [:lattice, :carrier, :relay_failure],
          %{},
          %{reason: reason, peer_realm: state.peer_realm, side: :server}
        )

        %{type: "error", reason: "unavailable"}
    end
  end

  defp handle_message("relay", _message, _state) do
    %{type: "error", reason: "malformed"}
  end

  defp handle_message(_type, _message, _state) do
    %{type: "error", reason: "read_only"}
  end

  @impl :cowboy_websocket
  def terminate(_reason, _req, %{authenticated?: true} = state) do
    Telemetry.execute(
      [:lattice, :carrier, :disconnect],
      %{},
      %{realm: state.realm, peer_realm: state.peer_realm, side: :server}
    )

    :ok
  end

  def terminate(_reason, _req, _state), do: :ok
end
