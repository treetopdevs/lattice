defmodule Treehouse.MemberContinuityJudgeTest do
  use ExUnit.Case, async: true
  alias Lattice.{Authority, Log, Op, Sim}
  alias Treehouse.{MemberContinuity, Space}
  alias Treehouse.MemberContinuityCertificate, as: Certificate

  test "actual authenticated judge honors only the admin marker after genuine member admissions" do
    {sim, claim} = founded()
    before = Sim.state(sim, "root")
    {sim, op} = attest(sim, claim)
    assert :ok = Log.verify_authenticity(Sim.log(sim, "root"))
    assert false == Sim.quarantined(sim, "root", op.id)
    after_state = Sim.state(sim, "root")
    assert after_state == %{before | admin_actions: "attest_member_key_v1"}
    assert Authority.analyze(Space, Sim.log(sim, "root")).reasons[op.id] == nil
    assert {:ok, observed} = MemberContinuity.observe(Sim.log(sim, "root"))
    assert [%{claim_id: claim_id, wrappers: [%{op_id: id}]}] = observed.records
    assert id == op.id
    assert claim_id == Certificate.claim_id(claim)
    assert [%{status: :attested, affected_wrappers: []}] = observed.links
    forged = %{op | sig: <<0::512>>}
    log = Sim.log(sim, "root")

    assert {:error, :invalid_verified_history} =
             MemberContinuity.observe(%{log | ops: Map.put(log.ops, op.id, forged)})
  end

  test "observation refuses missing closure, mismatched stored identity and wrong replica" do
    {sim, _claim} = founded()
    log = Sim.log(sim, "root")
    [head] = Log.frontier(log)
    missing = hd(log.ops[head].deps)

    assert {:error, :invalid_verified_history} =
             MemberContinuity.observe(%{log | ops: Map.delete(log.ops, missing)})

    assert {:error, :invalid_verified_history} =
             MemberContinuity.observe(%{
               log
               | ops: Map.put(log.ops, "duplicate-alias", log.ops[head])
             })

    assert {:error, :invalid_verified_history} =
             MemberContinuity.observe(%{log | replica: "wrong-replica"})

    assert {:error, :invalid_verified_history} =
             MemberContinuity.observe(%{log | referenced: MapSet.new()})

    assert {:error, :unsupported_continuity_history} =
             MemberContinuity.observe(Log.new("legacy-space"))

    assert {:error, :invalid_verified_history} =
             MemberContinuity.observe(%{verdicts: %{head => :honored}})
  end

  test "ordinary capability refusal precedes malformed application claims" do
    {sim, claim} = founded()
    {sim, cap} = Sim.grant(sim, "root", "root", ops: [:create_space])

    {sim, op} =
      Sim.command(
        sim,
        "root",
        :attest_member_key_v1,
        [%{claim | deps: Log.frontier(Sim.log(sim, "root"))}, <<>>, []],
        cap: cap.id
      )

    assert {true, :operation_not_granted} == Sim.quarantined(sim, "root", op.id)
  end

  test "authenticated concurrent removal causes final denial in both log delivery orders" do
    {sim, claim} = founded()
    base = Sim.log(sim, "root")
    {sim, op} = attest(sim, claim)
    root = Sim.identity(sim, "root")

    remove =
      Op.new(
        root,
        sim.replica,
        Log.frontier(base),
        :command,
        {:remove_member, [Base.encode64(hd(claim.vouchers).member)]},
        cap: op.cap
      )

    for order <- [[op, remove], [remove, op]] do
      log = Enum.reduce(order, base, &Log.append!(&2, &1))
      assert :ok = Log.verify_authenticity(log)

      assert Authority.analyze(Space, log).reasons[op.id] ==
               :application_continuity_stale_voucher

      path =
        Path.join(
          System.tmp_dir!(),
          "continuity-judge-#{System.unique_integer([:positive])}.dump"
        )

      on_exit(fn -> File.rm(path) end)
      assert :ok = Log.dump(log, path)
      assert {:ok, %{log: restored}} = Log.restore_verified(path)

      assert Authority.analyze(Space, restored).reasons ==
               Authority.analyze(Space, log).reasons
    end
  end

  defp founded, do: Treehouse.MemberContinuitySemanticFixture.founded()
  defp attest(sim, claim), do: Treehouse.MemberContinuitySemanticFixture.attest(sim, claim)
end
