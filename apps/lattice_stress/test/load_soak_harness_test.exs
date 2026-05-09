defmodule LatticeStress.LoadSoakHarnessTest do
  use ExUnit.Case, async: false

  alias LatticeStress.ProbeTab

  setup do
    Lattice.reset!()
    :ok
  end

  test "lifecycle soak leaves no active caps, connected tabs, or live workers" do
    tabs =
      for i <- 1..60 do
        {:ok, _pid, tab} = ProbeTab.connect(identity: %{soak: i})
        {:ok, worker} = Lattice.spawn_linked(tab.id, Lattice.Demo.TabWorker, [], [])
        {:ok, cap} = Lattice.grant(tab.id, self(), [:call])
        %{tab: tab, worker: worker, cap: cap}
      end

    Enum.each(tabs, fn %{tab: tab} -> Lattice.disconnect_tab(tab.id) end)

    Enum.each(tabs, fn %{worker: worker, tab: tab, cap: cap} ->
      refute Process.alive?(worker)
      assert {:error, :revoked} = Lattice.call(tab.id, cap, %{after_soak: true})
    end)

    diagnostics = Lattice.diagnostics()
    assert 0 = map_size(diagnostics.caps.active_caps)
    assert 0 = MapSet.size(diagnostics.topology.connected_tab_ids)
  end

  test "mix lattice.stress harness runs a small adversarial load and cleans up" do
    Mix.Tasks.Lattice.Stress.run([
      "--tabs",
      "8",
      "--caps",
      "16",
      "--calls",
      "120",
      "--bridges",
      "8",
      "--concurrency",
      "8"
    ])

    diagnostics = Lattice.diagnostics()
    assert 0 = map_size(diagnostics.caps.active_caps)
    assert 0 = MapSet.size(diagnostics.topology.connected_tab_ids)
  end
end
