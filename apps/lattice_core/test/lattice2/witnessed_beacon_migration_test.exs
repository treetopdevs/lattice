defmodule Lattice2.WitnessedBeaconMigrationTest do
  use ExUnit.Case, async: true

  # Immutable baseline: afe5ea250072267927b89b353e7bde1e793176b5.
  # P05 at 918bb018 remains historical evidence; only the beacon audit verdict changes.
  test "legacy signed history retains state, holders and expiry with an explicit audit-only delta" do
    alias Lattice.{Authority, Log, Op, Sim}
    alias Township.Matter

    sim =
      Sim.new(Matter, "replica:r03:legacy-migration", ["founder", "member", "w1"],
        seed: "r03-migration"
      )

    {sim, _} = Sim.create_replica(sim, "founder")

    {sim, grants} =
      Enum.reduce(0..9, {sim, []}, fn epoch, {acc, grants} ->
        {acc, grant} = Sim.grant(acc, "founder", "member", ops: [:post], expires_epoch: epoch)
        {acc, grants ++ [grant]}
      end)

    sim = Sim.sync_all(sim)

    sim = %{
      sim
      | realms: Map.delete(sim.realms, "founder"),
        logs: Map.delete(sim.logs, "founder"),
        caps: Map.delete(sim.caps, "founder")
    }

    {sim, simple} = Sim.beacon(sim, "w1", 7)
    {sim, future} = Sim.append(sim, "w1", :authority, {:beacon, 7, %{}})
    sim = Sim.sync_all(sim)

    {sim, post} =
      Sim.command(sim, "member", :post, ["clock has not advanced"], cap: Enum.at(grants, 6).id)

    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "member")
    analysis = Authority.analyze(Matter, log)
    encoded = for op <- Log.topo_ops(log), do: {Op.canonical_encoding(op), op.sig}

    fingerprint =
      :crypto.hash(:sha256, :erlang.term_to_binary(encoded, [:deterministic]))
      |> Base.encode16(case: :lower)

    assert fingerprint == "3c2172ced9d5088a6d2deff134be9b70863f2eee221a94d81424c0294bed430f"

    assert Sim.state(sim, "member") == %{
             title: "",
             summary: "",
             members: [],
             posts: ["clock has not advanced"],
             clerk_locked?: false
           }

    assert inspect(analysis.holders, limit: :infinity) ==
             "%{clerk: <<122, 144, 177, 58, 211, 215, 179, 190, 151, 26, 43, 234, 226, 220, 177, 46, 225, 139, 38, 227, 36, 169, 149, 114, 67, 90, 205, 142, 139, 152, 20, 8>>}"

    legacy_reasons = %{simple.id => :unauthorized_beacon}
    assert analysis.reasons == Map.put(legacy_reasons, future.id, :unauthorized_beacon)
    assert Enum.map(grants, &Authority.expired?(log, &1.id)) == List.duplicate(false, 10)
    assert Sim.quarantined(sim, "member", post.id) == false

    for realm <- Map.keys(sim.realms) do
      assert Sim.state(sim, realm) == Sim.state(sim, "member")
      assert Sim.authority(sim, realm).reasons == analysis.reasons
    end
  end
end
