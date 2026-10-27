defmodule Treehouse.CatalogSavedWitnessTest do
  use ExUnit.Case, async: false
  alias Treehouse.CatalogTrust
  Code.require_file("../../../../scripts/support/catalog_resolver_json.exs", __DIR__)
  @client Path.expand("../../../../clients/lattice-client", __DIR__)

  @tag timeout: 300_000
  test "saved catalog and binding witnesses prove their recorded relationships before incoming" do
    {json, status} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/catalog_saved_witness_peer.ts"],
        cd: @client,
        stderr_to_stdout: true
      )

    assert status == 0, json
    table = Jason.decode!(json)
    assert length(table["cases"]) == 51

    mismatches =
      for item <- table["cases"], {order, index} <- Enum.with_index(item["orders"]), reduce: [] do
        errors ->
          input = NativeCatalogResolverPeer.input(order["input"])
          before = :erlang.term_to_binary(input)
          {elapsed, decision} = :timer.tc(fn -> CatalogTrust.evaluate(input) end)

          if item["name"] == "340-historical-catalog-witnesses-reopen" do
            assert elapsed < 60_000_000, "bounded historical replay exceeded 60 seconds"
          end

          assert :erlang.term_to_binary(input) == before
          actual = NativeCatalogResolverPeer.output(decision)

          if actual == order["decision"] do
            errors
          else
            [
              {item["name"], index, actual["kind"], actual["reason"], order["decision"]["kind"],
               order["decision"]["reason"]}
              | errors
            ]
          end
      end

    assert mismatches == [], "Full public decisions differ: #{inspect(Enum.reverse(mismatches))}"
  end
end
