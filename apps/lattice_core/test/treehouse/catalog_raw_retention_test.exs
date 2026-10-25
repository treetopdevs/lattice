defmodule Treehouse.CatalogRawRetentionTest do
  use ExUnit.Case, async: true
  alias Lattice.Carrier.Wire
  alias Lattice.{Log, Op}
  alias Treehouse.{CatalogCutoff, CatalogTrust, CatalogTrustVectors}
  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @expected %{trust_revision: 0, history_generation: 0}

  test "fresh TS raw aliases coalesce without replacing retained bytes or wedging proof membership" do
    {json, 0} =
      System.cmd("node", ["--import", "tsx", "test/support/catalog_raw_retention_peer.ts"],
        cd: @client
      )

    check_bundle(Jason.decode!(json))
  end

  test "fresh BEAM aliases and exact controls agree in the actual client" do
    f = CatalogTrustVectors.fixture(0)
    h = hd(f.histories)

    control =
      Op.new(
        f.space.root,
        f.space.replica,
        [f.space.bootstrap.id, Enum.find(h.frames, &(&1["id"] != f.space.bootstrap.id))["id"]],
        :command,
        %{version: 1, epoch: 2}
      )
      |> Wire.encode_op()

    r = f.review

    b = %{
      review: %{
        version: 1,
        product: "treehouse",
        space: r.space,
        spaceRoot: Base.encode64(r.space_root),
        bootstrapId: r.bootstrap_id,
        observedBootstrapIds: r.observed_bootstrap_ids,
        disposition: "pin_exact_observed_bootstrap"
      },
      history: %{h | frames: h.frames ++ [control]},
      catalogJson: f.catalog_json,
      control: control,
      wrongHistory: %{
        replica: "outside-treehouse-family",
        frames: [
          Op.new(f.space.root, "outside-treehouse-family", [], :command, 1) |> Wire.encode_op()
        ],
        rejected: []
      }
    }

    directory =
      Path.join(System.tmp_dir!(), "raw-retention-#{System.unique_integer([:positive])}")

    File.mkdir_p!(directory)
    on_exit(fn -> File.rm_rf!(directory) end)
    path = Path.join(directory, "beam.json")
    File.write!(path, Jason.encode!(b))

    {json, 0} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/catalog_raw_retention_peer.ts", "consume", path],
        cd: @client
      )

    check_bundle(Jason.decode!(json))
  end

  defp check_bundle(raw) do
    b = raw["bundle"]
    r = b["review"]

    review = %{
      version: 1,
      product: :treehouse,
      space: r["space"],
      space_root: Base.decode64!(r["spaceRoot"]),
      bootstrap_id: r["bootstrapId"],
      observed_bootstrap_ids: r["observedBootstrapIds"],
      disposition: :pin_exact_observed_bootstrap
    }

    history = %{replica: b["history"]["replica"], frames: b["history"]["frames"], rejected: []}

    prepared =
      CatalogTrust.prepare_installation(%{
        review: review,
        history: history,
        store: %{kind: :verified_fresh, expected: @expected}
      })

    assert prepared.kind == :propose
    base = evaluate(prepared.next, %{page() | histories: [history], catalogs: [b["catalogJson"]]})
    assert base.kind == :propose
    assert base.next.accepted.revision == 0
    assert length(base.routes) == 1
    control = b["control"]
    dup = Map.put(control, "deps", control["deps"] ++ [hd(control["deps"])])

    ["map", pairs] = control["body"]

    small =
      Map.put(control, "body", [
        "map",
        Enum.map(pairs, fn
          [key, ["int", 1]] -> [key, ["int", "1"]]
          pair -> pair
        end)
      ])

    mapped = Map.put(control, "body", ["map", Enum.reverse(pairs)])

    for {name, frame} <- [
          {"exact", control},
          {"object-key-order", control},
          {"small-text", small},
          {"dependency-alias", dup},
          {"dependency-order", Map.put(control, "deps", Enum.reverse(control["deps"]))},
          {"map-order", mapped}
        ] do
      d = evaluate(base.next, %{page() | histories: [%{history | frames: [frame]}]})
      assert d.kind == :unchanged
      assert d.reason == nil
      assert d.detail.ids == []
      peer = Enum.find(raw["results"], &(&1["name"] == name))
      assert Atom.to_string(d.kind) == peer["kind"]
      assert d.next == base.next
    end

    alias_history = %{
      history
      | frames: Enum.map(history.frames, &if(&1["id"] == control["id"], do: dup, else: &1))
    }

    ops =
      Enum.map(history.frames, fn frame ->
        {:ok, op} = Wire.decode_op(frame)
        op
      end)

    log = %Log{
      replica: history.replica,
      ops: Map.new(ops, &{&1.id, &1}),
      referenced: MapSet.new(Enum.flat_map(ops, & &1.deps))
    }

    assert Log.verify_authenticity(log) == :ok
    assert {:ok, derived} = CatalogCutoff.derive(log)

    d =
      evaluate(base.next, %{
        page()
        | cutoff_proofs: [%{cutoff: derived.cutoff, history: alias_history}]
      })

    assert d.kind == :propose
    assert d.reason == nil
    assert d.next.histories == base.next.histories
    assert evaluate(d.next, page()).kind == :unchanged

    pin =
      CatalogTrust.prepare_installation(%{
        review: review,
        history: %{
          alias_history
          | frames:
              Enum.map(
                alias_history.frames,
                &if(&1["id"] == control["id"], do: Map.put(mapped, "deps", dup["deps"]), else: &1)
              )
        },
        store: %{kind: :verified_fresh, expected: @expected}
      })

    assert pin.kind == :propose
    first = evaluate(pin.next, %{page() | catalogs: [b["catalogJson"]]})
    assert first.kind == :propose

    honest =
      evaluate(first.next, %{
        page()
        | histories: [%{history | frames: [control]}],
          cutoff_proofs: [%{cutoff: derived.cutoff, history: history}]
      })

    assert honest.kind == :propose
    assert honest.reason == nil
    assert length(honest.routes) == 1
    assert honest.next.histories == first.next.histories
    assert evaluate(honest.next, page()).kind == :unchanged

    for frames <- [[dup, dup], [dup, control, control], [control, control, dup], [nil]] do
      bad = evaluate(base.next, %{page() | histories: [%{history | frames: frames}]})
      assert bad.kind == :reject
      assert bad.reason == :invalid_verified_history
      assert bad.detail.ids == []
    end

    wrong = b["wrongHistory"]
    wrong_history = %{replica: wrong["replica"], frames: wrong["frames"], rejected: []}
    damaged = %{base.next | histories: base.next.histories ++ [wrong_history]}
    recovery = evaluate(damaged, %{page() | histories: [history]})
    assert recovery.kind == :reject
    assert recovery.reason == :trust_recovery_required
    assert recovery.detail.ids == []

    wrong_ops =
      Enum.map(wrong_history.frames, fn frame ->
        {:ok, op} = Wire.decode_op(frame)
        op
      end)

    wrong_log = %Log{replica: wrong_history.replica, ops: Map.new(wrong_ops, &{&1.id, &1})}
    assert {:ok, wrong_cutoff} = CatalogCutoff.derive(wrong_log)

    wrong_proof =
      evaluate(base.next, %{
        page()
        | cutoff_proofs: [%{cutoff: wrong_cutoff.cutoff, history: wrong_history}]
      })

    assert wrong_proof.kind == :reject
    assert wrong_proof.reason == :recovery_incomplete
    assert wrong_proof.detail.ids == []
  end

  defp page, do: %{catalogs: [], rotations: [], histories: [], cutoff_proofs: []}

  defp evaluate(installed, incoming),
    do: CatalogTrust.evaluate(%{installed: installed, expected: @expected, incoming: incoming})
end
