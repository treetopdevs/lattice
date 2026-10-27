defmodule Treehouse.CatalogRawNumberTest do
  use ExUnit.Case, async: false
  alias Lattice.Carrier.Wire
  alias Treehouse.{CatalogTrust, CatalogTrustVectors}
  Code.require_file("../../../../scripts/support/catalog_resolver_json.exs", __DIR__)
  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @expected %{trust_revision: 0, history_generation: 0}

  @tag timeout: 300_000
  test "fresh numeric JSON spellings preserve complete actual public decisions" do
    table = peer([])
    assert length(table["cases"]) == 33

    for item <- table["cases"], {order, index} <- Enum.with_index(item["orders"]) do
      input = order["requestJson"] |> Jason.decode!() |> NativeCatalogResolverPeer.input()
      before = :erlang.term_to_binary(input)
      decision = CatalogTrust.evaluate(input)
      assert :erlang.term_to_binary(input) == before

      if item["name"] == "incoming-version-decimal" do
        assert Enum.any?(decision.next.histories, fn history ->
                 Enum.any?(history.frames, &(&1["v"] === 1.0))
               end)
      end

      if item["name"] == "rejected-signature-version-alias" do
        assert Enum.any?(decision.next.histories, fn history ->
                 Enum.any?(history.rejected, &(&1.frame["v"] === 1.0))
               end)
      end

      if item["name"] == "cutoff-proof-version-alias" do
        assert Enum.any?(decision.next.cutoff_proofs, fn proof ->
                 Enum.any?(proof.history.frames, &(&1["v"] === 1.0))
               end)
      end

      assert_json(
        NativeCatalogResolverPeer.output(decision),
        order["decision"],
        "#{item["name"]} order=#{index}"
      )
    end
  end

  @tag timeout: 300_000
  test "catalog wrapper watermarks and tokens use the same safe numeric-value profile" do
    table = peer(["metadata"])
    assert length(table["cases"]) == 47

    for item <- Enum.drop(table["cases"], 33),
        {order, index} <- Enum.with_index(item["orders"]) do
      input = order["requestJson"] |> Jason.decode!() |> NativeCatalogResolverPeer.input()
      decision = CatalogTrust.evaluate(input)

      assert_json(
        NativeCatalogResolverPeer.output(decision),
        order["decision"],
        "#{item["name"]} order=#{index}"
      )
    end
  end

  @tag timeout: 300_000
  test "independent BEAM numeric aliases retain raw history and do not widen wire admission" do
    f = CatalogTrustVectors.fixture(1)

    prepared =
      CatalogTrust.prepare_installation(%{
        review: f.review,
        history: hd(f.histories),
        store: %{kind: :verified_fresh, expected: @expected}
      })

    assert prepared.kind == :propose

    accepted =
      CatalogTrust.evaluate(%{
        installed: prepared.next,
        expected: @expected,
        incoming: %{empty() | catalogs: [f.catalog_json], histories: f.histories}
      })

    assert accepted.kind == :propose
    [history | rest] = accepted.next.histories
    [frame | frames] = history.frames
    alias_frame = Map.put(frame, "v", 1.0)
    assert alias_frame["sig"] == frame["sig"]
    assert {:ok, _} = Wire.decode_op(frame)
    assert {:error, :malformed_op} = Wire.decode_op(alias_frame)
    saved = %{accepted.next | histories: [%{history | frames: [alias_frame | frames]} | rest]}

    inputs = [
      %{
        name: "beam-saved-version",
        input: %{installed: saved, expected: @expected, incoming: empty()}
      },
      %{
        name: "beam-incoming-alias",
        input: %{
          installed: accepted.next,
          expected: @expected,
          incoming: %{empty() | histories: [%{history | frames: [alias_frame]}]}
        }
      }
    ]

    cases =
      Enum.map(inputs, fn item ->
        %{
          name: item.name,
          requestJson: item.input |> NativeCatalogResolverPeer.output() |> Jason.encode!()
        }
      end)

    path =
      Path.join(System.tmp_dir!(), "catalog-number-#{System.unique_integer([:positive])}.json")

    File.write!(path, Jason.encode!(%{cases: cases}))
    on_exit(fn -> File.rm(path) end)
    ts = peer(["consume"], path)

    for {item, result} <- Enum.zip(inputs, ts["results"]) do
      decision = CatalogTrust.evaluate(item.input)
      assert decision.kind == :unchanged
      assert decision.next === item.input.installed
      assert decision.next.accepted == item.input.installed.accepted
      assert_json(NativeCatalogResolverPeer.output(decision), result["decision"], item.name)
    end
  end

  defp empty, do: %{catalogs: [], rotations: [], histories: [], cutoff_proofs: []}

  defp peer(args, path \\ nil) do
    # The peer receives fresh request JSON, never a saved expected verdict.
    script = "test/support/catalog_raw_number_peer.ts"

    {json, status} =
      if path do
        System.cmd("node", ["--import", "tsx", script | args] ++ [path],
          cd: @client,
          stderr_to_stdout: true
        )
      else
        System.cmd("node", ["--import", "tsx", script | args],
          cd: @client,
          stderr_to_stdout: true
        )
      end

    assert status == 0, json
    Jason.decode!(json)
  end

  defp assert_json(actual, expected, context) when is_map(actual) and is_map(expected) do
    assert Enum.sort(Map.keys(actual)) == Enum.sort(Map.keys(expected)), context

    Enum.each(expected, fn {key, value} ->
      assert_json(Map.fetch!(actual, key), value, "#{context}.#{key}")
    end)
  end

  defp assert_json(actual, expected, context) when is_list(actual) and is_list(expected) do
    assert length(actual) == length(expected), context

    Enum.zip(actual, expected)
    |> Enum.with_index()
    |> Enum.each(fn {{a, b}, index} -> assert_json(a, b, "#{context}[#{index}]") end)
  end

  defp assert_json(actual, expected, context) when is_number(actual) and is_number(expected),
    do: assert(actual == expected, context)

  defp assert_json(actual, expected, context),
    do: assert(actual === expected, "#{context}: #{inspect(actual)} != #{inspect(expected)}")
end
