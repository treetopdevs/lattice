defmodule LatticeNodeSpike.WsHandler do
  @moduledoc """
  Cowboy WebSocket handler serving the spike's sync protocol on the peer node.

  JSON request/response envelopes (`type` selects the operation):

    * `frontier`        → `frontier_result` with the peer's sorted op-id list
    * `pull` (`have`)   → `ops` with the ops the caller lacks (Base64 wire form)
    * `push` (`ops`)    → `push_result` with the `Lattice.Sync.deliver/2` report
    * `live` (`payload`)→ `live_result` (never logged; echoes the log size)
    * `status`          → `status_result` (`base` | `diverged`)
    * `state`           → `state_result` (reduced-state bytes, ids, quarantine)
    * `shutdown`        → `shutdown_result`, then the OS process halts

  Connection close (however it happens) notifies the peer — that is the
  physical partition signal that triggers offline divergence.
  """

  @behaviour :cowboy_websocket

  alias Lattice.Carrier.Wire, as: CarrierWire
  alias LatticeNodeSpike.{Peer, Wire}

  @impl :cowboy_websocket
  def init(req, state), do: {:cowboy_websocket, req, state}

  @impl :cowboy_websocket
  def websocket_init(state), do: {:ok, state}

  @impl :cowboy_websocket
  def websocket_handle({:text, text}, state) do
    reply =
      case Jason.decode(text) do
        {:ok, %{"type" => type} = msg} -> handle_msg(type, msg, state)
        _other -> %{type: "error", reason: "malformed"}
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
    Peer.socket_closed(state.peer)
    :ok
  end

  # --- Protocol ---------------------------------------------------------------

  defp handle_msg("frontier", _msg, %{peer: peer}) do
    %{type: "frontier_result", ids: Peer.op_ids(peer)}
  end

  defp handle_msg("pull", %{"have" => have}, %{peer: peer}) when is_list(have) do
    ops = Peer.missing_for(peer, have)
    %{type: "ops", ops: Enum.map(ops, &Wire.encode/1)}
  end

  defp handle_msg("push", %{"ops" => encoded}, %{peer: peer}) when is_list(encoded) do
    case Wire.decode_all(encoded) do
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
