defmodule LatticeCarrierServer.Operator.CatalogReplacementSigningTest do
  # Row 361 (signing path only) on disposable fixtures: a replacement revision 0 builds,
  # packages, reviews and is signed by the NEW signer under the replacement binding id.
  # Core-honored on a snapshot is not resolver acceptance; no production source of a
  # replacement binding exists (PR 4), and no CLI path reaches this.
  use ExUnit.Case, async: false
  alias Lattice.{Log, Op}
  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.Operator.{CatalogSigningPackage, PublicHistory, ReleaseCatalog}

  alias LatticeCarrierServer.Operator.CatalogCeremony.{
    Binding,
    SignCatalog,
    Signer,
    SigningLedger
  }

  alias LatticeCarrierServer.Secret
  alias Treehouse.{CatalogReplacementVectors, TransportCatalog}

  defp id(label), do: :crypto.hash(:sha256, label) |> Base.url_encode64(padding: false)

  setup do
    base = Path.join(System.tmp_dir!(), "r361-sign-#{System.unique_integer([:positive])}")
    File.mkdir_p!(base)
    File.chmod!(base, 0o700)
    on_exit(fn -> File.rm_rf(base) end)

    r = CatalogReplacementVectors.fixture()

    parent = %{
      bootstrap_id: r.bootstrap.id,
      record: r.record,
      realm: TransportCatalog.service_realm(r.record.service_id),
      attested: %{}
    }

    {:ok, derived} = Binding.replacement(parent, r.claim, r.replacement.id)

    # The bootstrap-era catalog: the same Space entry under the parent's service.
    prior = %{
      version: 1,
      product: :treehouse,
      space: r.replica,
      bootstrap: r.bootstrap.id,
      binding: r.bootstrap.id,
      revision: 0,
      previous: nil,
      entries:
        Enum.map(
          r.entries,
          &%{&1 | service_id: r.record.service_id, service_key: r.record.service_key}
        )
    }

    {:ok, catalog} = ReleaseCatalog.replacement_revision_zero(prior, derived)
    histories = %{r.replica => r.log}
    {:ok, bytes} = ReleaseCatalog.replacement_package(catalog, histories)

    {:ok,
     base: base,
     r: r,
     parent: parent,
     derived: derived,
     prior: prior,
     catalog: catalog,
     histories: histories,
     bytes: bytes}
  end

  defp dir!(f, name) do
    dir = Path.join(f.base, name)
    File.mkdir_p!(dir)
    File.chmod!(dir, 0o700)
    dir
  end

  defp seed!(f, name, identity) do
    keys = dir!(f, "keys-" <> name)
    path = Path.join(keys, "signer.seed")
    {:ok, _} = Signer.write_seed(path, Secret.wrap(identity.priv))
    path
  end

  defp review(f, bytes \\ nil, parent \\ nil, claim \\ nil, op_id \\ nil) do
    CatalogSigningPackage.review_replacement(
      bytes || f.bytes,
      parent || f.parent,
      claim || f.r.claim,
      op_id || f.r.replacement.id
    )
  end

  # A package for an arbitrary claim, op id and catalog entries (no `replacement_revision_zero`).
  defp package(f, claim, op_id, entries) do
    {:ok, binding} = Binding.replacement(f.parent, claim, op_id)

    catalog = %{
      f.catalog
      | binding: Binding.binding_id(binding),
        entries: entries
    }

    {:ok, bytes} = CatalogSigningPackage.encode(catalog, f.histories, nil, "replacement")
    {bytes, catalog}
  end

  defp assert_no_ledger(dir), do: refute(File.exists?(Path.join(dir, "catalog-signing")))

  test "a replacement revision 0 builds, packages, reviews, signs and exports status", f do
    r = f.r
    assert TransportCatalog.inventory_id(f.catalog.entries) == r.claim.inventory_digest
    assert f.catalog.entries == r.entries
    assert f.catalog.binding == r.replacement.id
    assert f.catalog.bootstrap == r.bootstrap.id

    # Round-trips byte for byte.
    assert {:ok, decoded} = CatalogSigningPackage.decode(f.bytes)
    assert decoded.mode == "replacement" and decoded.reference == nil
    assert {:ok, again} = CatalogSigningPackage.encode(f.catalog, f.histories, nil, "replacement")
    assert again == f.bytes

    assert {:ok, package} = review(f)
    assert package.binding.binding_id == r.replacement.id
    assert Binding.binding_id(package.binding) == r.replacement.id
    assert package.binding == f.derived

    ceremony = dir!(f, "ceremony-new")
    assert {:ok, _} = SigningLedger.init(ceremony, package.binding)
    signer = seed!(f, "new", r.new_catalog)

    assert {:ok, envelope} = SignCatalog.sign_reviewed(package, ceremony, signer, package.digest)
    assert :ok = TransportCatalog.verify_catalog_json(envelope, r.new_catalog.pub)

    # Replay returns the exact durable bytes without reading a key.
    assert {:ok, ^envelope} =
             SignCatalog.sign_reviewed(package, ceremony, "/absent", package.digest)

    assert {:ok, state} = SigningLedger.status(ceremony, package.binding)
    assert state.head["binding"] == r.replacement.id
    assert state.head["revision"] == 0

    status = SigningLedger.export_status(state, package.binding)
    assert {:ok, verified} = SigningLedger.verify_status(status, package.binding)
    assert verified.committed.catalog == f.catalog

    # The same status is a named refusal under the parent bootstrap binding.
    assert {:error, :catalog_ledger_binding_mismatch} =
             SigningLedger.verify_status(status, f.parent)
  end

  test "review/2 still refuses a replacement package as catalog_binding_mismatch", f do
    assert {:error, :catalog_binding_mismatch} =
             CatalogSigningPackage.review(f.bytes, dir!(f, "any-ceremony"))

    assert {:error, :catalog_binding_mismatch} =
             SignCatalog.sign(f.bytes, dir!(f, "any-ceremony-2"), "/absent", "x")
  end

  test "the derived record's profile fields equal the claim's and the bootstrap's", f do
    {:ok, package} = review(f)
    rec = package.binding.record
    assert rec.profile_genesis == f.r.claim.profile_genesis
    assert rec.profile_id == f.r.claim.profile_id
    assert rec.profile_genesis == f.parent.record.profile_genesis
    assert rec.profile_id == f.parent.record.profile_id

    # A claim naming another profile is not derivable.
    for change <- [%{profile_genesis: id("other-genesis")}, %{profile_id: id("other-profile")}] do
      assert {:error, :catalog_binding_mismatch} =
               review(f, nil, nil, Map.merge(f.r.claim, change))
    end
  end

  describe "refusals" do
    test "wrong op id", f do
      dir = dir!(f, "c")
      assert {:error, :catalog_binding_mismatch} = review(f, nil, nil, nil, f.r.genuine.id)
      assert {:error, :catalog_binding_mismatch} = review(f, nil, nil, nil, id("nope"))
      assert_no_ledger(dir)
    end

    test "an op id that is not a replacement op", f do
      genuine = f.r.genuine.id
      {bytes, _} = package(f, f.r.claim, genuine, f.r.entries)
      assert {:error, :replacement_op_missing} = review(f, bytes, nil, nil, genuine)

      absent = id("absent-op")
      {bytes, _} = package(f, f.r.claim, absent, f.r.entries)
      assert {:error, :replacement_op_missing} = review(f, bytes, nil, nil, absent)
    end

    test "a claim differing from the op body in any one field", f do
      for change <- [
            %{nonce: id("other-nonce")},
            %{epoch: 2},
            %{new_origin: "wss://other-relay.invalid:8443"},
            %{generation: 1, cap: id("other-cap")}
          ] do
        claim = Map.merge(f.r.claim, change)
        {bytes, _} = package(f, claim, f.r.replacement.id, f.r.entries)
        assert {:error, :replacement_claim_mismatch} = review(f, bytes, nil, claim)
      end
    end

    test "a replacement op that Core refuses is not reviewable", f do
      r = f.r
      claim = %{r.claim | author: r.nominee.pub}

      op =
        CatalogReplacementVectors.replacement_op(
          r,
          claim,
          CatalogReplacementVectors.signed_args(r, claim),
          identity: r.nominee
        )

      log = Log.append!(r.before_replacement, op)
      histories = %{r.replica => log}
      {:ok, binding} = Binding.replacement(f.parent, claim, op.id)
      {:ok, catalog} = ReleaseCatalog.replacement_revision_zero(f.prior, binding)
      {:ok, bytes} = ReleaseCatalog.replacement_package(catalog, histories)

      assert {:error, :replacement_not_core_honored} = review(f, bytes, nil, claim, op.id)
    end

    test "a wrong carried inventory refuses at build time", f do
      [space] = f.prior.entries

      extra = %{
        space
        | replica: "replica:treehouse:thread:" <> id("extra"),
          kind: :thread,
          schema: :treehouse_thread_v1,
          reference: id("extra-ref"),
          route: "/r/" <> id("extra-route")
      }

      assert {:error, :catalog_inventory_mismatch} =
               ReleaseCatalog.replacement_revision_zero(
                 %{f.prior | entries: [space, extra]},
                 f.derived
               )

      # A claim committing a Thread that the prior catalog does not carry.
      claim = %{
        f.r.claim
        | inventory_digest:
            TransportCatalog.inventory_id([
              hd(f.r.entries),
              %{
                extra
                | service_id: f.derived.record.service_id,
                  service_key: f.derived.record.service_key
              }
            ])
      }

      {:ok, wider} = Binding.replacement(f.parent, claim, f.r.replacement.id)

      assert {:error, :catalog_inventory_mismatch} =
               ReleaseCatalog.replacement_revision_zero(f.prior, wider)
    end

    test "a catalog whose entries do not match the claim inventory", f do
      [space] = f.r.entries
      changed = %{space | route: "/r/" <> id("other-route")}
      {bytes, _} = package(f, f.r.claim, f.r.replacement.id, [changed])
      assert {:error, :catalog_inventory_mismatch} = review(f, bytes)
    end

    test "an entry keeping the old service id or key", f do
      old = f.parent.record

      for {field, value} <- [service_id: old.service_id, service_key: old.service_key] do
        entries = Enum.map(f.r.entries, &Map.put(&1, field, value))
        claim = %{f.r.claim | inventory_digest: TransportCatalog.inventory_id(entries)}
        {bytes, _} = package(f, claim, f.r.replacement.id, entries)
        assert {:error, :catalog_binding_mismatch} = review(f, bytes, nil, claim)
      end
    end

    test "revision or previous that does not belong to a replacement genesis", f do
      for change <- [%{revision: 1}, %{previous: id("prev")}, %{revision: 1, previous: id("p")}] do
        assert {:error, :invalid_catalog_package} =
                 CatalogSigningPackage.encode(
                   Map.merge(f.catalog, change),
                   f.histories,
                   nil,
                   "replacement"
                 )
      end
    end

    test "mode and binding must agree", f do
      # `pending` with a binding that is not the bootstrap.
      assert {:error, :invalid_catalog_package} =
               CatalogSigningPackage.encode(f.catalog, f.histories, f.r.bootstrap, "pending")

      assert {:error, :invalid_catalog_package} =
               CatalogSigningPackage.encode(
                 f.catalog,
                 f.histories,
                 f.r.bootstrap,
                 "initial_existing"
               )

      # `replacement` with binding == bootstrap.
      assert {:error, :invalid_catalog_package} =
               CatalogSigningPackage.encode(
                 %{f.catalog | binding: f.catalog.bootstrap},
                 f.histories,
                 nil,
                 "replacement"
               )

      # `replacement` never carries a staged reference; a bootstrap mode never lacks one.
      assert {:error, :invalid_catalog_package} =
               CatalogSigningPackage.encode(f.catalog, f.histories, f.r.bootstrap, "replacement")

      assert {:error, :invalid_catalog_package} =
               CatalogSigningPackage.encode(f.prior, f.histories, nil, "pending")

      # An altered mode in valid bytes is not a package.
      doc = JSON.decode!(f.bytes)
      forged = put_in(doc, ["reference", "mode"], "pending")

      assert {:error, :invalid_catalog_package} =
               forged |> PublicHistory.canonical() |> CatalogSigningPackage.decode()
    end

    test "signing with the old catalog key is refused and writes nothing", f do
      {:ok, package} = review(f)
      ceremony = dir!(f, "ceremony-oldkey")
      assert {:ok, _} = SigningLedger.init(ceremony, package.binding)
      signer = seed!(f, "old", f.r.catalog)

      assert {:error, :signer_key_mismatch} =
               SignCatalog.sign_reviewed(package, ceremony, signer, package.digest)

      assert {:ok, %{chain: [], committed: nil}} = SigningLedger.status(ceremony, package.binding)

      assert {:error, :catalog_confirmation_mismatch} =
               SignCatalog.sign_reviewed(package, ceremony, signer, "wrong")
    end

    test "a parent whose record's profile differs from the log", f do
      other = Lattice.Identity.from_seed("root", "r361-other-root")
      parent = %{f.parent | record: %{f.parent.record | space_root: other.pub}}
      assert {:error, :binding_profile_changed} = review(f, nil, parent)
    end

    test "a parent whose bootstrap the log does not honor", f do
      parent = %{f.parent | record: %{f.parent.record | nonce: id("other-nonce")}}
      assert {:error, :binding_not_found} = review(f, nil, parent)
    end

    test "review refusals create no ledger", f do
      ceremony = dir!(f, "ceremony-none")
      _ = review(f, nil, nil, nil, id("nope"))
      assert_no_ledger(ceremony)
    end
  end

  test "bootstrap package modes keep their closed wire shape", f do
    # A bootstrap mode still carries exactly {mode, frame} with an encoded op frame.
    ref = f.r.bootstrap
    doc = %{"mode" => "pending", "frame" => Wire.encode_op(ref)}
    assert Enum.sort(Map.keys(doc)) == ["frame", "mode"]

    # The replacement mode uses the same two keys with a nil frame.
    assert JSON.decode!(f.bytes)["reference"] == %{"mode" => "replacement", "frame" => nil}
    assert %Op{} = ref
  end
end
