defmodule Treehouse.CatalogValidCapacityTest do
  use ExUnit.Case, async: false
  alias Treehouse.{CatalogTrust, CatalogCutoff}
  alias Lattice.Carrier.{RawObservationBounds, Wire}
  alias Lattice.Log
  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @expected %{trust_revision: 0, history_generation: 0}

  @tag timeout: 300_000
  test "genuine portable evidence distinguishes exact saved and proposed envelope capacity" do
    {json, 0} =
      System.cmd("node", ["--import", "tsx", "test/support/catalog_valid_capacity_peer.ts"],
        cd: @client
      )

    raw = Jason.decode!(json)
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
    initial = evaluate(prepared.next, %{page(baseline) | catalogs: [raw["catalogJson"]]})
    assert initial.kind == :propose
    assert length(initial.routes) == 1
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

      log =
        Enum.reduce(h.frames, Log.new(h.replica), fn frame, log ->
          assert byte_size(Jason.encode!(frame)) <= 64_000
          assert {:ok, op} = Wire.decode_op(frame)
          Log.append!(log, op)
        end)

      assert {:ok, _} = CatalogCutoff.derive(log)
    end

    accepted = evaluate(initial.next, page(at))
    assert accepted.kind == :propose, inspect(Map.take(accepted, [:kind, :reason, :detail]))
    assert accepted.reason == nil
    assert length(accepted.routes) == 1
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
  end

  defp history(h), do: %{replica: h["replica"], frames: h["frames"], rejected: []}

  defp page(h \\ nil),
    do: %{catalogs: [], rotations: [], histories: if(h, do: [h], else: []), cutoff_proofs: []}

  defp evaluate(installed, incoming),
    do: CatalogTrust.evaluate(%{installed: installed, expected: @expected, incoming: incoming})
end
