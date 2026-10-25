defmodule LatticeCarrierServer.Operator.CatalogEvidence.CapacityTest do
  use ExUnit.Case, async: false
  alias Lattice.{Authority, Log, Op}
  alias Lattice.Carrier.Wire

  alias LatticeCarrierServer.Operator.{
    CatalogEvidence.Packet,
    CatalogEvidenceConsumer,
    PublicHistory
  }

  alias Treehouse.{CatalogTrustVectors, TransportCatalog}

  @artifact 131_072
  @total 16 * 1024 * 1024
  @snapshot 32 * 1024 * 1024

  @tag timeout: 240_000
  test "full artifact budget and exact retained snapshot limit export and import with real evaluators" do
    f = CatalogTrustVectors.fixture()
    thread = hd(f.threads)
    histories = Map.new([f.space_log, thread.log], &{&1.replica, &1})

    {catalogs, head} =
      Enum.map_reduce(0..127, nil, fn revision, previous ->
        catalog = %{f.catalog | revision: revision, previous: previous}

        raw =
          catalog
          |> CatalogTrustVectors.sign_catalog(f.space.catalog)
          |> CatalogTrustVectors.artifact_json()

        padded = raw <> String.duplicate(" ", @artifact - byte_size(raw))
        {padded, TransportCatalog.catalog_id(catalog)}
      end)

    assert Enum.reduce(catalogs, 0, &(byte_size(&1) + &2)) == @total
    assert {:ok, baseline} = Packet.encode(f.space_log, catalogs, histories, head)
    assert {:ok, %{snapshot_bytes: baseline_size}} = Packet.decode(baseline)
    gap = @snapshot - baseline_size
    template = post(thread, 0, 42_000)
    delta = frame_size(template) + 1
    count = div(gap, delta) - 1
    assert count > 0
    posts = Enum.map(1..count, &post(thread, &1, 42_000))
    remaining = gap - count * delta
    first = fitting_post(thread, count + 1, div(remaining, 2))
    remaining = remaining - frame_size(first) - 1
    last = fitting_post(thread, count + 2, remaining)
    residue = remaining - frame_size(last) - 1
    assert residue in 0..3

    # Catalog whitespace is signed-data neutral. Turning a space into a newline
    # keeps the 16 MiB artifact budget fixed while adding one JSON escape byte.
    [zero | rest] = catalogs
    catalogs = [escape_padding(zero, residue) | rest]
    posts = posts ++ [first, last]
    ops = Map.merge(thread.log.ops, Map.new(posts, &{&1.id, &1}))
    grown = Log.from_ops(thread.replica, ops)
    assert :ok = Log.verify_authenticity(grown)
    analysis = Authority.analyze(Treehouse.Thread, grown)
    assert Enum.all?(posts, &(not Map.has_key?(analysis.reasons, &1.id)))

    assert Enum.all?(posts, fn op ->
             byte_size(
               PublicHistory.canonical(%{"type" => "push", "ops" => [Wire.encode_op(op)]})
             ) <= 64_000
           end)

    histories = Map.put(histories, thread.replica, grown)
    assert {:ok, bytes} = Packet.encode(f.space_log, catalogs, histories, head)
    assert byte_size(bytes) < 64 * 1024 * 1024
    assert {:ok, %{snapshot_bytes: @snapshot} = packet} = Packet.decode(bytes)
    assert Enum.flat_map(packet.pages, & &1["catalogs"]) == catalogs

    path =
      Path.join(
        System.tmp_dir!(),
        "catalog-evidence-capacity-#{System.unique_integer([:positive])}.json"
      )

    on_exit(fn -> File.rm(path) end)
    File.write!(path, bytes, [:exclusive])
    {output, status} = CatalogEvidenceConsumer.consume(path)
    assert status == 0, output

    assert %{"head" => ^head, "snapshotBytes" => @snapshot, "artifactBytes" => @total} =
             JSON.decode!(output)

    overflow = [escape_padding(zero, residue + 1) | rest]

    assert {:error, :evidence_page_too_large} =
             Packet.encode(f.space_log, overflow, histories, head)

    next = %{f.catalog | revision: 128, previous: head}

    extra =
      next
      |> CatalogTrustVectors.sign_catalog(f.space.catalog)
      |> CatalogTrustVectors.artifact_json()

    assert {:error, :evidence_page_too_large} =
             Packet.encode(
               f.space_log,
               catalogs ++ [extra],
               histories,
               TransportCatalog.catalog_id(next)
             )

    assert {:error, :evidence_page_too_large} =
             Packet.encode(f.space_log, List.duplicate(f.catalog_json, 1025), histories, head)

    too_many_artifact_bytes = List.update_at(catalogs, 0, &(&1 <> " "))

    assert {:error, :evidence_page_too_large} =
             Packet.encode(f.space_log, too_many_artifact_bytes, histories, head)
  end

  defp escape_padding(raw, count),
    do: binary_part(raw, 0, byte_size(raw) - count) <> String.duplicate("\n", count)

  defp post(thread, index, bytes) do
    prefix = String.pad_leading(Integer.to_string(index), 6, "0")
    body = prefix <> String.duplicate("x", bytes)

    Op.new(thread.root, thread.replica, [thread.creation.id], :command, {:post, [body]},
      cap: thread.delegation.id
    )
  end

  defp frame_size(op), do: byte_size(PublicHistory.canonical(Wire.encode_op(op)))

  defp fitting_post(thread, index, budget) do
    size = search_size(thread, index, budget, 0, 42_000)
    post(thread, index, size)
  end

  defp search_size(_thread, _index, _budget, low, high) when low >= high, do: low

  defp search_size(thread, index, budget, low, high) do
    middle = div(low + high + 1, 2)

    if frame_size(post(thread, index, middle)) + 1 <= budget,
      do: search_size(thread, index, budget, middle, high),
      else: search_size(thread, index, budget, low, middle - 1)
  end
end
