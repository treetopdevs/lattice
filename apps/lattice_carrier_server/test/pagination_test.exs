defmodule LatticeCarrierServer.PaginationTest do
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Wire
  alias Lattice.{Identity, Log, Op}
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

  defp request(holder, message) do
    state = %{authenticated?: true, holder: holder}

    assert {:reply, {:text, response}, ^state} =
             WebSocket.websocket_handle({:text, Jason.encode!(message)}, state)

    response
  end

  defp start_holder(log) do
    start_supervised!(
      {Holder,
       name: {:global, {__MODULE__, make_ref()}},
       identity: Identity.from_seed("pagination-server", "pagination-server-probe"),
       source: {:log, log},
       relay_realms: []}
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
