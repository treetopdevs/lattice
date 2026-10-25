defmodule Treehouse.CatalogIncomingRecoveryTest do
  use ExUnit.Case, async: true
  alias Treehouse.CatalogTrust
  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @expected %{trust_revision: 0, history_generation: 0}

  @tag timeout: 180_000
  test "incoming boundaries preserve accepted and frozen snapshots and cannot repair saved corruption" do
    {json, 0} =
      System.cmd("node", ["--import", "tsx", "test/support/catalog_incoming_recovery_peer.ts"],
        cd: @client
      )

    assert_recovery(Jason.decode!(json))
  end

  @tag timeout: 180_000
  test "fresh BEAM-produced accepted and frozen recovery inputs agree in the actual client" do
    dir = Path.join(System.tmp_dir!(), "catalog-recovery-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)
    path = Path.join(dir, "beam.json")
    File.write!(path, Jason.encode!(beam_bundle()))

    {json, 0} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/catalog_incoming_recovery_peer.ts", "consume", path],
        cd: @client
      )

    assert_recovery(Jason.decode!(json))
  end

  defp assert_recovery(raw) do
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

    histories = Enum.map(b["histories"], &history/1)

    prepared =
      CatalogTrust.prepare_installation(%{
        review: review,
        history: Enum.find(histories, &(&1.replica == review.space)),
        store: %{kind: :verified_fresh, expected: @expected}
      })

    assert prepared.kind == :propose

    first =
      evaluate(prepared.next, %{
        page(histories)
        | catalogs: [b["catalogJson"], b["advancedCatalogJson"]]
      })

    assert first.kind == :propose
    assert first.next.accepted.revision == 1
    assert length(first.routes) == 2
    frozen = evaluate(first.next, page([history(b["forkHistory"])]))
    assert frozen.kind == :retain_blocked
    assert frozen.reason == :catalog_fork
    assert frozen.next.accepted == first.next.accepted
    expected = Map.new(raw["observations"], &{&1["name"], &1["decision"]})

    for {label, original} <- [{"accepted", first.next}, {"blocked", frozen.next}] do
      base = original |> :erlang.term_to_binary() |> :erlang.binary_to_term([:safe])

      cases =
        [{"reopen", page()}, {"older-catalog", %{page() | catalogs: [b["catalogJson"]]}}] ++
          Enum.map(b["cases"], &{&1["name"], page([history(&1["history"])])})

      for {name, incoming} <- cases do
        assert_case(base, incoming, name, label, expected)
      end

      for defect <- ["signature", "unportable-depth", "watermark"] do
        damaged = damage(base, defect, b["deepFrame"])

        for {name, incoming} <- [
              {"repair", page(histories)},
              {"malformed", %{page() | histories: nil}}
            ] do
          decision = evaluate(damaged, incoming)
          assert decision.kind == :reject
          assert decision.reason == :trust_recovery_required
          assert summary(decision) == expected["#{label}:corrupt-#{defect}:#{name}"]
        end
      end
    end
  end

  defp assert_case(base, incoming, name, label, expected) do
    decision = evaluate(base, incoming)
    assert summary(decision) == expected["#{label}:#{name}"], "#{label}:#{name}"

    if name == "reopen" do
      assert decision.kind == if(label == "accepted", do: :unchanged, else: :retain_blocked)
      assert decision.reason == if(label == "accepted", do: nil, else: :catalog_fork)
    end

    assert_preserved(base, decision, name)
  end

  defp assert_preserved(_base, %{kind: :reject}, _name), do: :ok

  defp assert_preserved(base, decision, name) do
    assert decision.next.accepted == base.accepted

    if base.blocked do
      assert decision.next.blocked == base.blocked
      assert decision.routes == []
    end

    assert_retained_evidence(base, decision.next)
    if name == "reopen", do: assert(decision.next == base)
  end

  defp assert_retained_evidence(base, next) do
    for h <- base.histories do
      retained = Enum.find(next.histories, &(&1.replica == h.replica))
      assert Enum.all?(h.frames, &(&1 in retained.frames))
      assert Enum.all?(h.rejected, &(&1 in retained.rejected))
    end
  end

  defp beam_bundle do
    alias Lattice.{Log, Op}
    alias Lattice.Carrier.Wire
    alias Treehouse.{CatalogTrustVectors, TransportCatalog}
    f = CatalogTrustVectors.fixture(1)
    [space | rest] = f.histories

    rejected = %{
      frame: Map.put(hd(space.frames), "sig", Base.encode64(<<0::512>>)),
      reason: :bad_signature
    }

    space = %{space | rejected: [rejected]}
    {:catalog_bootstrap_v1, [record]} = f.space.bootstrap.body

    fork =
      Op.new(
        f.space.root,
        f.space.replica,
        Log.frontier(f.space_log),
        :command,
        {:catalog_bootstrap_v1, [%{record | nonce: CatalogTrustVectors.id("recovery-fork")}]},
        cap: f.space.delegation.id
      )

    frames =
      for depth <- [64, 65, 66], into: %{} do
        body = Enum.reduce(1..depth, nil, fn _, value -> [value] end)
        op = Op.new(f.space.root, f.space.replica, Log.frontier(f.space_log), :command, body)
        {depth, Wire.encode_op(op)}
      end

    cases =
      for depth <- [64, 65, 66] do
        %{
          name: "beam-depth-#{depth}",
          history: %{space | frames: space.frames ++ [frames[depth]]}
        }
      end

    r = f.review
    advanced = %{f.catalog | revision: 1, previous: TransportCatalog.catalog_id(f.catalog)}

    %{
      review: %{
        version: 1,
        product: "treehouse",
        space: r.space,
        spaceRoot: Base.encode64(r.space_root),
        bootstrapId: r.bootstrap_id,
        observedBootstrapIds: r.observed_bootstrap_ids,
        disposition: "pin_exact_observed_bootstrap"
      },
      histories: [space | rest],
      catalogJson: f.catalog_json,
      advancedCatalogJson:
        advanced
        |> CatalogTrustVectors.sign_catalog(f.space.catalog)
        |> CatalogTrustVectors.artifact_json(),
      forkHistory: %{space | frames: space.frames ++ [Wire.encode_op(fork)]},
      deepFrame: frames[65],
      cases: cases
    }
  end

  defp history(h),
    do: %{
      replica: h["replica"],
      frames: h["frames"],
      rejected: Enum.map(h["rejected"], fn r -> %{frame: r["frame"], reason: :bad_signature} end)
    }

  defp page(histories \\ []),
    do: %{catalogs: [], rotations: [], histories: histories, cutoff_proofs: []}

  defp evaluate(state, incoming),
    do: CatalogTrust.evaluate(%{installed: state, expected: @expected, incoming: incoming})

  defp damage(base, "watermark", _), do: put_in(base.accepted.revision, 0)

  defp damage(base, defect, deep) do
    update_in(base.histories, fn histories ->
      Enum.map(histories, fn h ->
        if h.replica == base.review.space do
          %{h | frames: damaged_frames(h.frames, defect, deep)}
        else
          h
        end
      end)
    end)
  end

  defp damaged_frames(frames, "signature", _deep),
    do: List.update_at(frames, 0, &Map.put(&1, "sig", Base.encode64(<<0::512>>)))

  defp damaged_frames(frames, "unportable-depth", deep), do: frames ++ [deep]

  defp summary(d) do
    state = if d.kind != :reject, do: d.next

    %{
      "kind" => Atom.to_string(d.kind),
      "reason" => d.reason && Atom.to_string(d.reason),
      "ids" => d.detail.ids,
      "accepted" => state && state.accepted,
      "blocked" => state && state.blocked && Atom.to_string(state.blocked.reason),
      "routes" => if(state, do: Enum.sort(Enum.map(d.routes, & &1.replica)), else: []),
      "histories" =>
        if(state,
          do:
            Enum.sort(
              Enum.map(
                state.histories,
                &[&1.replica, Enum.sort(Enum.map(&1.frames, fn f -> f["id"] end))]
              )
            ),
          else: []
        ),
      "catalogs" => if(state, do: Enum.sort(Enum.map(state.catalogs, & &1.id)), else: []),
      "rotations" => if(state, do: Enum.sort(Enum.map(state.rotations, & &1.id)), else: [])
    }
    |> Jason.encode!()
    |> Jason.decode!()
  end
end
