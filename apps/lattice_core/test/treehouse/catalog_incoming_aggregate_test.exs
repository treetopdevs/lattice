defmodule Treehouse.CatalogIncomingAggregateTest do
  use ExUnit.Case, async: false
  alias Treehouse.CatalogTrust
  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @expected %{trust_revision: 0, history_generation: 0}

  @tag timeout: 180_000
  test "signed evidence at the shared history string maximum authenticates, but one over is invalid" do
    for context <- ["history", "page"], do: assert_context(context)
  end

  @tag timeout: 180_000
  test "independent BEAM signed history/page maxima are consumed by the actual client" do
    dir = Path.join(System.tmp_dir!(), "catalog-aggregate-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)

    for context <- ["history", "page"] do
      path = Path.join(dir, "#{context}.json")
      json = beam_bundle(context) |> Jason.encode!()
      File.write!(path, json)

      {reply, 0} =
        System.cmd(
          "node",
          ["--import", "tsx", "test/support/catalog_aggregate_peer.ts", "consume", path, context],
          cd: @client
        )

      assert Jason.decode!(reply) == %{"checked" => true}
      assert_bundle(Jason.decode!(json), context)
    end
  end

  defp assert_context(context) do
    {json, 0} =
      System.cmd("node", ["--import", "tsx", "test/support/catalog_aggregate_peer.ts", context],
        cd: @client
      )

    assert_bundle(Jason.decode!(json), context)
  end

  defp assert_bundle(raw, context) do
    r = raw["review"]

    review = %{
      version: 1,
      product: :treehouse,
      space: r["space"],
      space_root: Base.decode64!(r["spaceRoot"]),
      bootstrap_id: r["bootstrapId"],
      observed_bootstrap_ids: r["observedBootstrapIds"],
      disposition: :pin_exact_observed_bootstrap
    }

    baseline = history(raw["baseline"])
    at = history(raw["at"])
    over = %{at | frames: Enum.drop(at.frames, -1) ++ [raw["overFrame"]]}

    forged = %{
      at
      | frames:
          List.update_at(
            at.frames,
            length(baseline.frames),
            &Map.put(&1, "sig", Base.encode64(<<0::512>>))
          )
    }

    prepared = prepare(review, baseline)
    assert prepared.kind == :propose

    cutoff = %{
      replica: raw["cutoff"]["replica"],
      frontier: raw["cutoff"]["frontier"],
      log_digest: raw["cutoff"]["logDigest"]
    }

    for {main, proof_history} <- [{at, baseline}, {baseline, at}] do
      incoming = %{
        catalogs: [],
        rotations: [],
        histories: [main],
        cutoff_proofs: [%{cutoff: cutoff, history: proof_history}]
      }

      decision =
        CatalogTrust.evaluate(%{
          installed: prepared.next,
          expected: @expected,
          incoming: incoming
        })

      assert decision.kind == :reject
      assert decision.reason == :invalid_verified_history
      assert decision.detail.ids == []
    end

    corrupt = %{prepared.next | cutoff_proofs: [%{cutoff: cutoff, history: at}]}

    recovered =
      CatalogTrust.evaluate(%{
        installed: corrupt,
        expected: @expected,
        incoming: %{catalogs: [], rotations: [], histories: [baseline], cutoff_proofs: []}
      })

    assert recovered.kind == :reject
    assert recovered.reason == :trust_recovery_required

    for {name, value, reason} <- [
          {"at", at, :unsupported_cutoff},
          {"over", over, :invalid_verified_history},
          {"forged", forged, :invalid_verified_history}
        ] do
      prepared_decision = prepare(review, value)

      evaluated =
        CatalogTrust.evaluate(%{
          installed: prepared.next,
          expected: @expected,
          incoming: %{catalogs: [], rotations: [], histories: [value], cutoff_proofs: []}
        })

      prepare_reason =
        if name == "over" and context == "page", do: :unsupported_cutoff, else: reason

      evaluate_reason =
        if name == "at" and context == "history", do: :invalid_verified_history, else: reason

      for {decision, wanted} <- [
            {prepared_decision, prepare_reason},
            {evaluated, evaluate_reason}
          ] do
        assert decision.kind == :reject, name
        assert decision.reason == wanted, "#{context}:#{name}"
        assert decision.detail.ids == [], name
      end
    end
  end

  defp beam_bundle(context) do
    alias Lattice.{Canonical, Log, Op}
    alias Lattice.Carrier.Wire
    alias Treehouse.CatalogTrustVectors
    f = CatalogTrustVectors.fixture(0)
    baseline = hd(f.histories)
    deps = [hd(Log.frontier(f.space_log))]

    author = fn text, parents ->
      Op.new(f.space.root, f.space.replica, parents, :command, %Canonical.Atom{name: text})
      |> Wire.encode_op()
    end

    empty = %{baseline | frames: baseline.frames ++ [author.("", deps), author.("", [])]}
    input = if context == "page", do: public_page(empty), else: [empty]
    available = 67_108_864 - string_bytes(input)
    left = :binary.copy("q", div(available, 2))
    right = :binary.copy("q", available - byte_size(left))
    at = %{baseline | frames: baseline.frames ++ [author.(left, deps), author.(right, [])]}
    counted = if context == "page", do: public_page(at), else: [at]
    assert string_bytes(counted) == 67_108_864
    cutoff = hd(f.cutoff_proofs).cutoff
    r = f.review

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
      baseline: baseline,
      at: at,
      overFrame: author.(right <> "z", []),
      cutoff: %{replica: cutoff.replica, frontier: cutoff.frontier, logDigest: cutoff.log_digest}
    }
  end

  defp public_page(history),
    do: %{catalogs: [], rotations: [], histories: [history], cutoffProofs: []}

  defp string_bytes(value) when is_binary(value), do: byte_size(value)

  defp string_bytes(value) when is_atom(value) and value not in [nil, true, false],
    do: value |> Atom.to_string() |> byte_size()

  defp string_bytes(value) when is_list(value), do: Enum.sum(Enum.map(value, &string_bytes/1))

  defp string_bytes(value) when is_map(value),
    do: Enum.sum(Enum.map(value, fn {key, item} -> string_bytes(key) + string_bytes(item) end))

  defp string_bytes(_), do: 0

  defp history(h), do: %{replica: h["replica"], frames: h["frames"], rejected: []}

  defp prepare(review, history),
    do:
      CatalogTrust.prepare_installation(%{
        review: review,
        history: history,
        store: %{kind: :verified_fresh, expected: @expected}
      })
end
