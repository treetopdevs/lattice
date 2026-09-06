defmodule Treehouse.TransportCatalogTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Canonical, Identity}
  alias Treehouse.TransportCatalog

  test "a signed catalog verifies only against the independently supplied catalog key" do
    root = Identity.from_seed("catalog-root", "catalog-root")
    signer = Identity.from_seed("catalog-signer", "catalog-signer")
    service = Identity.from_seed("catalog-service", "catalog-service")

    replica =
      Authority.bind_replica(
        "replica:treehouse:space:" <> id("space") <> "#authority:bounded-continuation-v1",
        root.pub
      )

    catalog = %{
      version: 1,
      product: :treehouse,
      space: replica,
      bootstrap: id("bootstrap"),
      binding: id("bootstrap"),
      revision: 0,
      previous: nil,
      entries: [
        %{
          product: :treehouse,
          replica: replica,
          kind: :space,
          schema: :treehouse_space_v1,
          root: root.pub,
          genesis: id("genesis"),
          creation: id("create-space"),
          reference: id("bootstrap"),
          route: "/r/" <> id("route"),
          service_id: id("service"),
          service_key: service.pub
        }
      ]
    }

    signature =
      Identity.sign(signer, Canonical.term(["lattice-treehouse-transport-catalog-v1", catalog]))

    envelope = %{catalog: catalog, signature: signature}
    assert :ok = TransportCatalog.verify_catalog(envelope, signer.pub)

    assert {:error, :invalid_catalog_signature} =
             TransportCatalog.verify_catalog(envelope, root.pub)
  end

  defp id(label), do: :crypto.hash(:sha256, label) |> Base.url_encode64(padding: false)
end
