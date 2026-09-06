defmodule Lattice2.DelegationLeaseTest do
  @moduledoc """
  Plan 149 steps 1–2 — delegation leases: the `expires_epoch` field, the
  `lattice-delegation-v3` canonical arm (used ONLY when a lease is set), and
  expiry narrowing in attenuation. The v2 bytes for unleased delegations must
  remain byte-identical — that is the wire-compat proof.
  """
  use ExUnit.Case, async: true

  alias Lattice.Authority.Delegation
  alias Lattice.{Canonical, Identity}

  @replica "replica:lease-test"

  defp issuer, do: Identity.from_seed("issuer", "lease:issuer")
  defp audience, do: Identity.from_seed("audience", "lease:audience")

  test "an unleased delegation keeps the v2 bytes, id, and signature exactly" do
    d = Delegation.new(issuer(), @replica, audience().pub, ops: [:post])

    v2 =
      Canonical.delegation_bytes(
        @replica,
        issuer().pub,
        audience().pub,
        nil,
        d.ops,
        d.roles,
        d.live
      )

    assert d.expires_epoch == nil
    assert d.id == :crypto.hash(:sha256, v2) |> Base.url_encode64(padding: false)
    assert Identity.verify(issuer().pub, v2, d.sig)
    assert Delegation.valid_sig?(d)
  end

  test "a leased delegation carries expires_epoch and hashes the v3 arm" do
    d = Delegation.new(issuer(), @replica, audience().pub, ops: [:post], expires_epoch: 3)

    v3 =
      Canonical.delegation_bytes(
        @replica,
        issuer().pub,
        audience().pub,
        nil,
        d.ops,
        d.roles,
        d.live,
        3
      )

    assert d.expires_epoch == 3
    assert d.id == :crypto.hash(:sha256, v3) |> Base.url_encode64(padding: false)
    assert Delegation.valid_sig?(d)

    unleased = Delegation.new(issuer(), @replica, audience().pub, ops: [:post])
    assert d.id != unleased.id, "the lease must be inside the hashed content"
  end

  test "tampering with expires_epoch breaks valid_sig?" do
    d = Delegation.new(issuer(), @replica, audience().pub, ops: [:post], expires_epoch: 3)

    refute Delegation.valid_sig?(%{d | expires_epoch: 9})
    refute Delegation.valid_sig?(%{d | expires_epoch: nil})
  end

  test "an out-of-range in-VM lease fails signature validation without raising" do
    delegation =
      Delegation.new(issuer(), @replica, audience().pub,
        ops: [:post],
        expires_epoch: Canonical.max_integer()
      )

    assert Delegation.valid_sig?(delegation)
    refute Delegation.valid_sig?(%{delegation | expires_epoch: Canonical.max_integer() + 1})
  end

  test "a reconstructed grant with an out-of-range lease quarantines without crashing reduction" do
    alias Lattice.{Authority, Log, Sim}
    alias Lattice.Demo.Thread

    sim = Sim.new(Thread, @replica, ["issuer", "audience"], seed: "invalid-lease-reconstruction")
    {sim, _genesis} = Sim.create_replica(sim, "issuer")
    {sim, delegation} = Sim.grant(sim, "issuer", "audience", ops: [:post], expires_epoch: 3)
    log = Sim.log(sim, "issuer")
    grant = Enum.find(Log.topo_ops(log), &(&1.body == {:grant, delegation}))

    malformed = %{
      grant
      | body: {:grant, %{delegation | expires_epoch: Canonical.max_integer() + 1}}
    }

    reconstructed = Log.from_ops(log.replica, Map.put(log.ops, grant.id, malformed))

    assert Authority.analyze(Thread, reconstructed).reasons[grant.id] == :bad_delegation_sig
    assert Lattice.state(Thread, reconstructed) == Lattice.state(Thread, log)
  end

  test "a signed four-field beacon stays stored but cannot lapse a lease" do
    alias Lattice.{Authority, Sim}
    alias Township.Matter

    sim = Sim.new(Matter, @replica, ["clerk", "resident"], seed: "beacon-arity")
    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, delegation} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 3)
    {sim, malformed} = Sim.append(sim, "clerk", :authority, {:beacon, 9, nil, nil})
    sim = Sim.sync_all(sim)
    {sim, post} = Sim.command(sim, "resident", :post, ["lease remains live"], cap: delegation.id)
    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "clerk")

    assert log.ops[malformed.id] == malformed
    refute Authority.expired?(log, delegation.id)
    assert Sim.quarantined(sim, "clerk", malformed.id) == false
    assert Sim.quarantined(sim, "clerk", post.id) == false
    assert "lease remains live" in Sim.state(sim, "clerk").posts

    {sim, legacy} = Sim.beacon(sim, "clerk", 9)
    sim = Sim.sync_all(sim)
    {sim, late} = Sim.command(sim, "resident", :post, ["lease now lapsed"], cap: delegation.id)
    sim = Sim.sync_all(sim)

    assert Authority.expired?(Sim.log(sim, "clerk"), delegation.id)
    assert Sim.quarantined(sim, "clerk", legacy.id) == false
    assert {true, :lease_expired} = Sim.quarantined(sim, "clerk", late.id)
    refute "lease now lapsed" in Sim.state(sim, "clerk").posts
  end

  test "attenuation narrows the lease: child must not outlive a leased parent" do
    parent =
      Delegation.new(issuer(), @replica, audience().pub,
        ops: [:post],
        live: true,
        expires_epoch: 5
      )

    child = fn opts ->
      Delegation.new(
        audience(),
        @replica,
        issuer().pub,
        Keyword.merge([ops: [:post], parent_id: parent.id], opts)
      )
    end

    assert Delegation.attenuates?(child.(expires_epoch: 5), parent)
    assert Delegation.attenuates?(child.(expires_epoch: 2), parent)

    refute Delegation.attenuates?(child.(expires_epoch: 6), parent),
           "a child extending past its parent's lease launders the lease away"

    refute Delegation.attenuates?(child.([]), parent),
           "a child of a leased parent must carry a lease (nil = unbounded)"
  end

  test "a leased delegation embedded in an op changes the op's canonical bytes" do
    unleased = Delegation.new(issuer(), @replica, audience().pub, ops: [:post])
    leased = Delegation.new(issuer(), @replica, audience().pub, ops: [:post], expires_epoch: 3)

    unleased_bytes = Canonical.term({:grant, unleased})
    leased_bytes = Canonical.term({:grant, leased})

    assert unleased_bytes != leased_bytes,
           "a lease inside an embedded delegation must be inside the op's hashed content"

    # And the unleased term keeps the pre-149 9-element encoding verbatim: the
    # bytes must not mention the new field at all.
    assert unleased_bytes ==
             Canonical.term(
               {:grant, Map.delete(unleased, :expires_epoch) |> Map.put(:__struct__, Delegation)}
             )
  end

  test "mutating an embedded delegation's lease changes the op id" do
    leased = Delegation.new(issuer(), @replica, audience().pub, ops: [:post], expires_epoch: 5)
    op = Lattice.Op.new(issuer(), @replica, [], :authority, {:grant, leased})

    tampered = %{op | body: {:grant, %{leased | expires_epoch: 99}}}

    refute Lattice.Op.canonical_encoding(tampered) == Lattice.Op.canonical_encoding(op),
           "the embedded lease must be inside the op's hashed content"

    refute Lattice.Op.valid?(tampered),
           "a lease-tampered op must fail the sync-path tamper check"
  end

  test "a lease-tampered op cannot poison the honest op's id in a log" do
    leased = Delegation.new(issuer(), @replica, audience().pub, ops: [:post], expires_epoch: 5)
    op = Lattice.Op.new(issuer(), @replica, [], :authority, {:grant, leased})
    tampered = %{op | body: {:grant, %{leased | expires_epoch: 99}}}

    log = Lattice.Log.new(@replica)

    assert {:quarantined, log, :bad_signature} = Lattice.Log.accept(log, tampered)
    assert {:ok, log} = Lattice.Log.accept(log, op)

    assert {:ok, stored} = Lattice.Log.fetch(log, op.id)
    assert {:grant, %Delegation{expires_epoch: 5}} = stored.body
  end

  test "a malformed embedded lease is unsignable rather than raising" do
    leased = Delegation.new(issuer(), @replica, audience().pub, ops: [:post], expires_epoch: 5)

    refute Canonical.signable?({:grant, %{leased | expires_epoch: -1}})
    refute Canonical.signable?({:grant, %{leased | expires_epoch: "5"}})
  end

  test "carrier wire round-trips the lease and omits it when nil" do
    alias Lattice.Carrier.Wire

    leased = Delegation.new(issuer(), @replica, audience().pub, ops: [:post], expires_epoch: 3)
    unleased = Delegation.new(issuer(), @replica, audience().pub, ops: [:post])

    op = Lattice.Op.new(issuer(), @replica, [], :authority, {:grant, leased})
    {:ok, decoded} = op |> Wire.encode_op() |> Wire.decode_op()
    assert {:grant, %Delegation{expires_epoch: 3} = round} = decoded.body
    assert round == leased

    plain_op = Lattice.Op.new(issuer(), @replica, [], :authority, {:grant, unleased})
    frame = Wire.encode_op(plain_op)

    refute frame |> :erlang.term_to_binary() |> :binary.match("expires_epoch") |> is_tuple(),
           "an unleased wire delegation must not carry the key (existing frames stay stable)"

    {:ok, plain_decoded} = Wire.decode_op(frame)
    assert {:grant, %Delegation{expires_epoch: nil}} = plain_decoded.body
  end

  test "an unleased parent accepts leased and unleased children alike" do
    parent = Delegation.new(issuer(), @replica, audience().pub, ops: [:post], live: true)

    child = fn opts ->
      Delegation.new(
        audience(),
        @replica,
        issuer().pub,
        Keyword.merge([ops: [:post], parent_id: parent.id], opts)
      )
    end

    assert Delegation.attenuates?(child.([]), parent)
    assert Delegation.attenuates?(child.(expires_epoch: 7), parent)
  end
end
