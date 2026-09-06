defmodule Treehouse.BoundedContinuationTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Log, Sim}
  alias Treehouse.ContinuationFixtures, as: F

  defp ready(opts \\ []) do
    {sim, genesis} = F.new(opts)
    {sim, pin, profile} = F.pin(sim, opts)
    {sim, epoch} = Sim.beacon(sim, "founder", 0)
    {Sim.sync_all(sim), genesis, pin, profile, epoch}
  end

  test "V01 empty-role enrollment pin preserves the founder acquisition; legacy proof refuses" do
    {sim, genesis, _pin, _profile, _epoch} = ready()
    assert Authority.holder_epoch(sim.module, Sim.log(sim, "nominee"), :admin).op_id == genesis.id

    assert length(
             Enum.filter(
               Log.topo_ops(Sim.log(sim, "nominee")),
               &match?({:genesis, _, _}, &1.body)
             )
           ) == 2

    {sim, op} = Sim.succeed(sim, "nominee", :admin, ops: [:manage], at_tick: 100)
    assert Sim.quarantined(sim, "nominee", op.id) == {true, :continuation_required}
  end

  test "V01 exact scoped fresh continuation is honored through public Sim" do
    for kind <- [:space, :thread] do
      {sim, _genesis, pin, profile, epoch} = ready(kind: kind)
      {sim, op} = F.continue(sim, "nominee", pin, profile, epoch_basis: [epoch.id])
      assert Sim.quarantined(sim, "nominee", op.id) == false

      assert Authority.holder_epoch(sim.module, Sim.log(sim, "nominee"), F.role(sim)).op_id ==
               op.id
    end
  end

  test "V03 wider ops, extra roles, live, parent and unleased delegation refuse" do
    {sim, _genesis, pin, profile, epoch} = ready()
    {sim, _d} = Sim.transfer(sim, "founder", "holder", :admin, ops: [:manage])
    sim = Sim.sync_all(sim)

    for opts <- [
          [ops: [:manage, :post]],
          [roles: [:admin, :moderator]],
          [live: true],
          [parent_id: "unknown"],
          [expires_epoch: nil]
        ] do
      {branch, op} =
        F.continue(
          sim,
          "holder",
          pin,
          profile,
          Keyword.merge([ops: [:manage], epoch_basis: [epoch.id]], opts)
        )

      assert Sim.quarantined(branch, "holder", op.id) == {true, :continuation_scope_exceeded}
    end
  end

  test "V04 lease window is inclusive and basis must be exact" do
    {sim, _genesis, pin, profile, epoch} = ready()

    for {opts, reason} <- [
          {[expires_epoch: 6], nil},
          {[expires_epoch: 7], :continuation_scope_exceeded},
          {[epoch_basis: []], :invalid_continuation_epoch},
          {[epoch: 1], :invalid_continuation_epoch}
        ] do
      {branch, op} =
        F.continue(sim, "nominee", pin, profile, Keyword.merge([epoch_basis: [epoch.id]], opts))

      assert Sim.quarantined(branch, "nominee", op.id) ==
               if(reason, do: {true, reason}, else: false)
    end
  end

  test "V05 freshly signed altered claim and bad surplus witness cannot authorize" do
    {sim, _genesis, pin, profile, epoch} = ready()

    for opts <- [
          [claim_patch: %{profile_genesis: F.digest("other-pin")}],
          [claim_patch: %{deps: []}],
          [witnesses: ["w1"]],
          [witnesses: ["w1", "w2", "observer"]],
          [
            certificate_transform: fn cert ->
              %{cert | signatures: cert.signatures ++ [hd(cert.signatures)]}
            end
          ]
        ] do
      {branch, op} =
        F.continue(sim, "nominee", pin, profile, Keyword.merge([epoch_basis: [epoch.id]], opts))

      assert Sim.quarantined(branch, "nominee", op.id) ==
               {true, :invalid_continuation_certificate}
    end
  end

  test "V06 independent holder and nominee attempts consume exactly one predecessor" do
    {sim, _genesis, pin, profile, epoch} = ready()
    {sim, _d} = Sim.transfer(sim, "founder", "holder", :admin, ops: [:manage, :post])
    sim = Sim.sync_all(sim)
    {left, a} = F.continue(sim, "holder", pin, profile, epoch_basis: [epoch.id])
    {right, b} = F.continue(sim, "nominee", pin, profile, epoch_basis: [epoch.id])

    sim =
      %{
        sim
        | logs:
            sim.logs
            |> Map.put("holder", Sim.log(left, "holder"))
            |> Map.put("nominee", Sim.log(right, "nominee"))
      }
      |> Sim.sync_all()

    [winner, loser] =
      Enum.filter(Log.topo_ops(Sim.log(sim, "observer")), &(&1.id in [a.id, b.id]))

    for realm <- Map.keys(sim.logs) do
      assert Sim.quarantined(sim, realm, winner.id) == false
      assert Sim.quarantined(sim, realm, loser.id) == {true, :stale_continuation}
    end
  end
end
