defmodule Lattice.BrowserLogStoreTest do
  use ExUnit.Case, async: true

  alias Lattice.BrowserLogStore
  alias Lattice.Demo.Thread
  alias Lattice.Log
  alias Lattice.Sim

  test "snapshot payload is JSON-safe and restores a log" do
    sim = Sim.new(Thread, "replica:browser-store", ["tab"], seed: "browser-store")
    {sim, _} = Sim.create_replica(sim, "tab")
    {sim, _} = Sim.command(sim, "tab", :post, ["offline"])
    log = Sim.log(sim, "tab")

    payload = BrowserLogStore.dump_payload(log)

    assert payload["schema"] == "lattice-browser-log-v1"
    assert is_list(payload["ops"])
    assert {:ok, %Log{} = restored} = BrowserLogStore.restore_payload(payload)
    assert Log.op_ids(restored) == Log.op_ids(log)
  end
end
