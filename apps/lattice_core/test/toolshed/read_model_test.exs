defmodule Toolshed.ReadModelTest do
  @moduledoc """
  The Toolshed read model: everything the shed UI shows is a projection of a
  tool log — availability, the active loan, overdue, and the open-request
  dispute surface are COMPUTED from op presence in the DAG, never stored.
  """
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Identity, Sim}
  alias Toolshed.{ReadModel, Tool}

  @tool "replica:tool:ladder-6ft"

  defp saw(realms), do: Sim.new(Tool, @tool, realms, seed: "toolshed-rm")

  defp fresh_tool do
    sim = saw(["owner", "borrower"])
    {sim, _genesis} = Sim.create_replica(sim, "owner")
    {sim, _} = Sim.command(sim, "owner", :describe, ["6ft ladder, aluminum"])
    Sim.sync_all(sim)
  end

  # The full dual-signed borrow with a due-back lease on the borrow Cap.
  defp borrowed(due_epoch) do
    sim = fresh_tool()
    {sim, request} = Sim.request(sim, "borrower", "custody", {:custody_transfer, []})
    sim = Sim.sync_all(sim)

    owner = Sim.identity(sim, "owner")
    borrower = Sim.identity(sim, "borrower")

    consent =
      Authority.Consent.sign_custody(borrower, Sim.replica(sim), request.id, owner.pub)

    {sim, _transfer} =
      Sim.command(sim, "owner", :custody_transfer, [borrower.pub, request.id, consent])

    {sim, _cap} =
      Sim.grant(sim, "owner", "borrower", ops: [:note_condition], expires_epoch: due_epoch)

    Sim.sync_all(sim)
  end

  test "a fresh tool is available, with no loan and no open requests" do
    sim = fresh_tool()
    model = ReadModel.observe(Sim.log(sim, "owner"))

    assert model.listing.description == "6ft ladder, aluminum"
    assert model.custody.available?
    assert model.custody.holder == nil
    assert model.loan == nil
    assert model.requests == []
  end

  test "an open borrow projects the loan — borrower, due epoch, not yet overdue" do
    sim = borrowed(4)
    model = ReadModel.observe(Sim.log(sim, "owner"))
    borrower = Sim.identity(sim, "borrower")

    refute model.custody.available?
    assert model.custody.holder == borrower.pub
    assert model.custody.holder_fingerprint == Identity.fingerprint(borrower.pub)

    assert %{due_epoch: 4, overdue?: false} = model.loan
    assert model.loan.borrower_fingerprint == Identity.fingerprint(borrower.pub)

    # The borrow request was resolved by the dual-signed transfer that cites it.
    assert [%{ref: "custody", resolved?: true}] = model.requests
  end

  test "once the root beacons past the due-back, overdue is computed — not asserted" do
    sim = borrowed(4)
    {sim, _} = Sim.beacon(sim, "owner", 5)
    sim = Sim.sync_all(sim)

    model = ReadModel.observe(Sim.log(sim, "owner"))

    refute model.custody.available?
    assert %{due_epoch: 4, overdue?: true} = model.loan
  end

  test "an unresolved return request stays visible on the dispute surface" do
    sim = borrowed(4)
    {sim, return_req} = Sim.request(sim, "borrower", "custody", {:custody_transfer, [:return]})
    sim = Sim.sync_all(sim)

    model = ReadModel.observe(Sim.log(sim, "owner"))

    open = Enum.filter(model.requests, &(not &1.resolved?))
    assert [%{op: op_id, ref: "custody"}] = open
    assert op_id == return_req.id
  end

  test "after the reverse dual-bound return, the tool is available again" do
    sim = borrowed(4)
    {sim, return_req} = Sim.request(sim, "borrower", "custody", {:custody_transfer, [:return]})
    sim = Sim.sync_all(sim)

    owner = Sim.identity(sim, "owner")

    consent =
      Authority.Consent.sign_custody(owner, Sim.replica(sim), return_req.id, owner.pub)

    {sim, _return_op} =
      Sim.command(sim, "owner", :custody_transfer, [owner.pub, return_req.id, consent])

    sim = Sim.sync_all(sim)
    model = ReadModel.observe(Sim.log(sim, "borrower"))

    assert model.custody.available?
    assert model.custody.holder == owner.pub
    assert model.loan == nil
    assert Enum.all?(model.requests, & &1.resolved?)
  end

  test "quarantined custody evidence is legible in the model" do
    sim = borrowed(4)
    borrower = Sim.identity(sim, "borrower")

    # A unilateral transfer attempt — no consent — is on the record, refused.
    {sim, forged} = Sim.command(sim, "owner", :custody_transfer, [borrower.pub, "x", nil])
    sim = Sim.sync_all(sim)

    model = ReadModel.observe(Sim.log(sim, "borrower"))

    assert model.evidence.reasons[forged.id] == :missing_consent
    assert forged.id in model.evidence.quarantine
  end
end
