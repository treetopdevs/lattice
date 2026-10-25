defmodule Treehouse.CatalogValidCapacityTest do
  use ExUnit.Case, async: false
  alias Lattice.Carrier.{RawObservationBounds, Wire}
  alias Lattice.{Log, Op}
  alias Treehouse.{CatalogCutoff, CatalogTrust, CatalogTrustVectors}
  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @expected %{trust_revision: 0, history_generation: 0}

  @tag timeout: 300_000
  test "genuine portable evidence distinguishes exact saved and proposed envelope capacity" do
    {json, 0} =
      System.cmd("node", ["--import", "tsx", "test/support/catalog_valid_capacity_peer.ts"],
        cd: @client
      )

    assert_bundle(Jason.decode!(json))
  end

  @tag timeout: 300_000
  test "independent BEAM maximum with a matching saved proof agrees in the actual client" do
    raw = beam_bundle() |> Jason.encode!() |> Jason.decode!()

    directory =
      Path.join(System.tmp_dir!(), "valid-capacity-#{System.unique_integer([:positive])}")

    File.mkdir_p!(directory)
    on_exit(fn -> File.rm_rf!(directory) end)
    path = Path.join(directory, "beam.json")
    File.write!(path, Jason.encode!(raw))

    {reply, 0} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/catalog_valid_capacity_peer.ts", "consume", path],
        cd: @client
      )

    assert Jason.decode!(reply) == %{"checked" => true}
    assert_bundle(raw)
  end

  defp assert_bundle(raw) do
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

    prepared =
      CatalogTrust.prepare_installation(%{
        review: review,
        history: baseline,
        store: %{kind: :verified_fresh, expected: @expected}
      })

    assert prepared.kind == :propose

    proof = %{
      cutoff: %{
        replica: raw["proof"]["cutoff"]["replica"],
        frontier: raw["proof"]["cutoff"]["frontier"],
        log_digest: raw["proof"]["cutoff"]["logDigest"]
      },
      history: history(raw["proof"]["history"])
    }

    initial =
      evaluate(prepared.next, %{
        page(baseline)
        | catalogs: [raw["catalogJson"]],
          cutoff_proofs: [proof]
      })

    assert initial.kind == :propose
    assert length(initial.routes) == 1
    assert length(initial.next.cutoff_proofs) == 1

    assert %{ok: true, installation_required: true} =
             CatalogTrust.resolve_route(%{decision: initial, replica: review.space})

    at = history(raw["at"])
    over = %{at | frames: Enum.drop(at.frames, -1) ++ [raw["overFrame"]]}
    predicted = %{initial.next | histories: [at]}
    predicted_over = %{initial.next | histories: [over]}
    assert RawObservationBounds.within_evidence?(predicted)
    refute RawObservationBounds.within_evidence?(predicted_over)

    for h <- [at, over] do
      assert RawObservationBounds.within_evidence?(%{
               catalogs: [],
               rotations: [],
               histories: [h],
               cutoffProofs: []
             })

      assert RawObservationBounds.within_histories?([h])

      ops =
        Enum.map(h.frames, fn frame ->
          assert byte_size(Jason.encode!(frame)) <= 64_000
          assert {:ok, op} = Wire.decode_op(frame)
          op
        end)

      log = %Log{
        replica: h.replica,
        ops: Map.new(ops, &{&1.id, &1}),
        referenced: MapSet.new(Enum.flat_map(ops, & &1.deps))
      }

      assert map_size(log.ops) == length(h.frames)
      assert {:ok, _} = CatalogCutoff.derive(log)
    end

    accepted = evaluate(initial.next, page(at))
    assert accepted.kind == :propose, inspect(Map.take(accepted, [:kind, :reason, :detail]))
    assert accepted.reason == nil
    assert length(accepted.routes) == 1
    assert length(accepted.next.cutoff_proofs) == 1
    assert accepted.next.accepted == initial.next.accepted
    assert length(hd(accepted.next.histories).frames) == raw["frameCount"]
    assert RawObservationBounds.within_evidence?(accepted.next)
    reopened = evaluate(accepted.next, page())
    assert reopened.kind == :unchanged
    assert reopened.reason == nil
    assert reopened.next == accepted.next
    assert length(reopened.routes) == 1
    proposed_over = evaluate(initial.next, page(over))
    assert proposed_over.kind == :reject
    assert proposed_over.reason == :invalid_verified_history
    assert proposed_over.detail.ids == []
    saved_over = evaluate(predicted_over, page(baseline))
    assert saved_over.kind == :reject
    assert saved_over.reason == :trust_recovery_required
    assert saved_over.detail.ids == []

    for decision <- [proposed_over, saved_over] do
      assert %{ok: false, reason: :trust_recovery_required} =
               CatalogTrust.resolve_route(%{decision: decision, replica: review.space})
    end
  end

  defp beam_bundle do
    f = CatalogTrustVectors.fixture(0)
    baseline = hd(f.histories)
    proof = hd(f.cutoff_proofs)

    prepared =
      CatalogTrust.prepare_installation(%{
        review: f.review,
        history: baseline,
        store: %{kind: :verified_fresh, expected: @expected}
      })

    assert prepared.kind == :propose

    initial =
      evaluate(prepared.next, %{
        page(baseline)
        | catalogs: [f.catalog_json],
          cutoff_proofs: [proof]
      })

    assert initial.kind == :propose
    deps = [f.space.bootstrap.id]

    author = fn text, padding ->
      frame =
        Op.new(f.space.root, f.space.replica, deps, :command, {:create_space, [text]})
        |> Wire.encode_op()

      Map.put(frame, "deps", frame["deps"] ++ List.duplicate(hd(deps), padding))
    end

    {frames, total} = fill(author, Enum.reverse(baseline.frames), string_bytes(initial.next))
    available = 67_108_864 - total - string_bytes(author.("", 0))
    padding = Enum.find(0..3, &(available >= &1 * 43 and rem(available - &1 * 43, 4) == 0))
    assert is_integer(padding)
    payload = :binary.copy("z", div(available - padding * 43, 4) * 3)
    assert byte_size(payload) >= 96
    at_frames = Enum.reverse(frames) ++ [author.(payload, padding)]
    over_frame = author.(binary_part(payload, 0, byte_size(payload) - 96), padding + 3)
    at = %{baseline | frames: at_frames}
    assert string_bytes(%{initial.next | histories: [at]}) == 67_108_864
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
      catalogJson: f.catalog_json,
      proof: %{
        cutoff: %{
          replica: proof.cutoff.replica,
          frontier: proof.cutoff.frontier,
          logDigest: proof.cutoff.log_digest
        },
        history: proof.history
      },
      at: at,
      overFrame: over_frame,
      frameCount: length(at_frames)
    }
  end

  defp fill(author, frames, total) when 67_108_864 - total > 62_000 do
    frame = author.(Integer.to_string(length(frames)) <> ":" <> :binary.copy("x", 44_000), 0)
    assert byte_size(Jason.encode!(%{type: "push", ops: [frame]})) <= 64_000
    fill(author, [frame | frames], total + string_bytes(frame))
  end

  defp fill(_author, frames, total), do: {frames, total}

  # Count public wrapper spellings independently of the production bounds walk.
  @public_keys %{
    bootstrap_id: "bootstrapId",
    observed_bootstrap_ids: "observedBootstrapIds",
    cutoff_proofs: "cutoffProofs",
    log_digest: "logDigest",
    bootstrap_ids: "bootstrapIds",
    op_ids: "opIds",
    pending_proof_ids: "pendingProofIds",
    authority_witnesses: "authorityWitnesses"
  }
  defp string_bytes(value) when is_binary(value), do: byte_size(value)
  defp string_bytes(value) when is_list(value), do: Enum.sum(Enum.map(value, &string_bytes/1))
  defp string_bytes(value) when is_map(value), do: Enum.sum(Enum.map(value, &pair_bytes/1))

  defp string_bytes(value) when is_atom(value) and value not in [nil, true, false],
    do: value |> Atom.to_string() |> byte_size()

  defp string_bytes(_), do: 0

  defp pair_bytes({:space_root, value}),
    do: byte_size("spaceRoot") + byte_size(Base.encode64(value))

  defp pair_bytes({key, value}) when is_atom(key),
    do: byte_size(Map.get(@public_keys, key, Atom.to_string(key))) + string_bytes(value)

  defp pair_bytes({key, value}), do: string_bytes(key) + string_bytes(value)

  defp history(h), do: %{replica: h["replica"], frames: h["frames"], rejected: []}

  defp page(h \\ nil),
    do: %{catalogs: [], rotations: [], histories: if(h, do: [h], else: []), cutoff_proofs: []}

  defp evaluate(installed, incoming),
    do: CatalogTrust.evaluate(%{installed: installed, expected: @expected, incoming: incoming})
end
