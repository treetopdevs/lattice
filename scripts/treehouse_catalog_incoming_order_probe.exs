# Consume fresh public inputs through the actual BEAM installation API.
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

cases =
  Enum.map(raw["cases"], fn c ->
    h = c["history"]

    result =
      Treehouse.CatalogTrust.prepare_installation(%{
        review: review,
        history: %{replica: h["replica"], frames: h["frames"], rejected: []},
        store: %{kind: :verified_fresh, expected: %{trust_revision: 0, history_generation: 0}}
      })

    Map.put(c, "beam", Map.take(result, [:kind, :reason, :detail]))
  end)

IO.puts(Jason.encode!(Map.put(raw, "cases", cases), pretty: true))
