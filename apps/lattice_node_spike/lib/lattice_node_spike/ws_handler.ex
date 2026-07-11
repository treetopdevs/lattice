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

  alias Lattice.Carrier.{Protocol, Session}
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
        {:ok, %{"type" => type} = msg} -> protocol_msg(type, msg, state)
        _other -> {Protocol.error(:malformed_request), state}
      end

    {:reply, {:text, Jason.encode!(reply)}, state}
  end

  def websocket_handle(_frame, state) do
    {:reply, {:text, Jason.encode!(Protocol.error(:unsupported_frame))}, state}
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

        {Protocol.error(reason), state}
    end
  end

  defp protocol_msg(_type, msg, %{authenticated?: true} = state) do
    reply =
      case Protocol.decode_request(msg) do
        {:ok, request} -> handle_request(request, state)
        {:error, reason} -> Protocol.error(reason)
      end

    {reply, state}
  end

  defp protocol_msg(type, _msg, state) do
    Telemetry.execute(
      [:lattice, :carrier, :pre_auth_reject],
      %{},
      %{type: type}
    )

    {Protocol.error(:unauthenticated), state}
  end

  defp handle_request(:frontier, %{peer: peer}) do
    peer |> Peer.op_ids() |> Protocol.frontier_result()
  end

  defp handle_request({:pull, have}, %{peer: peer}) do
    ops = Peer.missing_for(peer, have)
    ops |> Enum.map(&CarrierWire.encode_op/1) |> Protocol.ops_result()
  end

  defp handle_request({:push, encoded}, %{peer: peer}) do
    case CarrierWire.decode_ops(encoded) do
      {:ok, ops} ->
        peer |> Peer.deliver(ops) |> Protocol.push_result()

      {:error, :malformed_op} ->
        Protocol.error(:malformed_op)
    end
  end

  defp handle_request({:live, payload}, %{peer: peer}) do
    peer |> Peer.live(payload) |> Protocol.live_result()
  end

  defp handle_request(:status, %{peer: peer}) do
    peer |> Peer.status() |> to_string() |> Protocol.status_result()
  end

  defp handle_request(:state, %{peer: peer}) do
    peer |> Peer.state_report() |> Protocol.state_result()
  end

  defp handle_request(:shutdown, _state) do
    # Reply first; halt shortly after so the frame flushes.
    spawn(fn ->
      Process.sleep(200)
      System.halt(0)
    end)

    Protocol.shutdown_result()
  end
end
