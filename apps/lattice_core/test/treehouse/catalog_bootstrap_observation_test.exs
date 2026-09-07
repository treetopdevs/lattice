defmodule Treehouse.CatalogBootstrapObservationTest do
  use ExUnit.Case, async: true

  alias Lattice.{Log, Op}
  alias Treehouse.{CatalogBootstrap, CatalogVectors}

  test "returns every honored bootstrap in deterministic order without electing trust" do
    f = CatalogVectors.bootstrap_history()
    second_record = %{f.record | origin: "wss://second-relay.invalid"}

    second =
      Op.new(f.root, f.replica, [f.pin.id], :command, {:catalog_bootstrap_v1, [second_record]},
        cap: f.delegation.id
      )

    forward = Log.append!(f.log, second)
    reverse = f.before |> Log.append!(second) |> Log.append!(f.bootstrap)
    assert {:ok, result} = CatalogBootstrap.observe(forward)
    assert CatalogBootstrap.observe(reverse) == {:ok, result}

    assert Enum.sort(result.bootstraps) ==
             Enum.sort([
               %{id: f.bootstrap.id, record: f.record},
               %{id: second.id, record: second_record}
             ])

    assert result.verified_frontier == Log.frontier(forward)
    refute Map.has_key?(result, :trusted_bootstrap)
  end

  test "full authority fold excludes a genuine but unauthorized bootstrap and retains its frontier" do
    f = CatalogVectors.bootstrap_history()

    invalid =
      Op.new(
        f.nominee,
        f.replica,
        [f.bootstrap.id],
        :command,
        {:catalog_bootstrap_v1, [f.record]},
        cap: f.delegation.id
      )

    log = Log.append!(f.log, invalid)
    before = :erlang.term_to_binary(log)
    assert {:ok, result} = CatalogBootstrap.observe(log)
    assert result.bootstraps == [%{id: f.bootstrap.id, record: f.record}]
    assert result.verified_frontier == [invalid.id]
    assert :erlang.term_to_binary(log) == before
  end

  test "verified rejected-signature evidence is retained without becoming an honored bootstrap" do
    f = CatalogVectors.bootstrap_history()
    forged = %{f.bootstrap | sig: <<0::512>>}
    assert {:quarantined, log, :bad_signature} = Log.accept(f.before, forged)
    before = :erlang.term_to_binary(log)
    assert {:ok, %{bootstraps: [], verified_frontier: frontier}} = CatalogBootstrap.observe(log)
    assert frontier == Log.frontier(f.before)
    assert :erlang.term_to_binary(log) == before
  end

  test "forged accepted operations, omitted closure and corrupt derived indexes refuse intact" do
    f = CatalogVectors.bootstrap_history()

    for log <- [
          %{f.log | ops: Map.delete(f.log.ops, f.genesis.id)},
          %{f.log | ops: Map.put(f.log.ops, f.bootstrap.id, %{f.bootstrap | sig: <<0::512>>})},
          %{f.log | referenced: MapSet.new()},
          %{f.log | quarantine: [%{reason: :bad_signature}]}
        ] do
      before = :erlang.term_to_binary(log)
      assert {:error, :invalid_verified_history} = CatalogBootstrap.observe(log)
      assert :erlang.term_to_binary(log) == before
    end
  end
end
