defmodule Lattice.CarrierWireTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Lattice.Authority.Delegation
  alias Lattice.{Canonical, Identity, Op}
  alias Lattice.Carrier.{Protocol, Wire}

  @atoms [:admit, :clerk, :join, :leave, :moderator, :post, :set_summary, :set_title]
  @roles [:admin, :clerk, :member, :moderator]

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

  test "delegation wire frames sort ops and roles deterministically" do
    issuer = Identity.from_seed("issuer", "carrier-wire-delegation-order")
    audience = Identity.from_seed("audience", "carrier-wire-delegation-order")

    delegation =
      Delegation.new(issuer, "replica:wire", audience.pub,
        ops: [:post, :join, :leave, :set_title],
        roles: [:moderator, :clerk, :admin, :member]
      )

    op = Op.new(issuer, "replica:wire", [], :authority, {:grant, delegation})
    encoded_delegation = op |> Wire.encode_op() |> encoded_delegation()

    assert encoded_delegation["ops"] == ["join", "leave", "post", "set_title"]
    assert encoded_delegation["roles"] == ["admin", "clerk", "member", "moderator"]
  end

  test "map wire frames sort pairs by canonical key bytes" do
    id = Identity.from_seed("alice", "carrier-wire-map-order")
    op = Op.new(id, "replica:wire", [], :command, %{z: 1, a: 2, m: 3, b: 4})

    assert op |> Wire.encode_op() |> encoded_map_keys() == ["a", "b", "m", "z"]
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

    for field <- ["quarantined", "rejected"] do
      frame = %{
        "accepted" => [],
        "quarantined" => [],
        "rejected" => [],
        "pending" => []
      }

      assert {:error, :malformed_term} = frame |> Map.put(field, 123) |> Wire.decode_report()
    end
  end

  test "stats frame is JSON-safe" do
    report = %{accepted: [], quarantined: [], rejected: [], pending: []}
    frame = Protocol.push_result(report)

    assert frame["type"] == "push_result"
    assert frame["accepted"] == []
    assert frame["quarantined"] == []
    assert :erlang.apply(Wire, :encode_push_result, [report]) == frame
  end

  property "op wire round-trip preserves body, cap, validity, and canonical payload" do
    check all(op <- valid_op_gen()) do
      assert {:ok, decoded} = op |> Wire.encode_op() |> Wire.decode_op()
      assert decoded.body == op.body
      assert decoded.cap == op.cap
      assert Op.valid?(decoded)
      assert Canonical.op_payload(decoded) == Canonical.op_payload(op)
    end
  end

  property "delegation wire round-trip is deterministic and validity-preserving" do
    check all(
            ops <- atom_set_gen(@atoms),
            roles <- atom_set_gen(@roles)
          ) do
      issuer = Identity.from_seed("issuer", "carrier-wire-delegation-property")
      audience = Identity.from_seed("audience", "carrier-wire-delegation-property")
      delegation = Delegation.new(issuer, "replica:wire", audience.pub, ops: ops, roles: roles)
      op = Op.new(issuer, "replica:wire", [], :authority, {:grant, delegation})

      frame = Wire.encode_op(op)

      assert frame == Wire.encode_op(op)
      assert encoded_delegation(frame)["ops"] == ops |> Enum.sort() |> Enum.map(&Atom.to_string/1)

      assert encoded_delegation(frame)["roles"] ==
               roles |> Enum.sort() |> Enum.map(&Atom.to_string/1)

      assert {:ok, decoded} = Wire.decode_op(frame)
      assert decoded.body == op.body
      assert Op.valid?(decoded)
    end
  end

  defp put_delegation_field(frame, field, value) do
    put_in(frame, ["body", Access.at(1), Access.at(1), Access.at(1), field], value)
  end

  defp encoded_delegation(frame) do
    get_in(frame, ["body", Access.at(1), Access.at(1), Access.at(1)])
  end

  defp encoded_map_keys(frame) do
    frame
    |> get_in(["body", Access.at(1)])
    |> Enum.map(fn [["atom", key], _value] -> key end)
  end

  defp valid_op_gen do
    gen all(
          author <- member_of(["alice", "bob", "carol"]),
          body <- wire_term_gen(),
          cap <- wire_term_gen()
        ) do
      identity = Identity.from_seed(author, "carrier-wire-property")
      Op.new(identity, "replica:wire-property", [], :command, body, cap: cap)
    end
  end

  defp wire_term_gen do
    tree(wire_leaf_gen(), fn child ->
      one_of([
        list_of(child, max_length: 6),
        map(list_of(child, max_length: 4), &List.to_tuple/1),
        map_of(wire_leaf_gen(), child, max_length: 6),
        map(list_of(child, max_length: 6), &MapSet.new/1)
      ])
    end)
  end

  defp wire_leaf_gen do
    one_of([
      constant(nil),
      boolean(),
      integer(0..1000),
      binary(max_length: 12),
      member_of(@atoms)
    ])
  end

  defp atom_set_gen(atoms) do
    map(list_of(member_of(atoms), max_length: length(atoms) * 2), &Enum.uniq/1)
  end
end
