defmodule Treehouse.CatalogRawRetentionTest do
  use ExUnit.Case, async: true
  alias Lattice.Carrier.Wire
  alias Lattice.{Log, Op}
  alias Treehouse.{CatalogCutoff, CatalogTrust, CatalogTrustVectors}
  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @expected %{trust_revision: 0, history_generation: 0}

  test "fresh TS raw aliases cannot replace retained frames or satisfy exact proof membership" do
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
      Op.new(f.space.root, f.space.replica, [f.space.bootstrap.id], :command, 1)
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
      control: control
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

    for {name, frame} <- [
          {"exact", control},
          {"object-key-order", control},
          {"small-text", Map.put(control, "body", ["int", "1"])},
          {"dependency-alias", dup}
        ] do
      d = evaluate(base.next, %{page() | histories: [%{history | frames: [frame]}]})
      exact = name in ["exact", "object-key-order"]
      assert d.kind == if(exact, do: :unchanged, else: :reject)
      assert d.reason == if(exact, do: nil, else: :invalid_verified_history)
      assert d.detail.ids == if(exact, do: [], else: [control["id"]])
      peer = Enum.find(raw["results"], &(&1["name"] == name))
      assert Atom.to_string(d.kind) == peer["kind"]
      if exact, do: assert(d.next == base.next)
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

    assert d.kind == :reject
    assert d.reason == :recovery_incomplete
    assert d.detail.ids == [derived.cutoff.log_digest]
  end

  defp page, do: %{catalogs: [], rotations: [], histories: [], cutoff_proofs: []}

  defp evaluate(installed, incoming),
    do: CatalogTrust.evaluate(%{installed: installed, expected: @expected, incoming: incoming})
end
