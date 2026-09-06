defmodule LatticeCarrierServer.PaginationTest do
  use ExUnit.Case, async: true

  alias Lattice.Carrier.WebSocket, as: CarrierClient
  alias Lattice.Carrier.Wire
  alias Lattice.{Identity, Log, Op, Sync}
  alias LatticeCarrierServer.{Holder, WebSocket}

  @replica "replica:carrier-pagination:test"

  test "a normal history exceeding one frame is served as a bounded nonempty page" do
    log = large_log(200)
    holder = start_holder(log)
    original = %{type: "ops", ops: Enum.map(Log.topo_ops(log), &Wire.encode_op/1)}
    assert byte_size(Jason.encode!(original)) > 64_000

    response = request(holder, %{type: "pull", have: []})

    assert byte_size(response) <= 64_000,
           "pull response exceeds the frame budget: #{byte_size(response)} bytes"

    assert %{"type" => "ops", "ops" => [_first | _rest], "next_cursor" => cursor} =
             Jason.decode!(response)

    assert is_map(cursor)
  end

  test "a production BEAM client collects every frontier and pull page before returning" do
    log = large_log(1_500)
    server_identity = Identity.from_seed("pagination-server", "pagination-server-probe")
    identity = Identity.from_seed("pagination-observer", "pagination-observer-probe")
    instance = {:pagination, make_ref()}

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{identity.realm_id => identity.pub},
       source: {:log, log},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    assert {:ok, conn} =
             CarrierClient.connect(
               hostname: "127.0.0.1",
               port: LatticeCarrierServer.port(instance),
               identity: identity,
               realm: identity.realm_id,
               peer_realm: server_identity.realm_id,
               peer_pubkey: server_identity.pub,
               replica: @replica
             )

    assert {:ok, ids, conn} = CarrierClient.advertise(conn, Log.new(@replica))
    assert MapSet.size(ids) == 1_500
    assert {:ok, ops, conn} = CarrierClient.pull(conn, MapSet.new())
    assert ops == Log.topo_ops(log)

    # Large local have sets also exceed one ingress frame. Replay remains verified
    # and idempotent when the client falls back to a bounded full-history request.
    assert {:ok, duplicate_ops, conn} = CarrierClient.pull(conn, Log.op_ids(log))
    {unchanged, report} = Sync.deliver(log, duplicate_ops)
    assert Log.op_ids(unchanged) == Log.op_ids(log)
    assert report.rejected == []
    assert :ok = CarrierClient.close(conn)
  end

  test "continuations deterministically drain the complete causal history" do
    log = large_log(200)
    holder = start_holder(log)
    initial = %{type: "pull", have: []}
    assert request(holder, initial) == request(holder, initial)

    pages = drain_pages(holder, initial)
    assert length(pages) > 1
    assert Enum.all?(pages, &(byte_size(&1) <= 64_000))
    encoded_ops = Enum.flat_map(pages, &Jason.decode!(&1)["ops"])
    assert encoded_ops == Enum.map(Log.topo_ops(log), &Wire.encode_op/1)
  end

  test "explicit null cursors refuse while omitted cursors retain legacy reads" do
    holder = start_holder(large_log(2))

    for message <- [%{type: "frontier"}, %{type: "pull", have: []}] do
      refute holder |> request(message) |> Jason.decode!() |> Map.has_key?("reason")

      assert %{"type" => "error", "reason" => "malformed_cursor"} =
               holder |> request(Map.put(message, :cursor, nil)) |> Jason.decode!()
    end
  end

  test "a legacy client ignoring cursors drains a dependent chain through causal prefixes" do
    log = large_log(200)
    holder = start_holder(log)

    restored =
      Enum.reduce_while(1..10, Log.new(@replica), fn _round, restored ->
        reply = request(holder, %{type: "pull", have: Enum.sort(Log.op_ids(restored))})
        assert {:ok, ops} = Wire.decode_ops(Jason.decode!(reply)["ops"])
        {next, report} = Sync.deliver(restored, ops)
        assert report.pending == []
        assert Log.size(next) > Log.size(restored)

        if Log.size(next) == Log.size(log), do: {:halt, next}, else: {:cont, next}
      end)

    assert Log.op_ids(restored) == Log.op_ids(log)
  end

  test "mature frontier replies are also byte-budgeted and complete" do
    log = large_log(1_500)
    holder = start_holder(log)
    original = %{type: "frontier_result", ids: Enum.sort(Log.op_ids(log))}
    assert byte_size(Jason.encode!(original)) > 64_000

    pages = drain_pages(holder, %{type: "frontier"})
    assert length(pages) > 1
    assert Enum.all?(pages, &(byte_size(&1) <= 64_000))
    assert Enum.flat_map(pages, &Jason.decode!(&1)["ids"]) == Enum.sort(Log.op_ids(log))
  end

  test "a continuation refuses changed filters, snapshots and invalid membership" do
    log = large_log(200)
    holder = start_holder(log)
    initial = %{type: "pull", have: []}
    first = holder |> request(initial) |> Jason.decode!()
    cursor = first["next_cursor"]
    first_id = hd(first["ops"])["id"]

    for message <- [
          %{type: "pull", have: [first_id], cursor: cursor},
          %{type: "frontier", cursor: Map.delete(cursor, "have")}
        ] do
      assert %{"type" => "error", "reason" => "stale_cursor"} =
               holder |> request(message) |> Jason.decode!()
    end

    for invalid <- [
          "opaque",
          Map.put(cursor, "offset", 0),
          Map.put(cursor, "offset", 1.5),
          Map.put(cursor, "offset", 201),
          Map.put(cursor, "after", first_id),
          Map.put(cursor, "snapshot", String.duplicate("x", 513)),
          Map.put(cursor, "extra", true)
        ] do
      assert %{"type" => "error", "reason" => "malformed_cursor"} =
               holder |> request(Map.put(initial, :cursor, invalid)) |> Jason.decode!()
    end

    author = Identity.from_seed("pagination-author", "pagination-author-probe")
    op = Op.new(author, @replica, Log.frontier(log), :command, {:post, "new append"})
    changed_holder = start_holder(Log.append!(log, op))

    assert %{"type" => "error", "reason" => "stale_cursor"} =
             changed_holder |> request(Map.put(initial, :cursor, cursor)) |> Jason.decode!()

    restarted_holder = start_holder(log)

    assert request(restarted_holder, Map.put(initial, :cursor, cursor)) ==
             request(holder, Map.put(initial, :cursor, cursor))
  end

  test "one oversized operation is emitted once and is an explicit unsyncable limit" do
    author = Identity.from_seed("pagination-author", "pagination-oversized-probe")
    op = Op.new(author, @replica, [], :command, {:post, String.duplicate("x", 64_000)})
    holder = start_holder(Log.append!(Log.new(@replica), op))
    response = request(holder, %{type: "pull", have: []})
    assert byte_size(response) > 64_000
    assert %{"type" => "ops", "ops" => [encoded]} = Jason.decode!(response)
    assert encoded == Wire.encode_op(op)
    refute Map.has_key?(Jason.decode!(response), "next_cursor")
  end

  defp drain_pages(holder, initial, cursor \\ nil, pages \\ []) do
    assert length(pages) < 20
    message = if cursor, do: Map.put(initial, :cursor, cursor), else: initial
    response = request(holder, message)

    case Jason.decode!(response) do
      %{"next_cursor" => next} -> drain_pages(holder, initial, next, [response | pages])
      _terminal -> Enum.reverse([response | pages])
    end
  end

  defp request(holder, message) do
    state = %{authenticated?: true, holder: holder}

    assert {:reply, {:text, response}, ^state} =
             WebSocket.websocket_handle({:text, Jason.encode!(message)}, state)

    response
  end

  defp start_holder(log) do
    start_supervised!(
      Supervisor.child_spec(
        {Holder,
         name: {:global, {__MODULE__, make_ref()}},
         identity: Identity.from_seed("pagination-server", "pagination-server-probe"),
         source: {:log, log},
         relay_realms: []},
        id: make_ref()
      )
    )
  end

  defp large_log(count) do
    author = Identity.from_seed("pagination-author", "pagination-author-probe")

    {log, _deps} =
      Enum.reduce(1..count, {Log.new(@replica), []}, fn index, {log, deps} ->
        body = {:post, "#{index}: #{String.duplicate("ordinary post text ", 24)}"}
        op = Op.new(author, @replica, deps, :command, body)
        {Log.append!(log, op), [op.id]}
      end)

    log
  end
end
