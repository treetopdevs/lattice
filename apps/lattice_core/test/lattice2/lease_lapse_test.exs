defmodule Lattice2.LeaseLapseTest do
  @moduledoc """
  Plan 149 steps 3–4 — epoch beacons and lease lapse in `Lattice.Authority`.

  A beacon is a root-signed logical tick ON the log; lease lapse is a derived
  revocation triggered by it. The judgment mirrors `revoked_as_of?` exactly:
  an op citing a leased chain is quarantined `:lease_expired` iff a valid
  beacon past the lease exists that the op is not causally before. No replica
  consults a clock; replicas converge as logs converge (V1/V5).
  """
  use ExUnit.Case, async: true

  alias Lattice.Authority
  alias Lattice.Sim
  alias Township.Matter

  @replica "replica:matter:lease-lapse"

  defp town(realms \\ ["clerk", "resident"]) do
    sim = Sim.new(Matter, @replica, realms, seed: "lease")

    {sim, _genesis} =
      Sim.create_replica(sim, "clerk",
        policies: %{clerk: %{successor: "resident", dormant_ticks: 3}}
      )

    sim
  end

  # V1 — lapse is causal: before-beacon ops stay valid forever; concurrent ops lapse.
  test "V1 — op causally before the lapsing beacon stays valid; concurrent op lapses" do
    sim = town()
    {sim, deleg} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 3)
    sim = Sim.sync_all(sim)

    {sim, early} = Sim.command(sim, "resident", :post, ["before any beacon"], cap: deleg.id)
    sim = Sim.sync_all(sim)

    # Root advances epochs; resident is partitioned and posts concurrently.
    sim = Sim.partition(sim, "clerk", "resident")
    {sim, _b} = Sim.beacon(sim, "clerk", 4)
    {sim, offline} = Sim.command(sim, "resident", :post, ["offline past lease"], cap: deleg.id)

    sim = sim |> Sim.heal("clerk", "resident") |> Sim.sync_all()

    assert Sim.quarantined(sim, "clerk", early.id) == false,
           "an op causally before the beacon must stay valid forever (replay-stable)"

    assert {true, :lease_expired} = Sim.quarantined(sim, "clerk", offline.id)
    assert {true, :lease_expired} = Sim.quarantined(sim, "resident", offline.id)
    refute "offline past lease" in Sim.state(sim, "clerk").posts
  end

  # V2 — lapse rides the chain: a child link's parent lease lapses the child.
  test "V2 — lapse via a parent link quarantines ops citing the child" do
    sim = town(["clerk", "resident", "neighbor"])
    {sim, _parent} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 3)
    sim = Sim.sync_all(sim)

    {sim, child} =
      Sim.grant(sim, "resident", "neighbor", ops: [:post], expires_epoch: 3)

    sim = Sim.sync_all(sim)

    {sim, _b} = Sim.beacon(sim, "clerk", 4)
    sim = Sim.sync_all(sim)

    {sim, late} = Sim.command(sim, "neighbor", :post, ["late via chain"], cap: child.id)
    sim = Sim.sync_all(sim)

    assert {true, :lease_expired} = Sim.quarantined(sim, "clerk", late.id)
  end

  # V3 — beacon authority: non-root beacons are quarantined and confer no lapse.
  test "V3 — a non-root beacon quarantines :unauthorized_beacon and lapses nothing" do
    sim = town()
    {sim, deleg} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 3)
    sim = Sim.sync_all(sim)

    {sim, forged} = Sim.beacon(sim, "resident", 9)
    sim = Sim.sync_all(sim)

    {sim, post} = Sim.command(sim, "resident", :post, ["still authorized"], cap: deleg.id)
    sim = Sim.sync_all(sim)

    assert {true, :unauthorized_beacon} = Sim.quarantined(sim, "clerk", forged.id)
    assert Sim.quarantined(sim, "clerk", post.id) == false
    assert "still authorized" in Sim.state(sim, "clerk").posts
  end

  test "V3 — a non-monotonic root beacon quarantines :stale_beacon" do
    sim = town()
    {sim, _} = Sim.beacon(sim, "clerk", 4)
    sim = Sim.sync_all(sim)
    {sim, stale} = Sim.beacon(sim, "clerk", 4)
    sim = Sim.sync_all(sim)

    assert {true, :stale_beacon} = Sim.quarantined(sim, "resident", stale.id)
  end

  # V4 — renewal is a fresh delegation; the lapsed id stays lapsed.
  test "V4 — a fresh later-lease delegation restores authoring; the old id stays dead" do
    sim = town()
    {sim, old} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 3)
    sim = Sim.sync_all(sim)
    {sim, _b} = Sim.beacon(sim, "clerk", 4)
    sim = Sim.sync_all(sim)

    {sim, dead} = Sim.command(sim, "resident", :post, ["via lapsed cap"], cap: old.id)
    sim = Sim.sync_all(sim)
    assert {true, :lease_expired} = Sim.quarantined(sim, "clerk", dead.id)

    {sim, renewed} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 9)
    sim = Sim.sync_all(sim)
    assert renewed.id != old.id, "renewal must be a new content-addressed delegation"

    {sim, alive} = Sim.command(sim, "resident", :post, ["via renewed cap"], cap: renewed.id)
    sim = Sim.sync_all(sim)
    assert Sim.quarantined(sim, "clerk", alive.id) == false
    assert "via renewed cap" in Sim.state(sim, "clerk").posts
  end

  # Precedence — an op both revoked and lease-expired reports :revoked_capability
  # on every realm (fixed evaluation order inside cap_ok).
  test "an op both revoked and expired quarantines :revoked_capability everywhere" do
    sim = town()
    {sim, deleg} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 3)
    sim = Sim.sync_all(sim)

    {sim, _revoke} = Sim.revoke(sim, "clerk", deleg.id)
    {sim, _b} = Sim.beacon(sim, "clerk", 4)
    sim = Sim.sync_all(sim)

    {sim, both} = Sim.command(sim, "resident", :post, ["doubly dead"], cap: deleg.id)
    sim = Sim.sync_all(sim)

    assert {true, :revoked_capability} = Sim.quarantined(sim, "clerk", both.id)
    assert {true, :revoked_capability} = Sim.quarantined(sim, "resident", both.id)
  end

  # Q3(a) — one chain, two uses: the live path lapses with the append path.
  test "live path — expired?/2 and delegation_active?/2 track the lease" do
    sim = town()
    {sim, deleg} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 3)
    sim = Sim.sync_all(sim)

    log_before = Sim.log(sim, "clerk")
    refute Authority.expired?(log_before, deleg.id)
    assert Authority.delegation_active?(log_before, deleg.id)

    {sim, _b} = Sim.beacon(sim, "clerk", 4)
    sim = Sim.sync_all(sim)

    log_after = Sim.log(sim, "clerk")
    assert Authority.expired?(log_after, deleg.id)

    refute Authority.delegation_active?(log_after, deleg.id),
           "the Gateway path must never accept a chain the append path would lapse"
  end
end
