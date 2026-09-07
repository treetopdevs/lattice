defmodule Treehouse.CatalogCutoffVocabularyTest do
  use ExUnit.Case, async: true

  alias Lattice.{Log, Op, Sync}
  alias Lattice.Carrier.Wire
  alias Treehouse.{CatalogCutoff, CatalogTrust, CatalogTrustVectors, MemberContinuityCertificate}

  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @expected %{trust_revision: 0, history_generation: 0}
  @artifacts [
    {"cutoff_atoms_v1.json", 130, "a66d085dd185091d745d933c3145101a97b3306406aba905af07ca051d09506c"},
    {"cutoff_atoms_member_continuity_v1.json", 9, "38aab5c25051af1d009c917274cdf68ae4f61776ebef0bf3634ad3899b9ce8df"},
    {"cutoff_atoms_with_member_continuity_v1.json", 139, "e7e7e16800327ca76b68ddabf7015c84b1750a327def5c0366c4e37f4ed7aaac"}
  ]

  test "historical and additive hashes bind the exact three compiled vocabularies" do
    [old, added, union] = for {file, count, hash} <- @artifacts do
      bytes = File.read!(Path.join(@client, "test/vectors/catalog/" <> file))
      assert Base.encode16(:crypto.hash(:sha256, bytes), case: :lower) == hash
      names = Jason.decode!(bytes)
      assert length(names) == count
      assert Enum.sort(Enum.uniq(names)) == names
      names
    end
    assert MapSet.disjoint?(MapSet.new(old), MapSet.new(added))
    assert Enum.sort(old ++ added) == union
    for name <- ["catalog_cutoff", "catalog_trust"] do
      source = File.read!(Path.expand("../../lib/treehouse/" <> name <> ".ex", __DIR__))
      [_, literal] = Regex.run(~r/@cutoff_atoms MapSet.new\(~w\((.*?)\)a\)/s, source)
      assert String.split(literal) == union
    end
    source = File.read!(Path.join(@client, "src/treehouse_catalog_cutoff.ts"))
    [_, literal] = Regex.run(~r/const atoms = new Set\((\[.*?\])\);/s, source)
    assert Jason.decode!(literal) == union
  end

  test "signed nine and 139-name histories are portable while remaining ordinarily refused" do
    Code.ensure_loaded!(MemberContinuityCertificate)
    Code.ensure_loaded!(CatalogCutoff)
    fixture = CatalogTrustVectors.fixture(0)
    for {file, _, _} <- Enum.drop(@artifacts, 1) do
      atoms = @client |> Path.join("test/vectors/catalog/" <> file) |> File.read!() |> Jason.decode!() |> Enum.map(&String.to_existing_atom/1)
      op = Op.new(fixture.space.root, fixture.space.replica, Log.frontier(fixture.space_log), :command,
        {:attest_member_key_v1, [atoms]}, cap: fixture.space.delegation.id)
      for delivered <- [[op | Log.topo_ops(fixture.space_log)], Log.topo_ops(fixture.space_log) ++ [op]] do
        assert {:quarantined, rejected, :bad_signature} = Log.accept(Log.new(op.replica), %{op | sig: <<0::512>>})
        {log, %{pending: []}} = Sync.deliver(rejected, delivered)
        assert :ok = Log.verify_authenticity(log)
        assert {:ok, cutoff} = CatalogCutoff.derive(log)
        assert Enum.any?(cutoff.ops, &(&1.id == op.id))
        assert [%{id: id, sig: <<0::512>>}] = cutoff.rejected
        assert id == op.id
        assert Lattice.Authority.analyze(Treehouse.Space, log).reasons[op.id] == :unknown_command
        assert Lattice.state(Treehouse.Space, log) == Lattice.state(Treehouse.Space, fixture.space_log)
      end
    end
  end

  test "raw trust installation and reopen retain new-name signed and rejected evidence" do
    Code.ensure_loaded!(MemberContinuityCertificate)
    fixture = CatalogTrustVectors.fixture(1)
    atoms = @client |> Path.join("test/vectors/catalog/cutoff_atoms_member_continuity_v1.json") |> File.read!() |> Jason.decode!() |> Enum.map(&String.to_existing_atom/1)
    op = Op.new(fixture.space.root, fixture.space.replica, Log.frontier(fixture.space_log), :command,
      {:attest_member_key_v1, [atoms]}, cap: fixture.space.delegation.id)
    assert {:quarantined, rejected, :bad_signature} = Log.accept(fixture.space_log, %{op | sig: <<0::512>>})
    log = Log.append!(rejected, op)
    raw = CatalogTrustVectors.raw_history(log)
    for frames <- [raw.frames, Enum.reverse(raw.frames)] do
      history = %{raw | frames: frames}
      assert %{kind: :propose, next: prepared} = CatalogTrust.prepare_installation(%{review: fixture.review,
        history: history, store: %{kind: :verified_fresh, expected: @expected}})
      histories = [history | Enum.reject(fixture.histories, &(&1.replica == op.replica))]
      assert %{kind: :propose, next: installed, routes: routes} = evaluate(prepared, [fixture.catalog_json], histories)
      assert length(routes) == 2
      retained = Enum.find(installed.histories, &(&1.replica == op.replica))
      assert Enum.any?(retained.frames, &(&1["id"] == op.id))
      assert Enum.any?(retained.rejected, &(&1.frame["id"] == op.id and &1.frame["sig"] == Base.encode64(<<0::512>>)))
      assert %{kind: :unchanged, next: ^installed} = evaluate(installed, [], [])
    end
    for atom <- [:cutoff_unknown_evidence_v99, :claim_id] do
      unsupported = Op.new(fixture.space.root, op.replica, Log.frontier(log), :command, atom)
      bad = %{raw | frames: raw.frames ++ [Wire.encode_op(unsupported)]}
      assert %{kind: :reject, reason: :unsupported_cutoff} = CatalogTrust.prepare_installation(%{review: fixture.review,
        history: bad, store: %{kind: :verified_fresh, expected: @expected}})
    end
    forged = %{raw | frames: Enum.map(raw.frames, fn frame -> if frame["id"] == op.id, do: Map.put(frame, "sig", Base.encode64(<<0::512>>)), else: frame end)}
    assert %{kind: :reject, reason: :invalid_verified_history} = CatalogTrust.prepare_installation(%{review: fixture.review,
      history: forged, store: %{kind: :verified_fresh, expected: @expected}})
  end

  defp evaluate(installed, catalogs, histories), do: CatalogTrust.evaluate(%{installed: installed, expected: @expected,
    incoming: %{catalogs: catalogs, histories: histories, rotations: [], cutoff_proofs: []}})
end
