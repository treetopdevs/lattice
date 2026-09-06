defmodule Treehouse.CatalogVectors do
  @moduledoc "Deterministic public codec evidence; synthetic metadata is not installed catalog trust."
  alias Lattice.{Authority, Identity}
  alias Lattice.Carrier.Wire
  alias Treehouse.TransportCatalog, as: Catalog

  @spec codec_vector() :: map()
  def codec_vector do
    root = Identity.from_seed("root", "r11a-beam-root")
    old = Identity.from_seed("catalog", "r11a-beam-catalog")
    next = Identity.from_seed("next", "r11a-beam-next")
    service = Identity.from_seed("service", "r11a-beam-service")
    space = Authority.bind_replica("replica:treehouse:space:" <> id("space") <> "#authority:bounded-continuation-v1", root.pub)
    thread = Authority.bind_replica("replica:treehouse:thread:" <> id("thread") <> "#authority:bounded-continuation-v1", root.pub)
    bootstrap = %{version: 1, product: :treehouse, space: space, space_root: root.pub,
      profile_genesis: id("profile-genesis"), profile_id: id("profile"),
      replacement_rule: :bounded_space_admin_v1, catalog_key: old.pub,
      service_id: id("service"), service_key: service.pub, origin: "wss://beam-relay.invalid:8443", nonce: id("bootstrap-nonce")}
    entries = for {kind, replica} <- [space: space, thread: thread] do
      %{product: :treehouse, replica: replica, kind: kind,
        schema: if(kind == :space, do: :treehouse_space_v1, else: :treehouse_thread_v1),
        root: root.pub, genesis: id("#{kind}-genesis"), creation: id("#{kind}-creation"),
        reference: if(kind == :space, do: id("bootstrap"), else: id("thread-reference")),
        route: "/r/" <> id("#{kind}-route"), service_id: bootstrap.service_id, service_key: service.pub}
    end
    catalog = %{version: 1, product: :treehouse, space: space, bootstrap: id("bootstrap"),
      binding: id("bootstrap"), revision: 0, previous: nil, entries: Enum.sort_by(entries, & &1.replica)}
    envelope = %{catalog: catalog, signature: Identity.sign(old, Catalog.catalog_bytes(catalog))}
    cutoffs = for entry <- catalog.entries do
      %{replica: entry.replica, frontier: [id(entry.replica <> "-frontier")], log_digest: id(entry.replica <> "-log")}
    end
    rotation = %{version: 1, product: :treehouse, space: space, bootstrap: catalog.bootstrap,
      parent: catalog.binding, prior_catalog: Catalog.catalog_id(catalog), generation: 1,
      new_catalog_key: next.pub, nonce: id("rotation-nonce"), inventory_digest: Catalog.inventory_id(catalog.entries),
      cutoffs: cutoffs}
    rotated = %{rotation: rotation, old_signature: Identity.sign(old, Catalog.rotation_bytes(rotation)),
      new_signature: Identity.sign(next, Catalog.rotation_possession_bytes(rotation))}
    :ok = Catalog.verify_catalog(envelope, old.pub)
    :ok = Catalog.verify_rotation(rotated, old.pub)
    %{
      bootstrap_term: Wire.encode_value(bootstrap), entry_term: Wire.encode_value(hd(catalog.entries)),
      catalog_envelope_term: Wire.encode_value(envelope), rotation_envelope_term: Wire.encode_value(rotated),
      cutoff_term: Wire.encode_value(hd(cutoffs)), expected_catalog_key: Base.encode64(old.pub), expected_old_key: Base.encode64(old.pub),
      catalog_bytes: Base.encode64(Catalog.catalog_bytes(catalog)), rotation_bytes: Base.encode64(Catalog.rotation_bytes(rotation)),
      possession_bytes: Base.encode64(Catalog.rotation_possession_bytes(rotation)), inventory_bytes: Base.encode64(Catalog.inventory_bytes(catalog.entries)),
      catalog_id: Catalog.catalog_id(catalog), rotation_id: Catalog.rotation_id(rotated), inventory_id: Catalog.inventory_id(catalog.entries)
    }
  end

  @spec write_codec!(String.t()) :: :ok
  def write_codec!(path), do: File.write!(path, Jason.encode!(codec_vector(), pretty: true) <> "\n")

  defp id(label), do: :crypto.hash(:sha256, "r11a-beam-" <> label) |> Base.url_encode64(padding: false)
end
