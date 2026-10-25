# Consume fresh public inputs through both actual BEAM catalog APIs.
[path] = System.argv()
raw = Jason.decode!(File.read!(path))
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

expected = %{trust_revision: 0, history_generation: 0}

decode = fn h ->
  rejected =
    Enum.map(h["rejected"], fn
      record when is_map(record) ->
        Map.new(record, fn
          {"frame", value} -> {:frame, value}
          {"reason", "bad_signature"} -> {:reason, :bad_signature}
          {"reason", _} -> {:reason, :invalid_reason}
          pair -> pair
        end)

      value ->
        value
    end)

  %{replica: h["replica"], frames: h["frames"], rejected: rejected}
end

%{kind: :propose, next: installed} =
  Treehouse.CatalogTrust.prepare_installation(%{
    review: review,
    history: decode.(raw["baselineHistory"]),
    store: %{kind: :verified_fresh, expected: expected}
  })

cases =
  Enum.map(raw["cases"], fn c ->
    history = decode.(c["history"])

    prepared =
      Treehouse.CatalogTrust.prepare_installation(%{
        review: review,
        history: history,
        store: %{kind: :verified_fresh, expected: expected}
      })

    evaluated =
      Treehouse.CatalogTrust.evaluate(%{
        installed: installed,
        expected: expected,
        incoming: %{catalogs: [], rotations: [], histories: [history], cutoff_proofs: []}
      })

    c
    |> Map.put("beam", Map.take(prepared, [:kind, :reason, :detail]))
    |> Map.put("beamEvaluation", Map.take(evaluated, [:kind, :reason, :detail]))
  end)

IO.puts(Jason.encode!(Map.put(raw, "cases", cases), pretty: true))
