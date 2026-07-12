defmodule LatticeNodeSpike.WebSocketCarrierSecurityTest do
  use ExUnit.Case, async: false

  alias Lattice.Carrier.WebSocket, as: WsCarrier
  alias Lattice.{Identity, Log, Op}
  alias Lattice.Transport.WebSocket.Client
  alias LatticeNodeSpike.{Peer, PeerServer}

  @replica "replica:ws-carrier-security"

  test "connect requires explicit local identity and peer trust anchors before dialing" do
    node_b = identity("node_b")

    assert {:error, {:missing_required_opt, :identity}} =
             WsCarrier.connect(
               port: 1,
               realm: "node_b",
               peer_realm: "node_a",
               peer_pubkey: identity("node_a").pub,
               replica: @replica
             )

    assert {:error, {:missing_required_opt, :peer_pubkey}} =
             WsCarrier.connect(
               port: 1,
               identity: node_b,
               realm: "node_b",
               peer_realm: "node_a",
               replica: @replica
             )
  end

  test "handler rejects protocol requests before a verified carrier session" do
    port = start_peer_server()

    {:ok, client} = Client.connect(port: port, path: "/carrier")
    :ok = Client.send_envelope(client, %{type: "status"})

    assert {:ok, %{"type" => "error", "reason" => "unauthenticated"}} =
             Client.recv_envelope(client)

    :ok = Client.close(client)
  end

  test "push returns an unexpected_reply error for off-protocol success frames" do
    port = start_bad_push_server()
    node_b = identity("node_b")
    node_a = identity("node_a")

    assert {:ok, conn} =
             WsCarrier.connect(
               port: port,
               identity: node_b,
               realm: "node_b",
               peer_realm: "node_a",
               peer_pubkey: node_a.pub,
               replica: @replica
             )

    op = Lattice.Op.new(node_b, @replica, [], :command, {:post, "hello"})

    assert {:error, {:unexpected_reply, "status_result"}} = WsCarrier.push(conn, [op])
    :ok = WsCarrier.close(conn)
  end

  test "push rejects a single op that exceeds the frame byte budget" do
    port = start_bad_push_server()
    node_b = identity("node_b")
    node_a = identity("node_a")

    assert {:ok, conn} =
             WsCarrier.connect(
               port: port,
               identity: node_b,
               realm: "node_b",
               peer_realm: "node_a",
               peer_pubkey: node_a.pub,
               replica: @replica
             )

    op = Lattice.Op.new(node_b, @replica, [], :command, {:post, String.duplicate("x", 70_000)})

    assert {:error, {:oversized_item, _bytes, 64_000}} = WsCarrier.push(conn, [op])
    :ok = WsCarrier.close(conn)
  end

  test "push batches keep the complete request frame within the byte budget" do
    port = start_peer_server()
    node_b = identity("node_b")
    node_a = identity("node_a")

    assert {:ok, conn} =
             WsCarrier.connect(
               port: port,
               identity: node_b,
               realm: "node_b",
               peer_realm: "node_a",
               peer_pubkey: node_a.pub,
               replica: @replica
             )

    ops =
      for i <- 1..80 do
        Op.new(node_b, @replica, [], :command, {:post, String.duplicate("x", 542) <> "#{i}"})
      end

    assert {:ok, _report, conn} = WsCarrier.push(conn, ops)
    assert Enum.all?(WsCarrier.last_push_batches(conn), &(&1.bytes <= 64_000))

    :ok = WsCarrier.close(conn)
  end

  test "an availability notification cannot displace a carrier request reply" do
    port = start_feed_server()
    node_b = identity("node_b")
    node_a = identity("node_a")

    assert {:ok, conn} =
             WsCarrier.connect(
               port: port,
               identity: node_b,
               realm: "node_b",
               peer_realm: "node_a",
               peer_pubkey: node_a.pub,
               replica: @replica
             )

    subscription = make_ref()

    assert {:ok, %{ref: ^subscription, generation: 1}, conn} =
             WsCarrier.subscribe(conn, self(), subscription)

    assert {:ok, %{ref: ^subscription, generation: 1}} = WsCarrier.subscription(conn)
    empty = MapSet.new()
    assert {:ok, ^empty, conn} = WsCarrier.advertise(conn, Log.new(@replica))

    assert_receive {:lattice_carrier, ^subscription,
                    %{"type" => "ops_available", "generation" => 2}}

    assert {:ok, conn} = WsCarrier.unsubscribe(conn)
    assert :none = WsCarrier.subscription(conn)
    assert :ok = WsCarrier.close(conn)
  end

  defp start_peer_server do
    {:ok, peer} =
      Peer.start_link(
        realm: "node_a",
        identity: identity("node_a"),
        name: :"peer_#{System.unique_integer([:positive])}"
      )

    {:ok, port} =
      PeerServer.start(peer,
        trusted_peer_realm: "node_b",
        trusted_peer_pubkey: identity("node_b").pub
      )

    on_exit(fn -> _ = PeerServer.stop() end)
    port
  end

  defp start_bad_push_server do
    listener = :"bad_push_#{System.unique_integer([:positive])}"
    identity = identity("node_a")

    dispatch =
      :cowboy_router.compile([
        {:_, [{"/carrier", __MODULE__.BadPushHandler, %{realm: "node_a", identity: identity}}]}
      ])

    {:ok, _pid} = :cowboy.start_clear(listener, [port: 0], %{env: %{dispatch: dispatch}})
    on_exit(fn -> _ = :cowboy.stop_listener(listener) end)
    :ranch.get_port(listener)
  end

  defp start_feed_server do
    listener = :"feed_#{System.unique_integer([:positive])}"
    identity = identity("node_a")

    dispatch =
      :cowboy_router.compile([
        {:_, [{"/carrier", __MODULE__.FeedHandler, %{realm: "node_a", identity: identity}}]}
      ])

    {:ok, _pid} = :cowboy.start_clear(listener, [port: 0], %{env: %{dispatch: dispatch}})
    on_exit(fn -> _ = :cowboy.stop_listener(listener) end)
    :ranch.get_port(listener)
  end

  defp identity(realm), do: Identity.from_seed(realm, "carrier-spike")

  defmodule BadPushHandler do
    @behaviour :cowboy_websocket

    alias Lattice.Carrier.Session

    @impl :cowboy_websocket
    def init(req, state), do: {:cowboy_websocket, req, state}

    @impl :cowboy_websocket
    def websocket_init(state), do: {:ok, state}

    @impl :cowboy_websocket
    def websocket_handle({:text, text}, state) do
      reply =
        case Jason.decode(text) do
          {:ok, %{"type" => "carrier_challenge"} = challenge} ->
            Session.respond(challenge, state.identity, state.realm)

          {:ok, %{"type" => "push"}} ->
            %{type: "status_result", phase: "base"}

          _other ->
            %{type: "error", reason: "unexpected_test_message"}
        end

      {:reply, {:text, Jason.encode!(reply)}, state}
    end

    def websocket_handle(_frame, state) do
      {:reply, {:text, Jason.encode!(%{type: "error", reason: "unsupported_frame"})}, state}
    end

    @impl :cowboy_websocket
    def websocket_info(_message, state), do: {:ok, state}
  end

  defmodule FeedHandler do
    @behaviour :cowboy_websocket

    alias Lattice.Carrier.Session

    @impl :cowboy_websocket
    def init(req, state), do: {:cowboy_websocket, req, state}

    @impl :cowboy_websocket
    def websocket_init(state), do: {:ok, state}

    @impl :cowboy_websocket
    def websocket_handle({:text, text}, state) do
      case Jason.decode(text) do
        {:ok, %{"type" => "carrier_challenge"} = challenge} ->
          reply = Session.respond(challenge, state.identity, state.realm)
          {:reply, {:text, Jason.encode!(reply)}, state}

        {:ok, %{"type" => "subscribe"}} ->
          reply = %{
            type: "subscribe_result",
            generation: 1,
            frontier: [],
            frontier_truncated: false
          }

          {:reply, {:text, Jason.encode!(reply)}, state}

        {:ok, %{"type" => "frontier"}} ->
          notification = %{type: "ops_available", generation: 2, frontier: []}
          response = %{type: "frontier_result", ids: []}

          {:reply,
           [
             {:text, Jason.encode!(notification)},
             {:text, Jason.encode!(response)}
           ], state}

        {:ok, %{"type" => "unsubscribe"}} ->
          {:reply, {:text, Jason.encode!(%{type: "unsubscribe_result"})}, state}

        _other ->
          {:reply, {:text, Jason.encode!(%{type: "error", reason: "unexpected_test_message"})},
           state}
      end
    end

    def websocket_handle(_frame, state) do
      {:reply, {:text, Jason.encode!(%{type: "error", reason: "unsupported_frame"})}, state}
    end

    @impl :cowboy_websocket
    def websocket_info(_message, state), do: {:ok, state}
  end
end
