defmodule LatticeCarrierServer.Operator.CatalogStoreTest do
  # Pure reads, so this runs on every host. Envelopes are built inline; the
  # lattice_core vector module is not on this app's test path.
  use ExUnit.Case, async: false
  alias Lattice.Carrier.Wire
  alias Lattice.Identity
  alias LatticeCarrierServer.Operator.{CatalogStore, Journal, Lock}
  alias Treehouse.TransportCatalog

  setup do
    root = Path.expand(".catalog-store-test-#{System.unique_integer([:positive])}", File.cwd!())
    File.mkdir!(root)
    File.chmod!(root, 0o700)
    on_exit(fn -> File.rm_rf!(root) end)
    {:ok, root: root}
  end

  defp id(tag), do: Base.url_encode64(:crypto.hash(:sha256, tag), padding: false)
  defp signer(tag \\ "catalog"), do: Identity.from_seed("catalog", "store-test-" <> tag)

  # One envelope: `previous` is the prior envelope or nil; `variant` changes
  # the bytes so two envelopes can share a previous.
  defp envelope(revision, previous, variant \\ "a", signer \\ signer()) do
    catalog = %{
      version: 1,
      product: :treehouse,
      space: "replica:treehouse:space:store-test",
      bootstrap: id("bootstrap"),
      binding: id("binding"),
      revision: revision,
      previous: previous && previous.id,
      entries: [
        %{
          product: :treehouse,
          replica: "replica:treehouse:space:store-test",
          kind: :space,
          schema: :treehouse_space_v1,
          root: :crypto.hash(:sha256, "root"),
          genesis: id("genesis"),
          creation: id("creation"),
          reference: id("bootstrap"),
          route: "/r/" <> id("route-" <> variant),
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

    %{
      id: TransportCatalog.catalog_id(catalog),
      bytes: bytes,
      sha256: Journal.digest(bytes),
      revision: revision
    }
  end

  defp store(root, envelopes) do
    dir = CatalogStore.path(root)
    File.mkdir_p!(dir)
    File.chmod!(dir, 0o700)
    for e <- envelopes, do: put(root, e.sha256 <> ".json", e.bytes)
  end

  defp put(root, name, bytes) do
    file = Path.join(CatalogStore.path(root), name)
    File.write!(file, bytes)
    File.chmod!(file, 0o600)
    file
  end

  defp record(root, phase, envelopes) do
    artifacts =
      for e <- envelopes do
        %{
          "path" => CatalogStore.file_path(root, e.sha256),
          "sha256" => e.sha256,
          "kind" => "catalog",
          "replica" => "replica:treehouse:space:store-test",
          "op_id" => e.id,
          "review" => nil
        }
      end

    identity = Path.join(root, "service.identity")

    %{
      "version" => 1,
      "phase" => phase,
      "attempt" => id("attempt"),
      "generation" => 1,
      "catalog_head" => envelopes |> List.last() |> then(&(&1 && &1.id)),
      "manifest_digest" => Journal.digest("manifest"),
      "artifacts" => [
        %{
          "path" => Path.join(root, "manifest"),
          "sha256" => Journal.digest("manifest"),
          "kind" => "manifest",
          "replica" => nil,
          "op_id" => nil,
          "review" => nil
        }
        | artifacts
      ],
      "service" => %{
        "identity_file" => identity,
        "realm" => "service",
        "pub" => Base.encode64(:crypto.hash(:sha256, "pub")),
        "sha256" => Journal.digest("identity")
      }
    }
  end

  defp journal(root, phase, envelopes) do
    file = Journal.path(root)
    File.write!(file, Journal.encode(record(root, phase, envelopes)))
    File.chmod!(file, 0o600)
  end

  defp history(root, lines) do
    File.write!(Journal.history_path(root), Enum.map_join(lines, &(&1 <> "\n")))
    File.chmod!(Journal.history_path(root), 0o600)
  end

  test "an absent or empty store is empty", %{root: root} do
    assert {:ok, %{head: nil, head_revision: nil, pending: nil, envelopes: envelopes}} =
             CatalogStore.verify(root, nil)

    assert envelopes == %{}
    File.mkdir!(CatalogStore.path(root))
    File.chmod!(CatalogStore.path(root), 0o700)
    assert {:ok, %{head: nil, pending: nil}} = CatalogStore.verify(root, signer().pub)
    assert {:ok, nil} = CatalogStore.committed_head(root)
  end

  test "a chain of revision 0 and 1 with receipts reports the head", %{root: root} do
    zero = envelope(0, nil)
    one = envelope(1, zero)
    store(root, [zero, one])
    history(root, [Journal.encode(record(root, "catalogued", [zero]))])
    journal(root, "catalogued", [one])

    assert {:ok, result} = CatalogStore.verify(root, signer().pub)
    assert result.head == one.id and result.head_revision == 1 and result.pending == nil

    assert result.envelopes == %{
             zero.id => %{sha256: zero.sha256, revision: 0, previous: nil},
             one.id => %{sha256: one.sha256, revision: 1, previous: zero.id}
           }

    assert {:ok, one.id} == CatalogStore.committed_head(root)
    assert {:ok, documents} = CatalogStore.committed_documents(root, signer().pub)
    assert documents.head == one.id
    assert Enum.map(documents.documents, & &1.bytes) == [zero.bytes, one.bytes]
    assert Enum.map(documents.documents, & &1.id) == [zero.id, one.id]

    assert {:error, :catalog_store_corrupt} =
             CatalogStore.committed_documents(root, signer("other").pub)
  end

  test "a killed temp write leaves the store readable", %{root: root} do
    zero = envelope(0, nil)
    store(root, [zero])
    put(root, ".tmp." <> String.duplicate("a", 32), "partial")
    journal(root, "catalogued", [zero])

    assert {:ok, %{head: head, pending: nil}} = CatalogStore.verify(root, nil)
    assert head == zero.id
  end

  test "an envelope without a receipt is pending", %{root: root} do
    zero = envelope(0, nil)
    one = envelope(1, zero)
    store(root, [zero, one])
    journal(root, "catalogued", [zero])

    assert {:ok, %{head: head, pending: pending}} = CatalogStore.verify(root, nil)
    assert head == zero.id
    assert pending == %{id: one.id, sha256: one.sha256, revision: 1}

    assert {:error, :catalog_publication_pending} =
             CatalogStore.committed_documents(root, signer().pub)
  end

  test "with no receipt the first envelope is pending", %{root: root} do
    zero = envelope(0, nil)
    store(root, [zero])

    assert {:ok, %{head: nil, pending: %{id: id, revision: 0}}} = CatalogStore.verify(root, nil)
    assert id == zero.id
  end

  test "a deleted tail envelope with a receipt is corrupt", %{root: root} do
    zero = envelope(0, nil)
    one = envelope(1, zero)
    store(root, [zero])
    journal(root, "catalogued", [one])

    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  test "a history receipt for a missing envelope is corrupt", %{root: root} do
    zero = envelope(0, nil)
    one = envelope(1, zero)
    store(root, [one])
    history(root, [Journal.encode(record(root, "catalogued", [zero]))])

    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  test "two envelopes on one previous are a fork", %{root: root} do
    zero = envelope(0, nil)
    store(root, [zero, envelope(1, zero, "a"), envelope(1, zero, "b")])

    assert {:error, :catalog_fork} = CatalogStore.verify(root, nil)
  end

  test "two revision 0 envelopes are a fork", %{root: root} do
    store(root, [envelope(0, nil, "a"), envelope(0, nil, "b")])

    assert {:error, :catalog_fork} = CatalogStore.verify(root, nil)
  end

  test "a gap in the chain is corrupt", %{root: root} do
    zero = envelope(0, nil)
    one = envelope(1, zero)
    store(root, [zero, envelope(2, one)])

    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  test "a chain without revision 0 is corrupt", %{root: root} do
    zero = envelope(0, nil)
    store(root, [envelope(1, zero)])

    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  test "a bad signature is corrupt with a key and accepted without one", %{root: root} do
    store(root, [envelope(0, nil, "a", signer("other"))])

    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, signer().pub)
    assert {:ok, %{pending: %{revision: 0}}} = CatalogStore.verify(root, nil)
  end

  test "two envelopes past the head are a fork", %{root: root} do
    zero = envelope(0, nil)
    one = envelope(1, zero)
    store(root, [zero, one, envelope(2, one)])
    journal(root, "catalogued", [zero])

    assert {:error, :catalog_fork} = CatalogStore.verify(root, nil)
  end

  test "a torn history tail is ignored", %{root: root} do
    zero = envelope(0, nil)
    store(root, [zero])
    line = Journal.encode(record(root, "catalogued", [zero]))
    File.write!(Journal.history_path(root), line <> "\n" <> binary_part(line, 0, 40))
    File.chmod!(Journal.history_path(root), 0o600)
    journal(root, "catalogued", [zero])

    assert {:ok, %{head: head}} = CatalogStore.verify(root, nil)
    assert head == zero.id
  end

  test "a complete history line that does not decode is corrupt", %{root: root} do
    File.write!(Journal.history_path(root), "not a journal\n")

    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  test "an unknown file name is corrupt", %{root: root} do
    store(root, [envelope(0, nil)])
    put(root, "notes.txt", "x")

    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  test "a file whose bytes do not match its name is corrupt", %{root: root} do
    zero = envelope(0, nil)
    store(root, [])
    put(root, Journal.digest("other") <> ".json", zero.bytes)

    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  test "a readable envelope or store directory is corrupt", %{root: root} do
    zero = envelope(0, nil)
    [file] = store(root, [zero])
    File.chmod!(file, 0o644)
    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)

    File.chmod!(file, 0o600)
    File.chmod!(CatalogStore.path(root), 0o755)
    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  test "a hard-linked envelope is corrupt", %{root: root} do
    zero = envelope(0, nil)
    [file] = store(root, [zero])
    :ok = File.ln(file, Path.join(root, "alias"))

    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  test "a receipt naming other file bytes is corrupt", %{root: root} do
    zero = envelope(0, nil)
    store(root, [zero])
    journal(root, "catalogued", [%{zero | sha256: Journal.digest("other")}])

    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  test "the journal refuses a catalog artifact outside the store path", %{root: root} do
    zero = envelope(0, nil)
    store(root, [zero])
    journal(root, "catalogued", [zero])
    assert {:ok, _} = Journal.read(root)

    record = record(root, "catalogued", [zero])

    moved =
      update_in(record, ["artifacts", Access.at(1), "path"], fn _ ->
        Path.join(root, "#{zero.sha256}.json")
      end)

    File.write!(Journal.path(root), Journal.encode(moved))
    assert {:error, :corrupt_operator_journal} = Journal.read(root)
  end

  test "an unreceipted envelope under a receipted head is corrupt", %{root: root} do
    zero = envelope(0, nil)
    one = envelope(1, zero)
    store(root, [zero, one])
    journal(root, "catalogued", [one])

    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  defp ready_with_head(root, head) do
    file = Journal.path(root)
    File.write!(file, Journal.encode(%{record(root, "ready", []) | "catalog_head" => head}))
    File.chmod!(file, 0o600)
  end

  test "the journal head must equal the committed head", %{root: root} do
    zero = envelope(0, nil)
    ready_with_head(root, zero.id)
    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)

    store(root, [zero])
    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)

    history(root, [Journal.encode(record(root, "catalogued", [zero]))])
    assert {:ok, %{head: head}} = CatalogStore.verify(root, nil)
    assert head == zero.id

    ready_with_head(root, nil)
    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  defp temp_name, do: ".tmp." <> Base.encode16(:crypto.strong_rand_bytes(16), case: :lower)

  test "a final linked to exactly one temp is an interrupted publish", %{root: root} do
    zero = envelope(0, nil)
    [file] = store(root, [zero])
    tmp = Path.join(CatalogStore.path(root), temp_name())
    :ok = File.ln(file, tmp)
    assert {:ok, %{pending: %{revision: 0}}} = CatalogStore.verify(root, nil)

    :ok = File.ln(file, Path.join(CatalogStore.path(root), temp_name()))
    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  test "a final linked outside the store is corrupt even with a temp", %{root: root} do
    zero = envelope(0, nil)
    [file] = store(root, [zero])
    put(root, temp_name(), "partial")
    :ok = File.ln(file, Path.join(root, "alias"))

    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  test "a temp must be a private regular file", %{root: root} do
    store(root, [])
    dir = Path.join(CatalogStore.path(root), temp_name())
    File.mkdir!(dir)
    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
    File.rmdir!(dir)

    link = Path.join(CatalogStore.path(root), temp_name())
    :ok = File.ln_s(Path.join(root, "elsewhere"), link)
    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
    File.rm!(link)

    file = put(root, temp_name(), "partial")
    assert {:ok, _} = CatalogStore.verify(root, nil)
    File.chmod!(file, 0o644)
    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  test "a lost journal with a receipt in history is corrupt", %{root: root} do
    zero = envelope(0, nil)
    store(root, [zero])
    history(root, [Journal.encode(record(root, "catalogued", [zero]))])
    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
    journal(root, "catalogued", [zero])
    assert {:ok, %{head: _}} = CatalogStore.verify(root, nil)
  end

  test "catalogued refuses a record that does not name the envelope bytes", %{root: root} do
    zero = envelope(0, nil)
    other = envelope(0, nil, "b")
    expected = Journal.encode(record(root, "ready", []))
    manifest = %{path: Path.join(root, "active.json"), sha256: Journal.digest("manifest")}
    mismatch = {:error, :catalog_artifact_mismatch}

    # Record names `zero`; the bytes are another envelope's.
    record = Journal.encode(record(root, "catalogued", [zero]))
    assert mismatch == Lock.catalogued(root, expected, manifest, record, "i", other.bytes)

    # Right bytes, wrong path.
    moved = record(root, "catalogued", [other])
    moved = put_in(moved, ["artifacts", Access.at(1), "path"], Path.join(root, "x.json"))

    assert mismatch ==
             Lock.catalogued(root, expected, manifest, Journal.encode(moved), "i", other.bytes)

    # A ready record holds no catalog artifact.
    ready = Journal.encode(record(root, "ready", []))
    assert mismatch == Lock.catalogued(root, expected, manifest, ready, "i", zero.bytes)

    # Bytes that are not a catalog envelope.
    assert mismatch == Lock.catalogued(root, expected, manifest, record, "i", "junk")

    # A receipt attributed to another Space.
    elsewhere =
      put_in(record(root, "catalogued", [zero]), ["artifacts", Access.at(1), "replica"], "other")

    assert mismatch ==
             Lock.catalogued(root, expected, manifest, Journal.encode(elsewhere), "i", zero.bytes)
  end

  test "catalogued refuses an envelope that does not extend the committed head", %{root: root} do
    zero = envelope(0, nil)
    one = envelope(1, zero)
    store(root, [zero, one])
    history(root, [Journal.encode(record(root, "catalogued", [zero]))])
    journal(root, "catalogued", [one])
    expected = Journal.encode(record(root, "ready", []))
    manifest = %{path: Path.join(root, "active.json"), sha256: Journal.digest("manifest")}

    snapshot = fn ->
      {File.read!(Journal.path(root)), File.read!(Journal.history_path(root)),
       File.ls!(CatalogStore.path(root)) |> Enum.sort()}
    end

    before = snapshot.()

    for {label, bad} <- [
          {"second revision-0 chain", envelope(0, nil, "b")},
          {"previous is not the head", envelope(1, zero, "b")},
          {"skipped revision", envelope(3, one, "b")}
        ] do
      record = Journal.encode(record(root, "catalogued", [bad]))

      assert {:error, :catalog_artifact_mismatch} ==
               Lock.catalogued(root, expected, manifest, record, "i", bad.bytes),
             label

      assert snapshot.() == before, label
    end

    # The head's next revision passes the chain check and reaches the owner,
    # which refuses here only off Linux.
    next = envelope(2, one)
    record = Journal.encode(record(root, "catalogued", [next]))
    result = Lock.catalogued(root, expected, manifest, record, "i", next.bytes)
    refute result == {:error, :catalog_artifact_mismatch}
  end

  test "a receipt naming another Space is corrupt", %{root: root} do
    zero = envelope(0, nil)
    store(root, [zero])

    elsewhere =
      put_in(record(root, "catalogued", [zero]), ["artifacts", Access.at(1), "replica"], "other")

    File.write!(Journal.path(root), Journal.encode(elsewhere))
    File.chmod!(Journal.path(root), 0o600)
    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end

  test "a history file that is not this user's private single-link file is corrupt", %{root: root} do
    zero = envelope(0, nil)
    store(root, [zero])
    history(root, [Journal.encode(record(root, "catalogued", [zero]))])
    journal(root, "catalogued", [zero])
    assert {:ok, _} = CatalogStore.verify(root, nil)

    File.chmod!(Journal.history_path(root), 0o640)
    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)

    File.chmod!(Journal.history_path(root), 0o600)
    File.ln!(Journal.history_path(root), Path.join(root, "history-alias"))
    assert {:error, :catalog_store_corrupt} = CatalogStore.verify(root, nil)
  end
end
