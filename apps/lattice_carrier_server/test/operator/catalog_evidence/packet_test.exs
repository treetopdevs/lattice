defmodule LatticeCarrierServer.Operator.CatalogEvidence.PacketTest do
  use ExUnit.Case, async: true
  alias Lattice.{Authority, Log, Op}
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

  test "more than one page preserves the entire signed revision chain", %{
    f: f,
    histories: histories
  } do
    {catalogs, head} =
      Enum.map_reduce(0..32, nil, fn revision, previous ->
        catalog = %{f.catalog | revision: revision, previous: previous}
        envelope = CatalogTrustVectors.sign_catalog(catalog, f.space.catalog)
        bytes = CatalogTrustVectors.artifact_json(envelope) <> " \n"
        {bytes, TransportCatalog.catalog_id(catalog)}
      end)

    assert {:ok, bytes} = Packet.encode(f.space_log, Enum.reverse(catalogs), histories, head)
    assert {:ok, packet} = Packet.decode(bytes)
    assert Enum.map(packet.pages, &length(&1["catalogs"])) == [32, 1]
    assert Enum.flat_map(packet.pages, & &1["catalogs"]) == catalogs
    assert Enum.at(packet.pages, 1)["histories"] == []
  end

  test "signed fork, missing predecessor and changed signature refuse", %{
    f: f,
    histories: histories,
    head: head
  } do
    next = %{f.catalog | revision: 1, previous: head}

    next_bytes =
      next
      |> CatalogTrustVectors.sign_catalog(f.space.catalog)
      |> CatalogTrustVectors.artifact_json()

    assert {:error, :catalog_chain_incomplete} =
             Packet.encode(
               f.space_log,
               [next_bytes],
               histories,
               TransportCatalog.catalog_id(next)
             )

    [first | rest] = f.catalog.entries

    fork = %{
      f.catalog
      | entries: [%{first | route: "/r/" <> CatalogTrustVectors.id("fork-route")} | rest]
    }

    fork_bytes =
      fork
      |> CatalogTrustVectors.sign_catalog(f.space.catalog)
      |> CatalogTrustVectors.artifact_json()

    assert {:error, :catalog_fork} =
             Packet.encode(f.space_log, [f.catalog_json, fork_bytes], histories, head)

    bad = %{f.catalog_envelope | signature: <<0::512>>} |> CatalogTrustVectors.artifact_json()

    assert {:error, :invalid_catalog_signature} =
             Packet.encode(f.space_log, [bad], histories, head)
  end

  test "current child authority loss and unrelated history cannot hide behind valid signatures",
       %{f: f, histories: histories, head: head} do
    thread = hd(f.threads)

    revoke =
      Op.new(
        thread.root,
        thread.replica,
        [thread.genesis.id],
        :authority,
        {:revoke, thread.creation.cap}
      )

    revoked = Log.append!(thread.log, revoke)
    assert Map.has_key?(Authority.analyze(Treehouse.Thread, revoked).reasons, thread.creation.id)

    assert {:error, reason} =
             Packet.encode(
               f.space_log,
               [f.catalog_json],
               Map.put(histories, thread.replica, revoked),
               head
             )

    assert reason in [:trust_pending, :invalid_catalog_transition]
    other = CatalogTrustVectors.fixture(2).threads |> List.last()

    assert {:error, :invalid_verified_history} =
             Packet.encode(
               f.space_log,
               [f.catalog_json],
               Map.put(histories, other.replica, other.log),
               head
             )
  end
end
