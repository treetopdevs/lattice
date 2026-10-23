defmodule LatticeCarrierServer.Operator.CatalogOwnerTest do
  # Drives the real Linux mutation owner through catalogued, then listed.
  use ExUnit.Case, async: false
  alias Lattice.Carrier.Wire
  alias Lattice.Identity
  alias LatticeCarrierServer.Operator.{CatalogStore, Journal, Lock}
  alias Treehouse.TransportCatalog

  if :os.type() != {:unix, :linux},
    do: @moduletag(skip: "Actual Linux mutation-owner proof required")

  defp id(tag), do: Base.url_encode64(:crypto.hash(:sha256, tag), padding: false)

  defp envelope(signer) do
    catalog = %{
      version: 1,
      product: :treehouse,
      space: "replica:treehouse:space:owner-test",
      bootstrap: id("bootstrap"),
      binding: id("binding"),
      revision: 0,
      previous: nil,
      entries: [
        %{
          product: :treehouse,
          replica: "replica:treehouse:space:owner-test",
          kind: :space,
          schema: :treehouse_space_v1,
          root: :crypto.hash(:sha256, "root"),
          genesis: id("genesis"),
          creation: id("creation"),
          reference: id("bootstrap"),
          route: "/r/" <> id("route"),
          service_id: id("service"),
          service_key: :crypto.hash(:sha256, "service-key")
        }
      ]
    }

    signed = %{
      catalog: catalog,
      signature: Identity.sign(signer, TransportCatalog.catalog_bytes(catalog))
    }

    bytes = Jason.encode!(Wire.encode_value(signed))
    {:ok, ^signed} = TransportCatalog.decode_catalog_json(bytes)
    {TransportCatalog.catalog_id(catalog), bytes}
  end

  test "the owner records catalogued then listed and the store verifies" do
    root = Path.expand(".catalog-owner-#{System.unique_integer([:positive])}", File.cwd!())
    File.mkdir!(root)
    File.chmod!(root, 0o700)
    on_exit(fn -> File.rm_rf!(root) end)

    manifest_file = Path.join(root, "active.json")
    File.write!(manifest_file, "manifest")
    File.chmod!(manifest_file, 0o600)
    active = %{path: manifest_file, sha256: Journal.digest("manifest")}

    identity = Path.join(root, "service.identity")
    identity_bytes = Base.encode16(:crypto.hash(:sha256, "owner-service"), case: :lower)
    File.write!(identity, identity_bytes)
    File.chmod!(identity, 0o600)

    ready = %{
      "version" => 1,
      "phase" => "ready",
      "attempt" => id("attempt"),
      "generation" => 1,
      "catalog_head" => nil,
      "manifest_digest" => Journal.digest("manifest"),
      "artifacts" => [
        %{
          "kind" => "manifest",
          "op_id" => nil,
          "replica" => nil,
          "review" => nil,
          "path" => Path.join(root, "staged-manifest"),
          "sha256" => Journal.digest("manifest")
        }
      ],
      "service" => %{
        "identity_file" => identity,
        "realm" => "service",
        "pub" => Base.encode64(Identity.from_seed("service", "owner-service").pub),
        "sha256" => Journal.digest(identity_bytes)
      }
    }

    journal = Path.join(root, "operator-journal.json")
    File.write!(journal, Journal.encode(ready))
    File.chmod!(journal, 0o600)

    assert {:ok, incarnation} = Lock.boot(root, manifest_file, active.sha256)

    key = Identity.from_seed("catalog", "owner-test")
    {catalog_id, bytes} = envelope(key)
    sha = Journal.digest(bytes)

    artifact = %{
      "kind" => "catalog",
      "op_id" => catalog_id,
      "replica" => "replica:treehouse:space:owner-test",
      "review" => nil,
      "path" => CatalogStore.file_path(root, sha),
      "sha256" => sha
    }

    catalogued =
      %{ready | "phase" => "catalogued", "catalog_head" => catalog_id}
      |> Map.update!("artifacts", &(&1 ++ [artifact]))

    {:ok, raw_ready} = Journal.read(root)

    assert :ok =
             Lock.catalogued(
               root,
               raw_ready,
               active,
               Journal.encode(catalogued),
               incarnation,
               bytes
             )

    assert File.read!(CatalogStore.file_path(root, sha)) == bytes
    {:ok, raw_catalogued} = Journal.read(root)
    listed = %{catalogued | "phase" => "listed"}
    assert :ok = Lock.listed(root, raw_catalogued, active, Journal.encode(listed), incarnation)

    assert {:ok, %{head: ^catalog_id, head_revision: 0, pending: nil}} =
             CatalogStore.verify(root, key.pub)

    assert {:ok, raw} = Journal.read(root)
    assert {:ok, %{"phase" => "listed"}} = Journal.decode(raw)
  end
end
