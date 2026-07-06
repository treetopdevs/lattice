defmodule Lattice.CarrierWireTest do
  use ExUnit.Case, async: true

  alias Lattice.Authority.Delegation
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

  test "op frames reject terms outside the canonical signable domain" do
    id = Identity.from_seed("alice", "carrier-wire-negative")
    op = Op.new(id, "replica:wire", [], :command, {:count, 1})

    frame =
      op
      |> Wire.encode_op()
      |> put_in(["body"], ["tuple", [["atom", "count"], ["int", -1]]])

    assert {:error, :malformed_op} = Wire.decode_op(frame)
  end

  test "op frames normalize malformed nested binary terms" do
    id = Identity.from_seed("alice", "carrier-wire-malformed-bin")
    op = Op.new(id, "replica:wire", [], :command, {:post, "hello"})

    frame =
      op
      |> Wire.encode_op()
      |> put_in(["body"], ["tuple", [["atom", "post"], ["bin", "not base64"]]])

    assert {:error, :malformed_op} = Wire.decode_op(frame)
  end

  test "op frames normalize malformed delegation fields" do
    issuer = Identity.from_seed("alice", "carrier-wire-bad-delegation")
    audience = Identity.from_seed("bob", "carrier-wire-bad-delegation")
    delegation = Delegation.new(issuer, "replica:wire", audience.pub, ops: [:post])
    op = Op.new(issuer, "replica:wire", [], :authority, {:grant, delegation})
    frame = Wire.encode_op(op)

    for {field, value} <- [
          {"issuer", "not base64"},
          {"audience", "not base64"},
          {"sig", "not base64"},
          {"ops", ["definitely_not_an_existing_atom"]},
          {"roles", [123]}
        ] do
      assert {:error, :malformed_op} =
               frame
               |> put_delegation_field(field, value)
               |> Wire.decode_op()
    end
  end

  test "large integers are encoded as decimal strings so JSON peers preserve precision" do
    id = Identity.from_seed("alice", "carrier-wire-large-int")
    large = Integer.pow(2, 53) + 1
    op = Op.new(id, "replica:wire", [], :command, {:count, large})

    frame = Wire.encode_op(op)
    large_string = Integer.to_string(large)

    assert ["tuple", [["atom", "count"], ["int", ^large_string]]] = frame["body"]
    assert {:ok, ^op} = frame |> Jason.encode!() |> Jason.decode!() |> Wire.decode_op()
  end

  test "reports round-trip with existing atoms only" do
    report = %{
      accepted: ["a"],
      quarantined: [{"b", :bad_signature}],
      rejected: [],
      pending: ["c"]
    }

    assert {:ok, ^report} = Wire.decode_report(Wire.encode_report(report))
  end

  test "malformed report reason pairs return errors instead of raising" do
    assert {:error, :malformed_term} =
             Wire.decode_report(%{
               "accepted" => [],
               "quarantined" => [["id", "definitely_not_an_existing_atom"]],
               "rejected" => [],
               "pending" => []
             })

    assert {:error, :malformed_term} =
             Wire.decode_report(%{
               "accepted" => [],
               "quarantined" => [["id"]],
               "rejected" => [],
               "pending" => []
             })
  end

  test "stats frame is JSON-safe" do
    report = %{accepted: [], quarantined: [], rejected: [], pending: []}
    frame = Wire.encode_push_result(report)

    assert frame["type"] == "push_result"
    assert frame["accepted"] == []
    assert frame["quarantined"] == []
  end

  defp put_delegation_field(frame, field, value) do
    put_in(frame, ["body", Access.at(1), Access.at(1), Access.at(1), field], value)
  end
end
