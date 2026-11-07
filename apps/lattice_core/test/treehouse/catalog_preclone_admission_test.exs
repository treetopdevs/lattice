defmodule Treehouse.CatalogPrecloneAdmissionTest do
  use ExUnit.Case, async: false
  alias Treehouse.CatalogTrust
  Code.require_file("../../../../scripts/support/catalog_resolver_json.exs", __DIR__)
  @client Path.expand("../../../../clients/lattice-client", __DIR__)

  @tag timeout: 120_000
  test "resource refusal precedes later scope errors while cheap shape and saved recovery stay first" do
    {output, 0} =
      System.cmd("node", ["--import", "tsx", "test/support/catalog_preclone_admission_peer.ts"],
        cd: @client
      )

    corpus = Jason.decode!(output)
    installed = NativeCatalogResolverPeer.input(corpus["installed"])
    expected = NativeCatalogResolverPeer.input(corpus["expected"])
    template = NativeCatalogResolverPeer.input(corpus["template"])

    for row <- corpus["cases"] do
      name = row["name"]
      saved = if name == "saved-corrupt", do: %{installed | histories: []}, else: installed
      token = if name == "cheap-token", do: %{expected | trust_revision: -1}, else: expected

      incoming =
        cond do
          name in ["over-depth", "over-nodes"] ->
            count = if name == "over-depth", do: 210, else: 26

            tree =
              Enum.reduce(1..count, [], fn _, acc ->
                if name == "over-depth", do: [acc], else: [acc, acc]
              end)

            %{template | cutoff_proofs: [tree]}

          true ->
            text =
              if name == "within",
                do: "not JSON",
                else: String.duplicate("x", 64 * 1024 * 1024 + 1)

            catalogs =
              if name == "cheap-count", do: [text | List.duplicate("not JSON", 32)], else: [text]

            %{template | catalogs: catalogs}
        end

      decision = CatalogTrust.evaluate(%{installed: saved, expected: token, incoming: incoming})
      actual = NativeCatalogResolverPeer.output(decision)
      assert actual == row["decision"], inspect(%{case: name, ts: row["decision"], beam: actual})
    end
  end
end
