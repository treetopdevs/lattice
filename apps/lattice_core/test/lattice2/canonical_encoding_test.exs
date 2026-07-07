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

  test "tagged canonical values cannot collide with plain user lists" do
    assert Canonical.term(:post) != Canonical.term(["atom", "post"])
    assert Canonical.term({:post, "hello"}) != Canonical.term(["tuple", [:post, "hello"]])

    id = Identity.from_seed("alice", "m2-canonical-tags")
    op = Op.new(id, "replica:m2", [], :command, :post)
    tampered = %{op | body: ["atom", "post"]}

    refute Op.valid?(tampered)
  end

  test "integers outside the uint64 canonical range are rejected instead of truncated" do
    assert is_binary(Canonical.term(Integer.pow(2, 64) - 1))

    assert_raise ArgumentError, ~r/unsupported canonical integer/, fn ->
      Canonical.term(Integer.pow(2, 64))
    end
  end

  test "mapset canonical order is portable and sorted by encoded bytes" do
    set = MapSet.new([1, :a, "a"])
    encoded_terms = Enum.sort(Enum.map(MapSet.to_list(set), &Canonical.term/1))

    assert Canonical.term(set) == <<0xD9, 0xEA, 0x62, 0x83>> <> IO.iodata_to_binary(encoded_terms)
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
