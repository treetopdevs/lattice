defmodule LatticeNodeSpike.WsHandler do
  @moduledoc """
  Cowboy WebSocket handler serving the spike's sync protocol on the peer node.

  JSON request/response envelopes (`type` selects the operation):

    * `frontier`        → `frontier_result` with the peer's sorted op-id list
    * `pull` (`have`)   → `ops` with the ops the caller lacks (JSON carrier wire form)
    * `push` (`ops`)    → `push_result` with the `Lattice.Sync.deliver/2` report
    * `live` (`payload`)→ `live_result` (never logged; echoes the log size)
    * `status`          → `status_result` (`base` | `diverged`)
    * `state`           → `state_result` (reduced-state bytes, ids, quarantine)
    * `shutdown`        → `shutdown_result`, then the OS process halts

  An authenticated connection close notifies the peer — that is the physical partition
  signal that triggers offline divergence. Unauthenticated sockets never advance peer
  state.
  """

  @behaviour :cowboy_websocket

  alias Lattice.Carrier.Session
  alias Lattice.Carrier.Telemetry
  alias Lattice.Carrier.Wire, as: CarrierWire
  alias LatticeNodeSpike.Peer

  @impl :cowboy_websocket
  def init(req, state), do: {:cowboy_websocket, req, state}

  @impl :cowboy_websocket
  def websocket_init(state), do: {:ok, state}

  @impl :cowboy_websocket
  def websocket_handle({:text, text}, state) do
    {reply, state} =
      case Jason.decode(text) do
        {:ok, %{"type" => "carrier_challenge"} = msg} -> handle_challenge(msg, state)
        {:ok, %{"type" => type} = msg} -> authenticated_msg(type, msg, state)
        _other -> {%{type: "error", reason: "malformed"}, state}
      end

    {:reply, {:text, Jason.encode!(reply)}, state}
  end

  def websocket_handle(_frame, state) do
    {:reply, {:text, Jason.encode!(%{type: "error", reason: "unsupported_frame"})}, state}
  end

  @impl :cowboy_websocket
  def websocket_info(_message, state), do: {:ok, state}

  @impl :cowboy_websocket
  def terminate(_reason, _req, state) do
    # The physical partition: the socket is gone.
    if Map.get(state, :authenticated?, false) do
      Telemetry.execute(
        [:lattice, :carrier, :disconnect],
        %{},
        %{realm: Map.get(state, :realm)}
      )

      Peer.socket_closed(state.peer)
    end

    :ok
  end

  # --- Protocol ---------------------------------------------------------------

  defp handle_challenge(challenge, state) do
    case Session.verify_challenge(challenge,
           expected_realm: state.trusted_peer_realm,
           expected_pubkey: state.trusted_peer_pubkey
         ) do
      :ok ->
        {realm, identity} = Peer.session_identity(state.peer)

        {Session.respond(challenge, identity, realm),
         state
         |> Map.put(:authenticated?, true)
         |> Map.put(:realm, realm)}

      {:error, reason} ->
        Telemetry.execute(
          [:lattice, :carrier, :auth_failure],
          %{},
          %{
            reason: reason,
            expected_realm: state.trusted_peer_realm,
            peer_realm: Map.get(challenge, "local_realm"),
            side: :server
          }
        )

        {%{type: "error", reason: Atom.to_string(reason)}, state}
    end
  end

  defp authenticated_msg(type, msg, %{authenticated?: true} = state) do
    {handle_msg(type, msg, state), state}
  end

  defp authenticated_msg(type, _msg, state) do
    Telemetry.execute(
      [:lattice, :carrier, :pre_auth_reject],
      %{},
      %{type: type}
    )

    {%{type: "error", reason: "unauthenticated"}, state}
  end

  defp handle_msg("frontier", _msg, %{peer: peer}) do
    %{type: "frontier_result", ids: Peer.op_ids(peer)}
  end

  defp handle_msg("pull", %{"have" => have}, %{peer: peer}) when is_list(have) do
    ops = Peer.missing_for(peer, have)
    %{type: "ops", ops: Enum.map(ops, &CarrierWire.encode_op/1)}
  end

  defp handle_msg("push", %{"ops" => encoded}, %{peer: peer}) when is_list(encoded) do
    case CarrierWire.decode_ops(encoded) do
      {:ok, ops} ->
        report = Peer.deliver(peer, ops)
        CarrierWire.encode_push_result(report)

      {:error, :malformed_op} ->
        %{type: "error", reason: "malformed_op"}
    end
  end

  defp handle_msg("live", %{"payload" => payload}, %{peer: peer}) do
    result = Peer.live(peer, payload)
    %{type: "live_result", live_seen: result.live_seen, log_size: result.log_size}
  end

  defp handle_msg("status", _msg, %{peer: peer}) do
    %{type: "status_result", phase: to_string(Peer.status(peer))}
  end

  defp handle_msg("state", _msg, %{peer: peer}) do
    peer |> Peer.state_report() |> Map.put(:type, "state_result")
  end

  defp handle_msg("shutdown", _msg, _state) do
    # Reply first; halt shortly after so the frame flushes.
    spawn(fn ->
      Process.sleep(200)
      System.halt(0)
    end)

    %{type: "shutdown_result"}
  end

  defp handle_msg(_type, _msg, _state), do: %{type: "error", reason: "unknown_type"}
end
