# Actual public BEAM owner at the logical maximum, with streamed full-decision hashes.
Code.require_file("support/native_peer_output.exs", __DIR__)
Code.require_file("support/catalog_resolver_json.exs", __DIR__)

defmodule NativeCapacityDigest do
  def digest(value),
    do:
      walk(value, :crypto.hash_init(:sha256))
      |> :crypto.hash_final()
      |> Base.url_encode64(padding: false)

  defp walk(value, context) when is_map(value) do
    context = :crypto.hash_update(context, "{")

    value
    |> Enum.sort_by(&elem(&1, 0))
    |> Enum.with_index()
    |> Enum.reduce(context, fn {{key, item}, i}, acc ->
      acc = if i == 0, do: acc, else: :crypto.hash_update(acc, ",")
      walk(item, :crypto.hash_update(acc, [Jason.encode!(key), ":"]))
    end)
    |> :crypto.hash_update("}")
  end

  defp walk(value, context) when is_list(value) do
    context = :crypto.hash_update(context, "[")

    value
    |> Enum.with_index()
    |> Enum.reduce(context, fn {item, i}, acc ->
      walk(item, if(i == 0, do: acc, else: :crypto.hash_update(acc, ",")))
    end)
    |> :crypto.hash_update("]")
  end

  defp walk(value, context), do: :crypto.hash_update(context, Jason.encode!(value))
end

manifest = IO.read(:stdio, :eof) |> Jason.decode!()
%{size: size} = File.stat!(manifest["path"])
true = size <= 128 * 1024 * 1024
bytes = File.read!(manifest["path"])

unless is_binary(manifest["bundleSha256"]),
  do: raise("capacity manifest predates bundle pinning; regenerate with the current source peer")

unless Base.encode16(:crypto.hash(:sha256, bytes), case: :lower) == manifest["bundleSha256"],
  do: raise("capacity corpus bytes do not match the source-verified manifest")

raw = Jason.decode!(bytes)
true = Map.get(raw, "frozen", false) == Map.get(manifest, "frozen", false)
expected = %{"trustRevision" => 0, "historyGeneration" => 0}
empty = %{"catalogs" => [], "rotations" => [], "histories" => [], "cutoffProofs" => []}

evaluate = fn installed, incoming ->
  %{"installed" => installed, "expected" => expected, "incoming" => incoming}
  |> NativeCatalogResolverPeer.input()
  |> Treehouse.CatalogTrust.evaluate()
  |> NativeCatalogResolverPeer.output()
end

accepted = evaluate.(raw["initial"], %{empty | "histories" => [raw["at"]]})
reopened = evaluate.(accepted["next"], empty)
over = %{raw["at"] | "frames" => Enum.drop(raw["at"]["frames"], -1) ++ [raw["overFrame"]]}
proposed_over = evaluate.(raw["initial"], %{empty | "histories" => [over]})

saved_over =
  evaluate.(
    %{
      raw["initial"]
      | "histories" => [over],
        "blocked" => Map.get(raw, "blockedOver", raw["initial"]["blocked"])
    },
    %{empty | "histories" => [raw["baseline"]]}
  )

modeled =
  evaluate.(
    %{
      raw["initial"]
      | "histories" => [raw["at"]],
        "blocked" => Map.get(raw, "blockedAt", raw["initial"]["blocked"])
    },
    %{empty | "histories" => [raw["baseline"]]}
  )

decisions = [
  {"accepted", accepted},
  {"reopened", reopened},
  {"proposedOver", proposed_over},
  {"savedOver", saved_over},
  {"modelReopened", modeled}
]

fallbacks =
  if manifest["frozen"] == true do
    for kind <- ["catalog", "proof"], {history, suffix} <- [{raw["at"], "At"}, {over, "Over"}] do
      incoming = %{empty | "histories" => [history]}

      incoming =
        if kind == "catalog",
          do: %{incoming | "catalogs" => ["not JSON"]},
          else: %{incoming | "cutoffProofs" => [%{}]}

      {kind <> "Fallback" <> suffix, evaluate.(raw["initial"], incoming)}
    end
  else
    []
  end

saved_fallbacks =
  if manifest["frozen"] == true do
    for kind <- ["catalog", "proof"] do
      incoming =
        if kind == "catalog",
          do: %{empty | "catalogs" => ["not JSON"]},
          else: %{empty | "cutoffProofs" => [%{}]}

      {"saved" <> String.capitalize(kind) <> "FallbackAt", evaluate.(accepted["next"], incoming)}
    end
  else
    []
  end

results =
  for {name, decision} <- decisions ++ fallbacks ++ saved_fallbacks do
    %{
      "name" => name,
      "kind" => decision["kind"],
      "reason" => decision["reason"],
      "decisionSha256" => NativeCapacityDigest.digest(decision)
    }
  end

Lattice.NativePeerOutput.puts(Jason.encode!(%{cases: results}))
