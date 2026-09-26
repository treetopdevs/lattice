defmodule LatticeCarrierServer.Operator.JournalSchemaTest do
  use ExUnit.Case, async: true
  alias LatticeCarrierServer.Operator.Journal

  defp record(service) do
    %{
      "version" => 1,
      "phase" => "carrier_pending",
      "attempt" => Base.url_encode64(:crypto.hash(:sha256, "attempt"), padding: false),
      "generation" => 0,
      "catalog_head" => nil,
      "manifest_digest" => Journal.digest("manifest"),
      "artifacts" => [
        %{
          "path" => "/operator/attempt/manifest",
          "sha256" => Journal.digest("artifact"),
          "kind" => "manifest",
          "replica" => nil,
          "op_id" => nil,
          "review" => nil
        }
      ],
      "service" => service
    }
  end

  defp service do
    %{
      "identity_file" => "/srv/lattice/child-service.identity",
      "realm" => "child-service",
      "pub" => Base.encode64(:crypto.hash(:sha256, "pub")),
      "sha256" => Journal.digest("identity")
    }
  end

  test "a pending record binds exactly one well-formed service identity" do
    raw = Journal.encode(record(service()))
    assert {:ok, decoded} = Journal.decode(raw)
    assert decoded["service"] == service()
  end

  test "a pending record without a service identity binding refuses" do
    raw = Journal.encode(Map.delete(record(service()), "service"))
    assert {:error, :corrupt_operator_journal} = Journal.decode(raw)
  end

  test "a malformed service identity binding refuses" do
    for bad <- [
          nil,
          Map.put(service(), "extra", "x"),
          Map.delete(service(), "sha256"),
          Map.put(service(), "identity_file", "relative/child-service.identity"),
          Map.put(service(), "identity_file", "/srv/lattice/../child-service.identity"),
          Map.put(service(), "realm", ""),
          Map.put(service(), "pub", Base.encode64("short")),
          Map.put(service(), "pub", "not base64"),
          Map.put(service(), "sha256", String.upcase(Journal.digest("identity")))
        ] do
      raw = Jason.encode!(record(bad))
      assert {:error, :corrupt_operator_journal} = Journal.decode(raw), inspect(bad)
    end
  end
end
