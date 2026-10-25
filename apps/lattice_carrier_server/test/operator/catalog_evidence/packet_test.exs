defmodule LatticeCarrierServer.Operator.CatalogEvidence.PacketTest do
  use ExUnit.Case, async: true
  alias LatticeCarrierServer.Operator.{CatalogEvidence.Packet, PublicHistory}
  alias Treehouse.{CatalogTrustVectors, TransportCatalog}

  setup do
    fixture = CatalogTrustVectors.fixture()

    histories =
      Map.new([fixture.space_log | Enum.map(fixture.threads, & &1.log)], &{&1.replica, &1})

    %{f: fixture, histories: histories, head: TransportCatalog.catalog_id(fixture.catalog)}
  end

  test "a genuine signed Space/Thread chain round-trips with exact catalog JSON", %{
    f: f,
    histories: histories,
    head: head
  } do
    assert {:ok, bytes} = Packet.encode(f.space_log, [f.catalog_json], histories, head)
    assert {:ok, packet} = Packet.decode(bytes)
    assert packet.head == head
    assert packet.bootstrap_id == f.review.bootstrap_id
    assert packet.snapshot_bytes < 32 * 1024 * 1024
    assert [page] = packet.pages
    assert page["catalogs"] == [f.catalog_json]
    assert Enum.map(page["histories"], & &1["replica"]) == Enum.sort(Map.keys(histories))
    assert {:ok, ^bytes} = Packet.encode(f.space_log, [f.catalog_json], histories, head)
  end

  test "missing history, malformed shape and caller metadata cannot be normalized away", %{
    f: f,
    histories: histories,
    head: head
  } do
    assert {:error, _} =
             Packet.encode(
               f.space_log,
               [f.catalog_json],
               Map.delete(histories, hd(f.threads).log.replica),
               head
             )

    assert {:ok, bytes} = Packet.encode(f.space_log, [f.catalog_json], histories, head)
    doc = JSON.decode!(bytes)

    for mutated <- [
          Map.put(doc, "verified", true),
          Map.put(doc, "bootstrapId", "wrong"),
          Map.put(doc, "head", "wrong")
        ] do
      assert {:error, _} = Packet.decode(PublicHistory.canonical(mutated))
    end

    altered =
      update_in(
        doc,
        ["pages", Access.at(0), "histories", Access.at(0)],
        &Map.put(&1, "authority", "honored")
      )

    assert {:error, :evidence_page_malformed} = Packet.decode(PublicHistory.canonical(altered))
  end

  test "duplicate top keys and bytes beyond the transport cap refuse", %{
    f: f,
    histories: histories,
    head: head
  } do
    assert {:ok, bytes} = Packet.encode(f.space_log, [f.catalog_json], histories, head)

    assert {:error, :evidence_page_malformed} =
             Packet.decode(String.replace_prefix(bytes, "{", "{\"format\":\"wrong\","))

    assert {:error, :evidence_page_too_large} =
             Packet.decode(String.duplicate(" ", 64 * 1024 * 1024 + 1))
  end
end
