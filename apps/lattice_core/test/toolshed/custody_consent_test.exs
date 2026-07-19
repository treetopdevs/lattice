defmodule Toolshed.CustodyConsentTest do
  @moduledoc """
  ADR 0007 — co-signed consent for custody-transfer commands.

  First consumer: `Toolshed.Tool` (PD-003). A `:custody_transfer` command is
  honored only if the recipient's consent signature over the domain-tagged
  canonical payload verifies AND the cited request op is in the transfer's
  causal past. Failures quarantine as `:missing_consent` / `:invalid_consent`
  — semantic, deps-decidable, identical on every realm (property d).
  """
  use ExUnit.Case, async: true

  alias Lattice.Authority
  alias Lattice.Authority.Consent
  alias Lattice.Sim
  alias Toolshed.Tool

  @replica "replica:tool:ladder-6ft"

  defp shed(realms), do: Sim.new(Tool, @replica, realms, seed: "toolshed")

  # Owner establishes the tool replica (genesis holder of :custody), grants the
  # borrower a basic cap, and the borrower posts a durable custody request
  # (`:inbox`, the Q-06 surface). Returns {sim, request_op}.
  defp lent_setup do
    sim = shed(["owner", "borrower"])
    {sim, _genesis} = Sim.create_replica(sim, "owner")
    {sim, _deleg} = Sim.grant(sim, "owner", "borrower", ops: [:note_condition])
    sim = Sim.sync_all(sim)
    {sim, request} = Sim.request(sim, "borrower", "custody", {:custody_transfer, []})

    Sim.sync_all(sim)
    |> then(&{&1, request})
  end

  test "dual-signed custody transfer is honored and converges the holder" do
    {sim, request} = lent_setup()
    owner = Sim.identity(sim, "owner")
    borrower = Sim.identity(sim, "borrower")

    consent = Consent.sign_custody(borrower, Sim.replica(sim), request.id, owner.pub)

    {sim, transfer} =
      Sim.command(sim, "owner", :custody_transfer, [borrower.pub, request.id, consent])

    sim = Sim.sync_all(sim)

    assert Sim.quarantined(sim, "owner", transfer.id) == false
    assert Sim.quarantined(sim, "borrower", transfer.id) == false
    assert Sim.state(sim, "owner").holder == borrower.pub
    assert Sim.state(sim, "borrower").holder == borrower.pub
  end

  test "missing consent quarantines as :missing_consent on every realm" do
    {sim, request} = lent_setup()
    borrower = Sim.identity(sim, "borrower")

    {sim, transfer} =
      Sim.command(sim, "owner", :custody_transfer, [borrower.pub, request.id, nil])

    sim = Sim.sync_all(sim)

    assert {true, :missing_consent} = Sim.quarantined(sim, "owner", transfer.id)
    assert {true, :missing_consent} = Sim.quarantined(sim, "borrower", transfer.id)
    assert Sim.state(sim, "borrower").holder == nil
  end

  test "consent signed by the wrong identity quarantines as :invalid_consent" do
    {sim, request} = lent_setup()
    owner = Sim.identity(sim, "owner")
    borrower = Sim.identity(sim, "borrower")

    # The OWNER signs the consent payload — self-consent is not consent.
    forged = Consent.sign_custody(owner, Sim.replica(sim), request.id, owner.pub)

    {sim, transfer} =
      Sim.command(sim, "owner", :custody_transfer, [borrower.pub, request.id, forged])

    sim = Sim.sync_all(sim)

    assert {true, :invalid_consent} = Sim.quarantined(sim, "borrower", transfer.id)
  end

  test "a request id outside the causal past quarantines as :invalid_consent" do
    {sim, _request} = lent_setup()
    owner = Sim.identity(sim, "owner")
    borrower = Sim.identity(sim, "borrower")

    phantom_id = "not-an-op-in-this-log"
    consent = Consent.sign_custody(borrower, Sim.replica(sim), phantom_id, owner.pub)

    {sim, transfer} =
      Sim.command(sim, "owner", :custody_transfer, [borrower.pub, phantom_id, consent])

    sim = Sim.sync_all(sim)

    assert {true, :invalid_consent} = Sim.quarantined(sim, "borrower", transfer.id)
  end

  test "V-09 — a consent replayed from one transfer cannot authorize a second" do
    {sim, request1} = lent_setup()
    owner = Sim.identity(sim, "owner")
    borrower = Sim.identity(sim, "borrower")

    consent1 = Consent.sign_custody(borrower, Sim.replica(sim), request1.id, owner.pub)

    {sim, first} =
      Sim.command(sim, "owner", :custody_transfer, [borrower.pub, request1.id, consent1])

    sim = Sim.sync_all(sim)
    assert Sim.quarantined(sim, "owner", first.id) == false

    # A second, distinct request — but the embedded consent is lifted from the
    # first transfer. The payload binds request_op_id, so it must not verify.
    {sim, request2} = Sim.request(sim, "borrower", "custody", {:custody_transfer, []})
    sim = Sim.sync_all(sim)

    {sim, replayed} =
      Sim.command(sim, "owner", :custody_transfer, [borrower.pub, request2.id, consent1])

    sim = Sim.sync_all(sim)

    assert {true, :invalid_consent} = Sim.quarantined(sim, "borrower", replayed.id)
  end

  test "V-08 — valid consent does not rescue an author who lost holdership" do
    sim = shed(["owner", "borrower", "steward"])
    {sim, _genesis} = Sim.create_replica(sim, "owner")
    {sim, _deleg} = Sim.grant(sim, "owner", "borrower", ops: [:note_condition])
    sim = Sim.sync_all(sim)
    {sim, request} = Sim.request(sim, "borrower", "custody", {:custody_transfer, []})
    sim = Sim.sync_all(sim)

    owner = Sim.identity(sim, "owner")
    borrower = Sim.identity(sim, "borrower")
    consent = Consent.sign_custody(borrower, Sim.replica(sim), request.id, owner.pub)

    # Between consent signing and append, custody moves to a steward — and the
    # (former) owner authors the transfer concurrently, never having seen it.
    {sim, _} =
      Sim.transfer(sim, "owner", "steward", :custody, at_tick: 1, ops: [:custody_transfer])

    sim = Sim.sync(sim, "owner", "steward")
    sim = sim |> Sim.partition("owner", "steward") |> Sim.partition("owner", "borrower")

    {sim, stale} =
      Sim.command(sim, "owner", :custody_transfer, [borrower.pub, request.id, consent])

    sim =
      sim
      |> Sim.heal("owner", "steward")
      |> Sim.heal("owner", "borrower")
      |> Sim.sync_all()

    assert {true, reason} = Sim.quarantined(sim, "steward", stale.id)
    assert reason in [:not_holder, :stale_holder]
  end

  test "V-10 — an unresolved custody request is visible in the analyzer output" do
    {sim, request} = lent_setup()

    analysis = Authority.analyze(Tool, Sim.log(sim, "owner"))

    assert Enum.any?(analysis.requests, fn r ->
             r.op == request.id and r.ref == "custody"
           end),
           "the durable custody request must surface in analyze/2 requests"
  end

  test "property (c) — the consented run replays byte-identically" do
    run = fn ->
      {sim, request} = lent_setup()
      owner = Sim.identity(sim, "owner")
      borrower = Sim.identity(sim, "borrower")
      consent = Consent.sign_custody(borrower, Sim.replica(sim), request.id, owner.pub)

      {sim, _} =
        Sim.command(sim, "owner", :custody_transfer, [borrower.pub, request.id, consent])

      sim = Sim.sync_all(sim)
      {Sim.state(sim, "owner"), Lattice.Log.topo_ops(Sim.log(sim, "owner"))}
    end

    assert run.() == run.()
  end
end
