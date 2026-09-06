defmodule Treehouse.CatalogCutoffTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Canonical, Log, Op, Sim}
  alias Treehouse.{CatalogCutoff, Space}

  test "cutoff binds exact authenticated operations including semantic quarantine" do
    f = history()
    assert Authority.analyze(Space, f.log).reasons[f.denied.id] == :malformed_command
    assert {:ok, result} = CatalogCutoff.derive(f.log)

    expected_ops =
      f.log
      |> Log.ops()
      |> Map.values()
      |> Enum.sort_by(& &1.id)
      |> Enum.map(&%{id: &1.id, bytes: Canonical.op_payload(&1), sig: &1.sig})

    bytes =
      Canonical.term(["lattice-treehouse-recovery-cutoff-v1", f.log.replica, expected_ops, []])

    assert result.ops == expected_ops
    assert result.rejected == []
    assert result.canonical_bytes == bytes

    assert result.cutoff == %{
             replica: f.log.replica,
             frontier: Log.frontier(f.log),
             log_digest: :crypto.hash(:sha256, bytes) |> Base.url_encode64(padding: false)
           }

    assert Enum.any?(result.ops, &(&1.id == f.denied.id))
  end

  test "rejected signature evidence survives alongside a subsequently accepted genuine op" do
    f = history()

    genuine =
      Op.new(f.root, f.log.replica, Log.frontier(f.log), :command, {:create_space, ["Retained"]},
        cap: f.cap
      )

    forged = %{genuine | sig: <<0::512>>}
    assert {:quarantined, with_bad, :bad_signature} = Log.accept(f.log, forged)
    assert {:ok, both} = Log.accept(with_bad, genuine)
    before = :erlang.term_to_binary(both)
    assert {:ok, result} = CatalogCutoff.derive(both)

    assert result.rejected == [
             %{
               id: forged.id,
               bytes: Canonical.op_payload(forged),
               sig: forged.sig,
               reason: :bad_signature
             }
           ]

    assert Enum.any?(result.ops, &(&1.id == genuine.id and &1.sig == genuine.sig))
    assert {:ok, without_bad} = CatalogCutoff.derive(Log.append!(f.log, genuine))
    refute result.cutoff.log_digest == without_bad.cutoff.log_digest
    assert :erlang.term_to_binary(both) == before
  end

  test "incomplete or forged accepted history refuses without repairing the source" do
    f = history()

    for bad <- [
          %{f.log | ops: Map.delete(f.log.ops, f.genesis.id)},
          %{f.log | ops: Map.put(f.log.ops, f.denied.id, %{f.denied | sig: <<0::512>>})},
          %{f.log | referenced: MapSet.new()},
          %{f.log | quarantine: [%{reason: :bad_signature}]}
        ] do
      before = :erlang.term_to_binary(bad)
      assert {:error, :invalid_verified_history} = CatalogCutoff.derive(bad)
      assert :erlang.term_to_binary(bad) == before
    end
  end

  test "broader in-VM rejected evidence cannot be silently omitted from a portable cutoff" do
    f = history()
    unsupported = %{f.denied | id: "unsupported-evidence", body: self()}
    assert {:quarantined, log, :bad_signature} = Log.accept(f.log, unsupported)
    assert :ok = Log.verify_authenticity(log)
    before = :erlang.term_to_binary(log)
    assert {:error, :unsupported_cutoff} = CatalogCutoff.derive(log)
    assert :erlang.term_to_binary(log) == before
  end

  defp history do
    sim = Sim.new(Space, "treehouse:cutoff", ["root"], seed: "r11a-cutoff")
    {sim, genesis} = Sim.create_replica(sim, "root")
    {:genesis, delegation, _} = genesis.body
    {sim, _name} = Sim.command(sim, "root", :create_space, ["Canopy"], cap: delegation.id)
    root = Sim.identity(sim, "root")
    log = Map.fetch!(sim.logs, "root")

    denied =
      Op.new(root, log.replica, Log.frontier(log), :command, {:create_thread, [[], "Invalid"]},
        cap: delegation.id
      )

    %{
      log: Log.append!(log, denied),
      genesis: genesis,
      root: root,
      denied: denied,
      cap: delegation.id
    }
  end
end
