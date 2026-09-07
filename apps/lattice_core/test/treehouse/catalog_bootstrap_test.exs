defmodule Treehouse.CatalogBootstrapTest do
  use ExUnit.Case, async: true
  alias Lattice.{Authority, Log, Op, Sim}
  alias Treehouse.{CatalogVectors, Space}

  test "an authorized root bootstrap is honored and records only the existing admin marker" do
    f = CatalogVectors.bootstrap_history()
    assert Authority.analyze(Space, f.log).reasons == %{}
    state = Lattice.state(Space, f.log)
    assert state.admin_actions == "catalog_bootstrap_v1"
    refute Map.has_key?(state, :catalog_controls)
    assert Log.fetch(f.log, f.bootstrap.id) == {:ok, f.bootstrap}
  end

  test "the actual callback refuses same-shaped wrong root, pin and profile bindings" do
    f = CatalogVectors.bootstrap_history()

    for record <- [
          %{f.record | space_root: f.nominee.pub},
          %{f.record | space: "another-space"},
          %{f.record | profile_genesis: f.genesis.id},
          %{f.record | profile_id: f.genesis.id}
        ] do
      op =
        Op.new(f.root, f.replica, [f.pin.id], :command, {:catalog_bootstrap_v1, [record]},
          cap: f.delegation.id
        )

      log = Log.append!(f.before, op)
      assert Authority.analyze(Space, log).reasons[op.id] == :application_invalid_catalog
      assert Lattice.state(Space, log).admin_actions == "create_space"
    end
  end

  test "the root-only preview preserves its original explicit capability ceiling" do
    f = CatalogVectors.bootstrap_history()

    assert {:ok, %{pending: [genesis, _]}} =
             Space.prepare_creation(f.root, "treehouse:legacy-preview", "Canopy")

    {:genesis, d, %{}} = genesis.body

    assert d.ops ==
             MapSet.new([
               :create_space,
               :create_thread,
               :issue_invitation,
               :revoke_invitation,
               :admit_member,
               :remove_member
             ])
  end

  test "Sim's explicit genesis ceiling restricts commands while omission keeps the registry default" do
    sim = Sim.new(Space, "treehouse:sim-ceiling", ["root"], seed: "r11a-sim-ceiling")
    {_default, default_genesis} = Sim.create_replica(sim, "root")
    {:genesis, full, _} = default_genesis.body
    assert full.ops == MapSet.new(Enum.map(Space.__lattice_commands__(), &elem(&1, 0)))
    {limited, genesis} = Sim.create_replica(sim, "root", ops: [:create_space])
    {:genesis, d, _} = genesis.body
    assert d.ops == MapSet.new([:create_space])
    {limited, allowed} = Sim.command(limited, "root", :create_space, ["Canopy"], cap: d.id)
    assert Sim.quarantined(limited, "root", allowed.id) == false

    {limited, excluded} =
      Sim.command(limited, "root", :create_thread, ["thread:one", "One"], cap: d.id)

    assert Sim.quarantined(limited, "root", excluded.id) == {true, :operation_not_granted}
  end
end
