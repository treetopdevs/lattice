# Actual public BEAM owner for fresh full-resolver requests. Frame transport is
# passed through untouched; only the public API's metadata names are translated.
Code.require_file("support/native_peer_output.exs", __DIR__)

Code.require_file("support/catalog_resolver_json.exs", __DIR__)

input = IO.read(:stdio, :eof) |> Jason.decode!()

results =
  Enum.map(input["cases"], fn item ->
    %{
      name: item["name"],
      decision:
        item["input"]
        |> NativeCatalogResolverPeer.input()
        |> Treehouse.CatalogTrust.evaluate()
        |> NativeCatalogResolverPeer.output()
    }
  end)

Lattice.NativePeerOutput.puts(Jason.encode!(%{results: results}))
