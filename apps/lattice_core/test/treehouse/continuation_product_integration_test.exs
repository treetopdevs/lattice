defmodule Treehouse.ContinuationProductIntegrationTest do
  use ExUnit.Case, async: false

  alias Lattice.{Authority, Log, Op, Sim}
  alias Lattice.Authority.Delegation
  alias Lattice.Carrier.Wire
  alias Treehouse.{ContinuationFixtures, Space}

  test "continued Space admin commands retain all effects and refusals across runtimes" do
    nonce = ContinuationFixtures.digest("product-continuation-integration")
    replica = "replica:treehouse:space:#{nonce}#authority:bounded-continuation-v1"
    realms = ["founder", "holder", "nominee", "w1", "w2", "w3"]

    {sim, _genesis} =
      Sim.new(Space, replica, realms, seed: "r04-r10") |> Sim.create_replica("founder")

    {sim, _name} = Sim.command(sim, "founder", :create_space, ["Canopy"])
    root = Sim.identity(sim, "founder")
    witnesses = Enum.map(["w1", "w2", "w3"], &Sim.identity(sim, &1).pub) |> Enum.sort()

    profile = %{
      mode: :bounded_continuation,
      version: 1,
      product: :treehouse,
      kind: :space,
      role: :admin,
      nominee: Sim.identity(sim, "nominee").pub,
      witnesses: witnesses,
      threshold: 2,
      max_lease_epochs: 7
    }

    beacon = %{
      mode: :witnessed,
      version: 1,
      witnesses: witnesses,
      threshold: 2,
      max_epoch_step: 1
    }

    pin_delegation = Delegation.genesis(root, sim.replica, ops: [], roles: [], live: false)

    {sim, _pin} =
      Sim.append(
        sim,
        "founder",
        :authority,
        {:genesis, pin_delegation, %{__continuation__: profile, __beacon__: beacon}}
      )

    {sim, _epoch0} = Sim.beacon(sim, "founder", 0)

    {sim, old_cap} =
      Sim.transfer(sim, "founder", "holder", :admin, ops: [:create_thread], expires_epoch: 6)

    sim = Sim.sync_all(sim)

    {sim, first} =
      Sim.command(sim, "holder", :create_thread, ["thread:first", "First"], cap: old_cap.id)

    assert false == Sim.quarantined(sim, "holder", first.id)
    sim = Sim.sync_all(sim)

    # No founder signing state is available to renewal, witness ticks or new commands.
    sim = %{
      sim
      | realms: Map.delete(sim.realms, "founder"),
        logs: Map.delete(sim.logs, "founder"),
        caps: Map.delete(sim.caps, "founder")
    }

    {sim, _epoch1} = Sim.beacon(sim, "w1", 1, witnesses: ["w1", "w2"])
    sim = Sim.sync_all(sim)

    {sim, acquired} =
      Sim.continue_role(sim, "nominee", :admin,
        ops: [:create_thread],
        expires_epoch: 7,
        witnesses: ["w1", "w2"]
      )

    assert false == Sim.quarantined(sim, "nominee", acquired.id)
    {:succeed, :admin, new_cap, _certificate} = acquired.body
    sim = Sim.sync_all(sim)

    {sim, stale} =
      Sim.command(sim, "holder", :create_thread, ["thread:stale", "Must not appear"],
        cap: old_cap.id
      )

    assert {true, :not_holder} == Sim.quarantined(sim, "holder", stale.id)
    sim = Sim.sync_all(sim)

    {sim, second} =
      Sim.command(sim, "nominee", :create_thread, ["thread:second", "Second"], cap: new_cap.id)

    assert false == Sim.quarantined(sim, "nominee", second.id)
    sim = Sim.sync_all(sim)

    sim =
      Enum.reduce(2..8, sim, fn epoch, current ->
        {next, _beacon} = Sim.beacon(current, "w1", epoch, witnesses: ["w1", "w2"])
        Sim.sync_all(next)
      end)

    {sim, expired} =
      Sim.command(sim, "nominee", :create_thread, ["thread:expired", "Must not appear either"],
        cap: new_cap.id
      )

    assert {true, :lease_expired} == Sim.quarantined(sim, "nominee", expired.id)
    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "nominee")
    state = Lattice.state(Space, log)
    assert state.name == "Canopy"

    assert state.threads == [
             %{"replica" => "thread:first", "title" => "First"},
             %{"replica" => "thread:second", "title" => "Second"}
           ]

    assert state.admin_actions == "create_thread"
    assert Authority.holder_epoch(Space, log, :admin).op_id == acquired.id
    assert Enum.all?(Log.topo_ops(log), &Op.valid?/1)

    path =
      Path.join(
        System.tmp_dir!(),
        "treehouse-product-continuation-#{System.unique_integer([:positive])}.json"
      )

    on_exit(fn -> File.rm(path) end)

    File.write!(
      path,
      Jason.encode!(%{
        frames: Enum.map(Log.topo_ops(log), &Wire.encode_op/1),
        name: state.name,
        threads: state.threads,
        adminAction: state.admin_actions,
        holder: Base.encode64(Sim.identity(sim, "nominee").pub),
        acquisition: acquired.id,
        reasons: %{stale.id => "not_holder", expired.id => "lease_expired"}
      })
    )

    client = Path.expand("../../../../clients/lattice-client", __DIR__)

    {output, status} =
      System.cmd(
        Path.join(client, "node_modules/.bin/tsx"),
        ["test/support/assert_treehouse_continuation.ts", path],
        cd: client,
        stderr_to_stdout: true
      )

    assert status == 0, output
    assert output =~ "TREEHOUSE_CONTINUATION_PRODUCT_OK"
  end
end
