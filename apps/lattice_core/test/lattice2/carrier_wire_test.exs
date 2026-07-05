defmodule Lattice.CarrierWireTest do
  use ExUnit.Case, async: true

  alias Lattice.{Carrier.Wire, Identity, Op}

  test "op frames round-trip without deciding integrity" do
    id = Identity.from_seed("alice", "carrier-wire")
    op = Op.new(id, "replica:wire", [], :command, {:post, "hello"})

    assert {:ok, ^op} = op |> Wire.encode_op() |> Wire.decode_op()
  end

  test "malformed op frame is rejected before Log.accept" do
    assert {:error, :malformed_op} = Wire.decode_op(%{"v" => 1, "kind" => "not_existing"})
    assert {:error, :malformed_op} = Wire.decode_op(%{"v" => 99})
  end

  test "reports round-trip with existing atoms only" do
    report = %{
      accepted: ["a"],
      quarantined: [{"b", :bad_signature}],
      rejected: [],
      pending: ["c"]
    }

    assert Wire.decode_report(Wire.encode_report(report)) == report
  end

  test "stats frame is JSON-safe" do
    report = %{accepted: [], quarantined: [], rejected: [], pending: []}
    frame = Wire.encode_push_result(report)

    assert frame["type"] == "push_result"
    assert frame["accepted"] == []
    assert frame["quarantined"] == []
  end
end
