defmodule Lattice.BrowserLogStoreTest do
  use ExUnit.Case, async: true

  alias Lattice.BrowserLogStore
  alias Lattice.Demo.Thread
  alias Lattice.Identity
  alias Lattice.Log
  alias Lattice.Op
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

  test "snapshot payload preserves structural quarantine across restore" do
    identity = Identity.from_seed("tab", "browser-store-quarantine")
    replica = "replica:browser-store-quarantine"
    genesis = Op.new(identity, replica, [], :command, {:post, "genesis"})
    genuine = Op.new(identity, replica, [genesis.id], :command, {:post, "real"})
    forged = %{genuine | body: {:post, "forged"}}

    {log, report} =
      replica
      |> Log.new()
      |> Log.append!(genesis)
      |> Lattice.Sync.deliver([forged])

    assert [{forged.id, :bad_signature}] == report.quarantined

    payload = BrowserLogStore.dump_payload(log)

    assert [%{"reason" => "bad_signature"}] = payload["quarantine"]
    assert {:ok, restored} = BrowserLogStore.restore_payload(payload)
    assert Log.op_ids(restored) == Log.op_ids(log)
    assert [%{op: ^forged, reason: :bad_signature}] = Log.quarantine(restored)
  end

  test "restore reports corrupted accepted op payloads instead of silently dropping them" do
    identity = Identity.from_seed("tab", "browser-store-corrupt")
    replica = "replica:browser-store-corrupt"
    op = Op.new(identity, replica, [], :command, {:post, "real"})
    payload = BrowserLogStore.dump_payload(Log.append!(Log.new(replica), op))

    corrupted =
      put_in(payload, ["ops", Access.at(0), "body"], [
        "tuple",
        [["atom", "post"], ["bin", Base.encode64("forged")]]
      ])

    op_id = op.id

    assert {:error, {:restore_report, %{quarantined: [{^op_id, :bad_signature}]}}} =
             BrowserLogStore.restore_payload(corrupted)
  end
end
