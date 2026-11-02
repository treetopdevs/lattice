defmodule Treehouse.CatalogReplacementClaimTest do
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Wire
  alias Lattice.{Identity, Log, Op}
  alias Treehouse.{CatalogCutoff, CatalogReplacementVectors}
  alias Treehouse.TransportCatalog, as: Catalog

  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @vector Path.join(@client, "test/vectors/catalog/replacement_v1.json")
  @exporter "test/support/export_treehouse_catalog_replacement.ts"
  @max_safe 9_007_199_254_740_991

  setup_all do
    {:ok, f: CatalogReplacementVectors.fixture()}
  end

  defp malformed(claim),
    do: Catalog.normalize_replacement_claim(claim) == {:error, :malformed_catalog}

  defp ok(claim), do: Catalog.normalize_replacement_claim(claim) == {:ok, claim}

  defp id(label),
    do: :crypto.hash(:sha256, "r316-claim-" <> label) |> Base.url_encode64(padding: false)

  test "closed field set", %{f: f} do
    assert ok(f.claim)

    for key <- Map.keys(f.claim) do
      assert malformed(Map.delete(f.claim, key)), "missing #{key}"
    end

    assert malformed(Map.put(f.claim, :extra, 1))
    assert malformed(Map.put(f.claim, :binding, f.bootstrap.id))
    assert malformed(%{f.claim | version: 2})
    # 1.0 == 1 in Elixir; a float must refuse, not crash the canonical encoder later.
    assert malformed(%{f.claim | version: 1.0})
    sig = <<0::512>>

    assert Catalog.verify_replacement_possession(%{f.claim | version: 1.0}, sig, sig) ==
             {:error, :malformed_catalog}

    assert malformed(%{f.claim | product: :township})
    assert malformed(%{f.claim | space: ""})
    assert malformed(%{f.claim | bootstrap: "short"})
    assert malformed(%{f.claim | nonce: <<0::256>>})

    rotation = rotation(f)
    assert {:ok, _} = Catalog.normalize_rotation(rotation)
    assert malformed(rotation)
    assert Catalog.normalize_rotation(f.claim) == {:error, :malformed_catalog}
  end

  test "parents sorted, distinct, nonempty", %{f: f} do
    ids = Enum.map(1..17, &id("parent-#{&1}")) |> Enum.sort()
    two = Enum.take(ids, 2)
    sole = fn parents -> Enum.map(parents, &%{binding: &1, catalog: nil}) end

    assert ok(%{f.claim | parents: two, prior_catalogs: sole.(two)})
    sixteen = Enum.take(ids, 16)
    assert ok(%{f.claim | parents: sixteen, prior_catalogs: sole.(sixteen)})

    for parents <- [Enum.reverse(two), [hd(two), hd(two)], [], ids] do
      assert malformed(%{f.claim | parents: parents, prior_catalogs: sole.(Enum.uniq(parents))})
    end

    assert malformed(%{f.claim | parents: ["not-an-id"]})
  end

  test "prior_catalogs", %{f: f} do
    [a, b] = Enum.sort([id("binding-a"), id("binding-b")])
    [c1, c2] = Enum.sort([id("catalog-1"), id("catalog-2")])
    claim = %{f.claim | parents: [a, b]}
    with_prior = fn entries -> %{claim | prior_catalogs: entries} end

    assert ok(with_prior.([%{binding: a, catalog: c1}, %{binding: b, catalog: nil}]))
    # A forked catalog chain under one binding cites both heads.
    assert ok(
             with_prior.([
               %{binding: a, catalog: c1},
               %{binding: a, catalog: c2},
               %{binding: b, catalog: c1}
             ])
           )

    # Unsorted or duplicate.
    assert malformed(with_prior.([%{binding: b, catalog: nil}, %{binding: a, catalog: c1}]))

    assert malformed(
             with_prior.([
               %{binding: a, catalog: c2},
               %{binding: a, catalog: c1},
               %{binding: b, catalog: nil}
             ])
           )

    assert malformed(
             with_prior.([
               %{binding: a, catalog: c1},
               %{binding: a, catalog: c1},
               %{binding: b, catalog: nil}
             ])
           )

    # A parent without an entry, and an entry for a non-parent binding.
    assert malformed(with_prior.([%{binding: a, catalog: c1}]))
    assert malformed(%{f.claim | prior_catalogs: [%{binding: a, catalog: nil}]})
    # nil only as the sole entry for its binding; nil sorts before an ID.
    assert malformed(
             with_prior.([
               %{binding: a, catalog: nil},
               %{binding: a, catalog: c1},
               %{binding: b, catalog: nil}
             ])
           )

    assert malformed(
             with_prior.([
               %{binding: a, catalog: c1},
               %{binding: a, catalog: nil},
               %{binding: b, catalog: nil}
             ])
           )

    assert ok(with_prior.([%{binding: a, catalog: nil}, %{binding: b, catalog: nil}]))
    assert Enum.sort([{a, c1}, {a, nil}]) == [{a, nil}, {a, c1}]
    # Closed entry maps and bounds.
    assert malformed(
             with_prior.([%{binding: a, catalog: c1, extra: 1}, %{binding: b, catalog: nil}])
           )

    assert malformed(with_prior.([%{binding: a, catalog: "bad"}, %{binding: b, catalog: nil}]))
    assert malformed(with_prior.([]))

    many = Enum.map(1..33, &id("catalog-many-#{&1}")) |> Enum.sort()

    assert malformed(%{
             f.claim
             | prior_catalogs: Enum.map(many, &%{binding: f.bootstrap.id, catalog: &1})
           })

    assert ok(%{
             f.claim
             | prior_catalogs:
                 Enum.map(Enum.take(many, 32), &%{binding: f.bootstrap.id, catalog: &1})
           })
  end

  test "generation safe positive integer", %{f: f} do
    for bad <- [0, -1, @max_safe + 1, 1.0] do
      assert malformed(%{f.claim | generation: bad})
    end

    assert ok(%{f.claim | generation: 1})
    assert ok(%{f.claim | generation: @max_safe})
  end

  test "keys and origin", %{f: f} do
    assert malformed(%{f.claim | new_service_key: f.claim.new_catalog_key})
    assert malformed(%{f.claim | new_catalog_key: binary_part(f.claim.new_catalog_key, 0, 31)})
    assert malformed(%{f.claim | new_service_key: binary_part(f.claim.new_service_key, 0, 31)})
    assert malformed(%{f.claim | author: binary_part(f.claim.author, 0, 31)})

    for origin <- [
          "ws://relay.invalid",
          "wss://relay.invalid:443",
          "wss://10.0.0.1",
          "wss://Relay.invalid"
        ] do
      assert malformed(%{f.claim | new_origin: origin})
    end

    assert malformed(%{f.claim | new_service_id: "short"})
    assert malformed(%{f.claim | cap: nil})
    assert malformed(%{f.claim | deps: []})
    assert malformed(%{f.claim | deps: Enum.reverse(Enum.sort([id("d1"), id("d2")]))})
    assert malformed(%{f.claim | epoch_basis: []})
    assert malformed(%{f.claim | epoch: -1})
    assert ok(%{f.claim | epoch: 0})
    assert malformed(%{f.claim | cutoffs: []})
  end

  test "possession under the new keys", %{f: f} do
    claim = f.claim
    cp = f.catalog_possession
    sp = f.service_possession
    assert :ok = Catalog.verify_replacement_possession(claim, cp, sp)
    assert {:error, :invalid_possession} = Catalog.verify_replacement_possession(claim, sp, cp)

    service_as_catalog =
      Identity.sign(f.new_catalog, Catalog.replacement_possession_bytes(:service, claim))

    assert {:error, :invalid_possession} =
             Catalog.verify_replacement_possession(claim, service_as_catalog, sp)

    for {key, value} <- [
          generation: 2,
          nonce: id("other-nonce"),
          new_origin: "wss://other.invalid",
          epoch: 2,
          holder_epoch: f.bootstrap.id,
          new_service_id: id("other-service")
        ] do
      assert {:error, :invalid_possession} =
               Catalog.verify_replacement_possession(Map.put(claim, key, value), cp, sp),
             "changed #{key}"
    end

    assert {:error, :malformed_catalog} =
             Catalog.verify_replacement_possession(claim, :admin, sp)

    assert {:error, :malformed_catalog} =
             Catalog.verify_replacement_possession(claim, binary_part(cp, 0, 63), sp)

    assert {:error, :malformed_catalog} =
             Catalog.verify_replacement_possession(Map.put(claim, :extra, 1), cp, sp)

    assert_raise ArgumentError, fn -> Catalog.replacement_possession_bytes(:binding, claim) end
  end

  test "rotation and replacement possession bytes refuse each other", %{f: f} do
    assert_raise ArgumentError, fn -> Catalog.rotation_possession_bytes(f.claim) end

    assert_raise ArgumentError, fn ->
      Catalog.replacement_possession_bytes(:catalog, rotation(f))
    end

    assert_raise ArgumentError, fn -> Catalog.replacement_claim_bytes(rotation(f)) end
  end

  test "BEAM-written replacement_v1.json equals regeneration" do
    vector = CatalogReplacementVectors.vector()
    assert File.read!(@vector) == CatalogReplacementVectors.encode(vector)
    assert {:ok, claim} = Wire.decode_value(vector["claim_term"])
    assert {:ok, ^claim} = Catalog.normalize_replacement_claim(claim)
    assert Base.encode64(Catalog.replacement_claim_bytes(claim)) == vector["claim_bytes"]
    assert {:ok, ops} = Wire.decode_ops(vector["frames"])
    assert List.last(ops).id == vector["binding_id"]

    assert MapSet.new(vector["stage_a"], & &1["reason"]) ==
             MapSet.new(["application_invalid_catalog"])

    for negative <- vector["negative"] do
      assert {:ok, term} = Wire.decode_value(negative["claim_term"])

      result =
        case negative["result"] do
          "malformed_catalog" ->
            Catalog.normalize_replacement_claim(term)

          "invalid_possession" ->
            Catalog.verify_replacement_possession(
              term,
              Base.decode64!(negative["catalog_possession"]),
              Base.decode64!(negative["service_possession"])
            )
        end

      assert result == {:error, String.to_existing_atom(negative["result"])}, negative["name"]
    end
  end

  @tag :tmp_dir
  test "TS-signed claim verifies in BEAM", %{tmp_dir: dir} do
    path = Path.join(dir, "ts_replacement.json")

    {output, status} =
      System.cmd(Path.join(@client, "node_modules/.bin/tsx"), [@exporter, "--out", path],
        cd: @client,
        stderr_to_stdout: true
      )

    assert status == 0, output
    ts = path |> File.read!() |> Jason.decode!()

    assert {:ok, claim} = Wire.decode_value(ts["claim_term"])
    assert {:ok, ^claim} = Catalog.normalize_replacement_claim(claim)
    assert Base.encode64(Catalog.replacement_claim_bytes(claim)) == ts["claim_bytes"]

    assert Base.encode64(Catalog.replacement_possession_bytes(:catalog, claim)) ==
             ts["catalog_possession_bytes"]

    assert Base.encode64(Catalog.replacement_possession_bytes(:service, claim)) ==
             ts["service_possession_bytes"]

    assert claim.new_catalog_key == Base.decode64!(ts["catalog_key"])
    assert claim.new_service_key == Base.decode64!(ts["service_key"])

    assert :ok =
             Catalog.verify_replacement_possession(
               claim,
               Base.decode64!(ts["catalog_possession"]),
               Base.decode64!(ts["service_possession"])
             )

    assert {:ok, entries} = Wire.decode_value(ts["inventory_term"])
    assert Base.encode64(Catalog.inventory_bytes(entries)) == ts["inventory_bytes"]
    assert Catalog.inventory_id(entries) == claim.inventory_digest

    # The cutoff pre-hash bytes, including the TS-supplied bad-signature evidence.
    cutoff = ts["cutoff"]
    log = cutoff_log(cutoff)
    assert {:ok, derived} = CatalogCutoff.derive(log)
    assert derived.rejected != []
    assert Base.encode64(derived.canonical_bytes) == cutoff["canonical_bytes"]
    assert derived.cutoff.log_digest == cutoff["log_digest"]
    assert derived.cutoff.frontier == cutoff["frontier"]
    assert claim.cutoffs == [derived.cutoff]

    # Stage A parity: TS-authored frames judged by BEAM give TS's reasons.
    assert {:ok, ops} = Wire.decode_ops(ts["frames"])
    base = Log.from_ops(ts["replica"], Map.new(ops, &{&1.id, &1}))
    assert Lattice.Authority.analyze(Treehouse.Space, base).reasons == %{}
    assert List.last(Log.topo_ops(base)).id == ts["binding_id"]

    assert length(ts["stage_a"]) == 16

    for c <- ts["stage_a"] do
      assert c["reason"] == "application_invalid_catalog", c["name"]
      {:ok, prefix} = Wire.decode_ops(c["prefix"])
      {:ok, op} = Wire.decode_op(c["frame"])

      log =
        Enum.reduce(
          prefix ++ [op],
          Log.from_ops(ts["replica"], before_binding(base, ts)),
          &Log.append!(&2, &1)
        )

      assert to_string(Lattice.Authority.analyze(Treehouse.Space, log).reasons[op.id]) ==
               c["reason"],
             c["name"]
    end
  end

  defp before_binding(log, ts), do: Map.delete(log.ops, ts["binding_id"])

  defp cutoff_log(cutoff) do
    log =
      Enum.reduce(cutoff["rejected_frames"], Log.new(cutoff["replica"]), fn rejected, log ->
        assert {:ok, op} = Wire.decode_op(rejected["frame"])
        assert {:quarantined, retained, :bad_signature} = Log.accept(log, op)
        retained
      end)

    assert {:ok, ops} = Wire.decode_ops(cutoff["frames"])
    assert Enum.all?(ops, &Op.valid?/1)
    Enum.reduce(ops, log, &Log.append!(&2, &1))
  end

  defp rotation(f) do
    %{
      version: 1,
      product: :treehouse,
      space: f.replica,
      bootstrap: f.bootstrap.id,
      parent: f.bootstrap.id,
      prior_catalog: id("prior"),
      generation: 1,
      new_catalog_key: f.new_catalog.pub,
      nonce: f.claim.nonce,
      inventory_digest: f.claim.inventory_digest,
      cutoffs: f.claim.cutoffs
    }
  end
end
