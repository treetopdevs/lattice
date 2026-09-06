defmodule Treehouse.TransportCatalogTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Canonical, Identity}
  alias Lattice.Carrier.Wire
  alias Treehouse.TransportCatalog

  setup do
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

    %{root: root, signer: signer, service: service, catalog: catalog}
  end

  test "a signed catalog verifies only against the independently supplied catalog key", ctx do
    envelope = signed(ctx.catalog, ctx.signer)
    assert :ok = TransportCatalog.verify_catalog(envelope, ctx.signer.pub)

    assert {:error, :invalid_catalog_signature} =
             TransportCatalog.verify_catalog(envelope, ctx.root.pub)
  end

  test "even the legitimate signer cannot introduce ambiguous or unsupported catalog shapes", ctx do
    catalog = ctx.catalog
    [entry] = catalog.entries

    invalid = [
      Map.put(catalog, :extra, true),
      Map.delete(catalog, :binding),
      %{catalog | version: 2},
      %{catalog | product: :township},
      %{catalog | space: <<255>>},
      %{catalog | bootstrap: "not-an-id"},
      %{catalog | revision: 9_007_199_254_740_992},
      %{catalog | previous: id("previous")},
      %{catalog | revision: 1},
      %{catalog | entries: []},
      %{catalog | entries: [entry, entry]},
      %{catalog | entries: [Map.put(entry, :extra, true)]},
      %{catalog | entries: [%{entry | root: <<0::248>>}]},
      %{catalog | entries: [%{entry | schema: :treehouse_thread_v1}]},
      %{catalog | entries: [%{entry | route: "/r/../route"}]},
      %{catalog | entries: [%{entry | service_key: <<0::248>>}]}
    ]

    for candidate <- invalid do
      assert {:error, :malformed_catalog} =
               TransportCatalog.verify_catalog(signed(candidate, ctx.signer), ctx.signer.pub)
    end

    assert {:error, :malformed_catalog} =
             TransportCatalog.verify_catalog(Map.put(signed(catalog, ctx.signer), :key, ctx.signer.pub), ctx.signer.pub)

    assert {:error, :malformed_catalog} =
             TransportCatalog.verify_catalog(%{catalog: %{catalog | revision: -1}, signature: <<0::512>>}, ctx.signer.pub)
  end

  defp signed(catalog, signer) do
    signature = Identity.sign(signer, Canonical.term(["lattice-treehouse-transport-catalog-v1", catalog]))
    %{catalog: catalog, signature: signature}
  end

  test "raw standalone ingress refuses duplicate signed fields before wire normalization", ctx do
    envelope = signed(ctx.catalog, ctx.signer)
    ["map", pairs] = raw = Wire.encode_value(envelope)
    assert :ok = TransportCatalog.verify_catalog_json(Jason.encode!(raw), ctx.signer.pub)

    duplicate = ["map", pairs ++ [hd(pairs)]]
    assert {:ok, ^envelope} = Wire.decode_value(duplicate)
    assert {:error, :malformed_catalog} =
             TransportCatalog.verify_catalog_json(Jason.encode!(duplicate), ctx.signer.pub)

    nested_duplicate = ["map", Enum.map(pairs, fn
      {["atom", "catalog"], _} -> raise "wire pairs are lists"
      [["atom", "catalog"] = key, ["map", fields]] -> [key, ["map", fields ++ [hd(fields)]]]
      pair -> pair
    end)]
    assert {:error, :malformed_catalog} =
             TransportCatalog.verify_catalog_json(Jason.encode!(nested_duplicate), ctx.signer.pub)

    deep = Enum.reduce(1..65, ["int", 0], fn _, term -> ["list", [term]] end)
    assert {:error, :malformed_catalog} =
             TransportCatalog.verify_catalog_json(Jason.encode!(deep), ctx.signer.pub)
    assert {:error, :control_history_limit} =
             TransportCatalog.verify_catalog_json(String.duplicate(" ", 131_073), ctx.signer.pub)
  end

  defp id(label), do: :crypto.hash(:sha256, label) |> Base.url_encode64(padding: false)
end
