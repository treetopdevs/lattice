defmodule Lattice.CanonicalEncodingTest do
  use ExUnit.Case, async: true

  alias Lattice.Authority.Delegation
  alias Lattice.{Canonical, Identity, Op}

  test "map insertion order does not change canonical bytes" do
    left = %{b: 2, a: 1, nested: %{z: "z", a: "a"}}
    right = %{nested: %{a: "a", z: "z"}, a: 1, b: 2}

    assert Canonical.term(left) == Canonical.term(right)
  end

  test "unsupported local terms are rejected before signing" do
    assert_raise ArgumentError, ~r/unsupported canonical term/, fn ->
      Canonical.term({:bad, self()})
    end

    assert_raise ArgumentError, ~r/unsupported canonical term/, fn ->
      Canonical.term({:bad, make_ref()})
    end
  end

  test "op id and signature use canonical bytes" do
    id = Identity.from_seed("alice", "m2-canonical")
    op = Op.new(id, "replica:m2", ["b", "a", "a"], :command, {:post, "hi"}, cap: %{d: "cap"})

    assert op.deps == ["a", "b"]
    assert Op.valid?(op)
    assert Op.canonical_encoding(op) == Canonical.op_payload(op)
    assert Op.recompute_id(op) == op.id
  end

  test "authority op bodies can contain signed delegations" do
    issuer = Identity.from_seed("issuer", "m2-canonical")
    audience = Identity.from_seed("audience", "m2-canonical")
    delegation = Delegation.new(issuer, "replica:m2", audience.pub, ops: [:post])

    op = Op.new(issuer, "replica:m2", [], :authority, {:grant, delegation})

    assert Op.valid?(op)
    assert Op.recompute_id(op) == op.id
  end

  test "delegation id and signature use canonical bytes" do
    issuer = Identity.from_seed("issuer", "m2-canonical")
    audience = Identity.from_seed("audience", "m2-canonical")

    d1 =
      Delegation.new(issuer, "replica:m2", audience.pub, ops: [:post, :join], roles: [:moderator])

    d2 = %{d1 | ops: MapSet.new([:join, :post]), roles: MapSet.new([:moderator])}

    assert Delegation.valid_sig?(d1)
    assert Delegation.valid_sig?(d2)
    assert d1.id == d2.id
  end
end
