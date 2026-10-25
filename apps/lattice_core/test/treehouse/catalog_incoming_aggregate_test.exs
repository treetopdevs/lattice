defmodule Treehouse.CatalogIncomingAggregateTest do
  use ExUnit.Case, async: false
  alias Treehouse.CatalogTrust
  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @expected %{trust_revision: 0, history_generation: 0}

  @tag timeout: 180_000
  test "signed evidence at the shared history string maximum authenticates, but one over is invalid" do
    {json, 0} =
      System.cmd("node", ["--import", "tsx", "test/support/catalog_aggregate_peer.ts"],
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

    for {name, value, reason} <- [
          {"at", at, :unsupported_cutoff},
          {"over", over, :invalid_verified_history},
          {"forged", forged, :invalid_verified_history}
        ] do
      actual = [
        prepare(review, value),
        CatalogTrust.evaluate(%{
          installed: prepared.next,
          expected: @expected,
          incoming: %{catalogs: [], rotations: [], histories: [value], cutoff_proofs: []}
        })
      ]

      for decision <- actual do
        assert decision.kind == :reject, name
        assert decision.reason == reason, name
        assert decision.detail.ids == [], name
      end
    end
  end

  defp history(h), do: %{replica: h["replica"], frames: h["frames"], rejected: []}

  defp prepare(review, history),
    do:
      CatalogTrust.prepare_installation(%{
        review: review,
        history: history,
        store: %{kind: :verified_fresh, expected: @expected}
      })
end
