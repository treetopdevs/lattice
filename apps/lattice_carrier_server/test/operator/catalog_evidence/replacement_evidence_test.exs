defmodule LatticeCarrierServer.Operator.CatalogEvidence.ReplacementEvidenceTest do
  # Plan 316 PR 6 (exporter-test part): a Space log carrying a Core-honored
  # replace_catalog_v1 and a refused one exports as raw evidence. The packet head stays
  # the bootstrap catalog; this is not catalog replacement trust or a route switch.
  use ExUnit.Case, async: false
  alias Lattice.{Authority, Log, Op}
  alias Lattice.Authority.Delegation
  alias Lattice.Carrier.Wire

  alias LatticeCarrierServer.Operator.{
    CatalogEvidence.Packet,
    CatalogEvidenceConsumer,
    PublicHistory
  }

  alias Treehouse.{
    CatalogCutoff,
    CatalogReplacementVectors,
    CatalogTrustVectors,
    Space,
    TransportCatalog
  }

  setup do
    f = fixture()
    head = TransportCatalog.catalog_id(f.trust.catalog)
    assert {:ok, bytes} = Packet.encode(f.log, [f.trust.catalog_json], f.histories, head)
    assert {:ok, packet} = Packet.decode(bytes)
    %{f: f, head: head, bytes: bytes, packet: packet}
  end

  test "a Core-honored replace_catalog_v1 and raw refused replacement evidence export verbatim; the head does not move",
       %{f: f, head: head, bytes: bytes, packet: packet} do
    reasons = Authority.analyze(Space, f.log).reasons
    assert reasons[f.replacement.id] == nil
    assert reasons[f.non_admin.id] == :role_not_granted
    assert map_size(reasons) == 1

    assert packet.head == head
    assert packet.bootstrap_id == f.trust.review.bootstrap_id
    assert [page] = packet.pages
    assert page["rotations"] == []
    assert page["cutoffProofs"] == []
    assert page["catalogs"] == [f.trust.catalog_json]

    assert [space] = Enum.filter(page["histories"], &(&1["replica"] == f.log.replica))
    assert space["frames"] == PublicHistory.frames(f.log)
    assert Wire.encode_op(f.replacement) in space["frames"]
    assert Wire.encode_op(f.non_admin) in space["frames"]

    assert space["rejected"] == [
             %{"frame" => Wire.encode_op(f.bad_signature), "reason" => "bad_signature"}
           ]

    assert {:ok, ^bytes} = Packet.encode(f.log, [f.trust.catalog_json], f.histories, head)
  end

  # Spawns node; measured locally at about 1.2 s. The margin covers loaded CI (row 342).
  # The consumer prints only the head and a byte length, so this is head and size parity.
  @tag timeout: 120_000
  test "the independent TS consumer reconstructs the same head and candidate snapshot size", %{
    bytes: bytes,
    packet: packet
  } do
    path =
      Path.join(
        System.tmp_dir!(),
        "catalog-evidence-replacement-#{System.unique_integer([:positive])}.json"
      )

    on_exit(fn -> File.rm(path) end)
    File.write!(path, bytes, [:exclusive])
    {output, status} = CatalogEvidenceConsumer.consume(path)
    assert status == 0, output

    head = packet.head
    snapshot = packet.snapshot_bytes
    assert %{"head" => ^head, "snapshotBytes" => ^snapshot} = JSON.decode!(output)
  end

  test "a replacement frame with a changed signature cannot be exported as verified evidence",
       %{f: f, bytes: bytes} do
    honored = Wire.encode_op(f.replacement)
    forged = Wire.encode_op(%{f.replacement | sig: <<0::512>>})
    assert forged != honored

    doc =
      update_in(JSON.decode!(bytes), ["pages", Access.at(0), "histories"], fn histories ->
        Enum.map(histories, fn history ->
          Map.update!(history, "frames", fn frames ->
            Enum.map(frames, &if(&1 == honored, do: forged, else: &1))
          end)
        end)
      end)

    assert PublicHistory.canonical(doc) != bytes
    assert Packet.decode(PublicHistory.canonical(doc)) == {:error, :invalid_verified_history}
  end

  # The trust fixture's Space log (with its Thread reference) plus the replacement
  # fixture's quarantined create_space, genuine create_space and beacon, then a
  # Core-honored admin replacement over that merged frontier and a refused nominee
  # replacement under a granted no-admin delegation.
  defp fixture do
    trust = CatalogTrustVectors.fixture()
    r = CatalogReplacementVectors.fixture()
    bad_signature = %{r.genuine | sig: <<0::512>>}

    {:quarantined, log, :bad_signature} = Log.accept(trust.space_log, bad_signature)
    log = log |> Log.append!(r.genuine) |> Log.append!(r.beacon)

    {:ok, cutoff} = CatalogCutoff.derive(log)
    claim = %{r.claim | deps: Enum.sort(Log.frontier(log)), cutoffs: [cutoff.cutoff]}

    replacement =
      CatalogReplacementVectors.replacement_op(
        r,
        claim,
        CatalogReplacementVectors.signed_args(r, claim)
      )

    no_admin =
      Delegation.new(r.root, r.replica, r.nominee.pub,
        parent_id: r.delegation.id,
        ops: [:create_space, :replace_catalog_v1],
        roles: []
      )

    log = Log.append!(log, replacement)

    grant =
      Op.new(r.root, r.replica, Enum.sort(Log.frontier(log)), :authority, {:grant, no_admin})

    log = Log.append!(log, grant)

    nominee_claim = %{
      claim
      | author: r.nominee.pub,
        cap: no_admin.id,
        deps: Enum.sort(Log.frontier(log))
    }

    non_admin =
      CatalogReplacementVectors.replacement_op(
        r,
        nominee_claim,
        CatalogReplacementVectors.signed_args(r, nominee_claim),
        identity: r.nominee,
        cap: no_admin.id
      )

    log = Log.append!(log, non_admin)
    histories = Map.new([log | Enum.map(trust.threads, & &1.log)], &{&1.replica, &1})

    %{
      trust: trust,
      log: log,
      histories: histories,
      bad_signature: bad_signature,
      replacement: replacement,
      non_admin: non_admin
    }
  end
end
