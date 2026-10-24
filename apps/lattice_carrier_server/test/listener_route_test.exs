defmodule LatticeCarrierServer.ListenerRouteTest do
  @moduledoc """
  A routed instance is reachable at "/carrier" and at its catalog route through
  the same trusted-peer gate; any other path is refused (plan 224 PR 2, S2).
  """

  use ExUnit.Case, async: false

  alias Lattice.Carrier.WebSocket
  alias Lattice.{Identity, Log, Op}

  @replica "replica:carrier-server:route-test"
  @route "/r/" <> Base.url_encode64(:crypto.hash(:sha256, "listener-route"), padding: false)

  defp start_instance(listener) do
    author = Identity.from_seed("author", "route-test-author")
    server = Identity.from_seed("service", "route-test-server")
    client = Identity.from_seed("member", "route-test-client")
    op = Op.new(author, @replica, [], :command, {:post, "served"})
    log = @replica |> Log.new() |> Log.append!(op)
    instance = {:route_test, System.unique_integer([:positive])}

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server,
       trusted_peers: %{client.realm_id => client.pub},
       source: {:log, log},
       listener: [ip: {127, 0, 0, 1}, port: 0] ++ listener}
    )

    %{port: LatticeCarrierServer.port(instance), server: server, client: client, op: op}
  end

  defp connect(f, path, identity \\ nil) do
    identity = identity || f.client

    WebSocket.connect(
      hostname: "127.0.0.1",
      port: f.port,
      path: path,
      identity: identity,
      realm: identity.realm_id,
      peer_realm: f.server.realm_id,
      peer_pubkey: f.server.pub,
      replica: @replica
    )
  end

  test "both /carrier and the route authenticate and serve the same frontier" do
    f = start_instance(route: @route)

    for path <- ["/carrier", @route] do
      assert {:ok, conn} = connect(f, path)
      assert {:ok, ids, conn} = WebSocket.advertise(conn, Log.new(@replica))
      assert ids == MapSet.new([f.op.id])
      assert {:ok, [pulled], conn} = WebSocket.pull(conn, MapSet.new())
      assert pulled == f.op
      assert :ok = WebSocket.close(conn)
    end
  end

  test "an unknown path is refused and an untrusted peer is refused on the route" do
    f = start_instance(route: @route)
    other = "/r/" <> Base.url_encode64(:crypto.hash(:sha256, "other"), padding: false)

    assert {:error, _} = refused(f, other)
    assert {:error, _} = refused(f, "/")

    stranger = Identity.from_seed("stranger", "route-test-stranger")
    assert {:error, _} = refused(f, @route, stranger)
  end

  test "an instance without a route serves only /carrier" do
    f = start_instance([])

    assert {:ok, conn} = connect(f, "/carrier")
    assert :ok = WebSocket.close(conn)
    assert {:error, _} = refused(f, @route)
  end

  # A refused upgrade kills the linked transport process, so a refused dial
  # runs where that exit cannot reach the test process.
  defp refused(f, path, identity \\ nil) do
    parent = self()

    {pid, ref} =
      spawn_monitor(fn ->
        Process.flag(:trap_exit, true)

        result =
          case connect(f, path, identity) do
            {:ok, conn} ->
              outcome = WebSocket.advertise(conn, Log.new(@replica))
              WebSocket.close(conn)
              if match?({:ok, _, _}, outcome), do: :connected, else: {:error, :unauthenticated}

            {:error, _} = error ->
              error
          end

        send(parent, {:dialed, self(), result})
      end)

    receive do
      {:dialed, ^pid, :connected} -> :connected
      {:dialed, ^pid, result} -> result
      {:DOWN, ^ref, :process, ^pid, reason} -> {:error, reason}
    after
      5_000 -> flunk("dial did not finish")
    end
  end
end
