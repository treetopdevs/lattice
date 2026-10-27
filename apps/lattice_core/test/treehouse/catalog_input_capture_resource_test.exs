defmodule Treehouse.CatalogInputCaptureResourceTest do
  use ExUnit.Case, async: false
  alias Treehouse.CatalogTrust
  Code.require_file("../../../../scripts/support/catalog_resolver_json.exs", __DIR__)
  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @maximum 64 * 1024 * 1024

  @tag timeout: 300_000
  test "full encoded array/object capture preserves complete public decisions and security fallback" do
    directory =
      Path.join(
        System.tmp_dir!(),
        "treehouse-capture-" <> Base.url_encode64(:crypto.strong_rand_bytes(12), padding: false)
      )

    File.mkdir!(directory)
    request = Path.join(directory, "request.json")
    File.write!(request, Jason.encode!(%{directory: directory}))

    {output, status} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/native_catalog_density_peer.ts", request],
        cd: @client,
        stderr_to_stdout: true
      )

    File.write!(Path.join(directory, "producer.log"), output)
    # A fresh failing producer retains all four observations. Compare both
    # actual owners before reporting the RED; status still must be zero to pass.
    # The unique directory forbids substituting a corpus from another attempt.
    manifest_bytes = read_bounded(Path.join(directory, "manifest.json"), 1024 * 1024)
    manifest = Jason.decode!(manifest_bytes)
    assert manifest["version"] == 1
    assert manifest["targetBytes"] == @maximum
    assert manifest["expected"] == %{"trustRevision" => 0, "historyGeneration" => 0}
    assert length(manifest["cases"]) == 4
    assert manifest["snapshot"]["path"] == Path.join(directory, "snapshot.json")
    installed = manifest["snapshot"] |> read_pinned(32 * 1024 * 1024) |> Jason.decode!()

    names = ~w(array-unblocked array-frozen object-unblocked object-frozen)
    assert Enum.map(manifest["cases"], & &1["name"]) == names

    results =
      for {row, index} <- Enum.with_index(manifest["cases"]) do
        assert row["page"]["path"] == Path.join(directory, row["name"] <> ".json")
        assert row["page"]["bytes"] == @maximum
        assert row["frozen"] == (rem(index, 2) == 1)
        assert row["shape"] == if(index < 2, do: "array", else: "object")
        incoming = row["page"] |> read_pinned(@maximum) |> Jason.decode!()

        beam =
          %{"installed" => installed, "expected" => manifest["expected"], "incoming" => incoming}
          |> NativeCatalogResolverPeer.input()
          |> CatalogTrust.evaluate()
          |> NativeCatalogResolverPeer.output()

        %{"name" => row["name"], "ts" => row["decision"], "beam" => beam}
      end

    File.write!(Path.join(directory, "decisions.json"), Jason.encode!(results))

    errors =
      for row <- results,
          row["ts"] != row["beam"] or not expected?(row["name"], row["beam"]),
          do: %{
            "name" => row["name"],
            "ts" => Map.take(row["ts"], ["kind", "reason"]),
            "beam" => Map.take(row["beam"], ["kind", "reason"])
          }

    assert errors == [],
           "Complete maximum source decisions differ: #{inspect(errors)}; corpus: #{directory}"

    assert status == 0, "Fresh source producer failed: #{output}; corpus: #{directory}"
    File.rm_rf!(directory)
  end

  defp expected?(name, decision) do
    if String.ends_with?(name, "-frozen") do
      decision["kind"] == "retain_blocked" and decision["reason"] == "authority_changed" and
        decision["routes"] == []
    else
      decision["kind"] == "reject" and decision["reason"] == "malformed_catalog"
    end
  end

  defp read_pinned(reference, limit) do
    assert is_integer(reference["bytes"]) and reference["bytes"] > 0 and
             reference["bytes"] <= limit

    bytes = read_bounded(reference["path"], limit)
    assert byte_size(bytes) == reference["bytes"]
    assert Base.encode16(:crypto.hash(:sha256, bytes), case: :lower) == reference["sha256"]
    bytes
  end

  defp read_bounded(path, limit) do
    %{type: :regular, size: size} = File.stat!(path)
    assert size > 0 and size <= limit
    bytes = File.open!(path, [:read, :binary], &IO.binread(&1, limit + 1))
    assert byte_size(bytes) == size
    bytes
  end
end
