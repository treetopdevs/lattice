defmodule Lattice2.AuthorityTest do
  @moduledoc """
  Phase C gate: in-log delegation + serialized authority.

  Behaviors 5 (cap-gated append), 6 (authoritative serialization / queue-through-
  holder), 7 (offline-authoritative), 8 (stale-holder quarantine), 9 (double-transfer
  anomaly), 10 (revocation). Behavior 16 (unified chain) is covered in
  unified_chain_test.exs.
  """
  use ExUnit.Case, async: true

  alias Lattice.Sim

  @replica "replica:thread:auth"

  defp base do
    Sim.new(Lattice.Demo.Thread, @replica, ["server", "tab", "phone"], seed: "auth")
  end

  defp pub(sim, realm), do: Sim.identity(sim, realm).pub

  test "behavior 5: a command whose cap does not chain to a valid delegation is quarantined" do
    {sim, _g} = base() |> Sim.create_replica("server")
    # tab never received any grant; it forges a post op with no capability.
    {sim, op} = Sim.command(sim, "tab", :post, ["sneaky"], cap: :none)

    assert {true, :no_capability} = Sim.quarantined(sim, "tab", op.id)
    refute "sneaky" in Sim.state(sim, "tab").messages
  end

  test "behavior 5: a command concurrent with (not causally after) its grant is quarantined as not-visible" do
    {sim, _g} = base() |> Sim.create_replica("server")
    {sim, grant} = Sim.grant(sim, "server", "tab", ops: [:post])
    # tab posts citing the grant on a frontier that does NOT include the grant op
    # (concurrent with it), then the logs merge. The grant is present but was not
    # causally visible to the post.
    {sim, op} = Sim.command(sim, "tab", :post, ["early"], cap: grant.id)
    {merged, _, _} = Lattice.Sync.reconcile(Sim.log(sim, "server"), Sim.log(sim, "tab"))

    analysis = Lattice.Authority.analyze(Lattice.Demo.Thread, merged)
    assert Map.get(analysis.reasons, op.id) == :capability_not_visible
  end

  test "behavior 6: a non-holder authoritative command is quarantined; the request routes through the holder" do
    {sim, _g} = base() |> Sim.create_replica("server", policies: %{})
    {sim, grant} = Sim.grant(sim, "server", "tab", ops: [:post, :lock, :unlock])
    sim = Sim.sync_all(sim)

    # tab holds the :lock OP capability but NOT the :moderator role => direct lock
    # quarantined as :role_not_granted.
    {sim, bad_lock} = Sim.command(sim, "tab", :lock, [], cap: grant.id)
    assert {true, :role_not_granted} = Sim.quarantined(sim, "tab", bad_lock.id)
    refute Sim.state(sim, "tab").locked?

    # Instead tab queues a request; the holder (server) processes it and emits the
    # real lock op, which IS honored.
    {sim, _req} = Sim.request(sim, "tab", "ref-1", {:lock, []})
    sim = Sim.sync_all(sim)
    requests = Sim.authority(sim, "server").requests
    assert Enum.any?(requests, &(&1.ref == "ref-1"))

    {sim, good_lock} = Sim.command(sim, "server", :lock, [])
    refute Sim.quarantined(sim, "server", good_lock.id)
    assert Sim.state(sim, "server").locked? == true
  end

  test "behavior 7: the authority holder can execute authoritative commands while partitioned" do
    {sim, _g} = base() |> Sim.create_replica("server")
    sim = Sim.sync_all(sim)
    sim = Sim.partition(sim, "server", "tab")

    # server holds :moderator (genesis) and locks while offline.
    {sim, lock} = Sim.command(sim, "server", :lock, [])
    assert Sim.state(sim, "server").locked? == true
    refute Sim.quarantined(sim, "server", lock.id)

    # On heal the offline lock is valid everywhere.
    sim = sim |> Sim.heal("server", "tab") |> Sim.sync_all()
    assert Sim.state(sim, "tab").locked? == true
    refute Sim.quarantined(sim, "tab", lock.id)
  end

  test "behavior 8: an authoritative op concurrent with an unseen transfer-away is quarantined deterministically" do
    {sim, _g} = base() |> Sim.create_replica("server")
    sim = Sim.sync_all(sim)

    # A holder always sees its own transfer, so the stale op must be authored on a
    # concurrent branch that does not include the transfer — exactly the shape of a
    # lagging/restored server replica. Fork the stale lock off the pre-transfer
    # frontier, then advance the main line through the transfer.
    {branch_l, stale_lock} = Sim.command(sim, "server", :lock, [])

    {sim, _d} = Sim.transfer(sim, "server", "phone", :moderator, at_tick: 1)
    sim = Sim.sync_all(sim)
    {sim, phone_lock} = Sim.command(sim, "phone", :lock, [])
    sim = Sim.sync_all(sim)

    # Merge the stale branch into the main line.
    {merged, _, _} = Lattice.Sync.reconcile(Sim.log(sim, "server"), Sim.log(branch_l, "server"))

    analysis = Lattice.Authority.analyze(Lattice.Demo.Thread, merged)

    # Every realm computes the same verdict from the merged log.
    assert Map.get(analysis.reasons, stale_lock.id) == :stale_holder
    refute MapSet.member?(analysis.quarantine, phone_lock.id)
    assert Lattice.Authority.holder(Lattice.Demo.Thread, merged, :moderator) == pub(sim, "phone")

    # Determinism: merging in the opposite order gives the identical quarantine set.
    {merged2, _, _} = Lattice.Sync.reconcile(Sim.log(branch_l, "server"), Sim.log(sim, "server"))
    analysis2 = Lattice.Authority.analyze(Lattice.Demo.Thread, merged2)
    assert analysis2.quarantine == analysis.quarantine
  end

  test "behavior 9: two concurrent transfers by the same holder resolve deterministically; the loser is audited" do
    {sim, _g} = base() |> Sim.create_replica("server")
    sim = Sim.sync_all(sim)

    # server, on the same frontier, issues two conflicting transfers (to tab and to
    # phone) without either seeing the other — a partition of server's own intent.
    {branch_a, _d1} = Sim.transfer(sim, "server", "tab", :moderator, at_tick: 1)
    {branch_b, _d2} = Sim.transfer(sim, "server", "phone", :moderator, at_tick: 1)

    # Merge both branches' logs.
    merged_log =
      Lattice.Sync.reconcile(Sim.log(branch_a, "server"), Sim.log(branch_b, "server"))
      |> elem(0)

    analysis = Lattice.Authority.analyze(Lattice.Demo.Thread, merged_log)
    winner = Lattice.Authority.holder(Lattice.Demo.Thread, merged_log, :moderator)

    assert winner in [pub(sim, "tab"), pub(sim, "phone")]
    # Exactly one transfer survived; the other is a quarantined double-transfer anomaly.
    assert Enum.any?(analysis.audit, &(&1[:reason] == :double_transfer))

    # Determinism: re-merging in the other order yields the same winner.
    merged_log2 =
      Lattice.Sync.reconcile(Sim.log(branch_b, "server"), Sim.log(branch_a, "server"))
      |> elem(0)

    assert Lattice.Authority.holder(Lattice.Demo.Thread, merged_log2, :moderator) == winner
  end

  test "behavior 10: ops authored under a revoked delegation are quarantined" do
    {sim, _g} = base() |> Sim.create_replica("server")
    {sim, grant} = Sim.grant(sim, "server", "tab", ops: [:post])
    sim = Sim.sync_all(sim)

    # tab posts legitimately first, and everyone sees it.
    {sim, ok_post} = Sim.command(sim, "tab", :post, ["before revoke"], cap: grant.id)
    sim = Sim.sync_all(sim)
    refute Sim.quarantined(sim, "tab", ok_post.id)

    # server revokes tab's delegation (causally after the legitimate post).
    {sim, _r} = Sim.revoke(sim, "server", grant.id)
    sim = Sim.sync_all(sim)

    # tab posts again under the now-revoked delegation => quarantined.
    {sim, after_post} = Sim.command(sim, "tab", :post, ["after revoke"], cap: grant.id)
    sim = Sim.sync_all(sim)

    assert {true, :revoked_capability} = Sim.quarantined(sim, "server", after_post.id)
    assert "before revoke" in Sim.state(sim, "server").messages
    refute "after revoke" in Sim.state(sim, "server").messages
  end
end
