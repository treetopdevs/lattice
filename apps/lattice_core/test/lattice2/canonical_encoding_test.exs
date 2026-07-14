defmodule Lattice.CanonicalEncodingTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Lattice.Authority.Delegation
  alias Lattice.{Canonical, Identity, Op}
  alias Lattice.Canonical.Atom, as: CanonicalAtom

  @atoms [:admit, :clerk, :join, :leave, :moderator, :post, :set_summary, :set_title]

  test "map insertion order does not change canonical bytes" do
    left = %{b: 2, a: 1, nested: %{z: "z", a: "a"}}
    right = %{nested: %{a: "a", z: "z"}, a: 1, b: 2}

    assert Canonical.term(left) == Canonical.term(right)
  end

  test "atom-name tokens cannot alias canonical map keys or mapset elements" do
    token = %CanonicalAtom{name: "collision"}

    refute Canonical.signable?(%{:collision => 1, token => 2})
    refute Canonical.signable?(MapSet.new([:collision, token]))

    assert_raise ArgumentError, ~r/duplicate canonical map key/, fn ->
      Canonical.term(%{:collision => 1, token => 2})
    end

    assert_raise ArgumentError, ~r/duplicate canonical mapset element/, fn ->
      Canonical.term(MapSet.new([:collision, token]))
    end
  end

  test "ops reject bodies whose distinct terms have the same canonical bytes" do
    identity = Identity.from_seed("alice", "m4-canonical-collision")
    token = %CanonicalAtom{name: "collision"}

    assert_raise ArgumentError, ~r/duplicate canonical map key/, fn ->
      Op.new(identity, "replica:m4", [], :command, %{:collision => 1, token => 2})
    end
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

  property "canonical encoding is deterministic for generated signable terms" do
    check all(term <- signable_term_gen()) do
      assert Canonical.term(term) == Canonical.term(term)
    end
  end

  property "map insertion order does not change generated canonical bytes" do
    check all(map <- map_of(signable_leaf_gen(), signable_term_gen(), max_length: 6)) do
      reversed = map |> Map.to_list() |> Enum.reverse() |> Map.new()

      assert Canonical.term(map) == Canonical.term(reversed)
    end
  end

  property "canonical encoding is injective on distinct generated terms" do
    check all(a <- signable_term_gen(), b <- signable_term_gen()) do
      assert a == b or Canonical.term(a) != Canonical.term(b)
    end
  end

  defp signable_term_gen do
    tree(signable_leaf_gen(), fn child ->
      one_of([
        list_of(child, max_length: 6),
        map(list_of(child, max_length: 4), &List.to_tuple/1),
        map_of(signable_leaf_gen(), child, max_length: 6),
        map(list_of(child, max_length: 6), &MapSet.new/1)
      ])
    end)
  end

  defp signable_leaf_gen do
    one_of([
      constant(nil),
      boolean(),
      integer(0..1000),
      binary(max_length: 12),
      member_of(@atoms)
    ])
  end
end
