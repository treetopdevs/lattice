defmodule LatticeCarrierServer.Operator.ReleaseCatalogTest do
  use ExUnit.Case, async: false
  if :os.type() != {:unix, :linux}, do: @moduletag(skip: "Requires actual Linux operator owner")

  alias LatticeCarrierServer.Operator.{
    ActivationFixture,
    CatalogBinding,
    CatalogSigningPackage,
    CatalogStore,
    Fixture,
    InitialBundle,
    InitialProvisioning,
    Journal,
    ReleaseCatalog,
    ReleaseReadiness,
    Staging
  }

  alias LatticeCarrierServer.Operator.CatalogCeremony.{SignCatalog, SigningLedger}

  setup context do
    previous = Application.get_env(:lattice_carrier_server, :manifest)
    Application.stop(:lattice_carrier_server)

    on_exit(fn ->
      Application.stop(:lattice_carrier_server)
      Application.delete_env(:lattice_carrier_server, :operator_root)

      if previous,
        do: Application.put_env(:lattice_carrier_server, :manifest, previous),
        else: Application.delete_env(:lattice_carrier_server, :manifest)

      Application.ensure_all_started(:lattice_carrier_server)
    end)

    {:ok, data} = Fixture.new(second_member: context[:initial] == true)
    f = Map.new(data)

    f =
      if context[:initial] do
        child = Lattice.Sim.log(f.child, "creator")
        {:ok, %{bootstraps: [bootstrap]}} = Treehouse.CatalogBootstrap.observe(f.updated_log)
        input = Path.join(f.root, "initial-public-bundle.json")

        File.write!(
          input,
          InitialBundle.encode(f.updated_log, child, bootstrap.id, f.reference.id)
        )

        output = Path.expand(".catalog-initial-#{System.unique_integer([:positive])}")
        on_exit(fn -> File.rm_rf!(output) end)

        {:ok, imported} =
          InitialProvisioning.prepare(
            bundle: input,
            ceremony: f.ceremony_dir,
            output: output,
            operator_root: f.root,
            identity_file: f.service_identity
          )

        Map.merge(f, %{
          request: imported.request,
          artifacts: imported.artifacts,
          active_log: Path.join(output, "space.log")
        })
      else
        f
      end

    {:ok, _} = Staging.prepare(f.root, nil, f.request, f.artifacts, f.ceremony_dir)
    {:ok, journal} = Journal.read(f.root)
    probe = Path.join(f.root, "publication-probe.identity")
    File.write!(probe, Base.encode16(:crypto.hash(:sha256, "publication-probe"), case: :lower))
    File.chmod!(probe, 0o600)
    f = Map.merge(f, %{journal: journal, manifest: f.request.active_manifest, probe: probe})
    activated = ActivationFixture.activated!(f)
    ActivationFixture.restart!()
    {:ok, _} = ReleaseReadiness.confirm(f.root, activated, probe, f.ceremony_dir)
    {:ok, ready} = Journal.read(f.root)
    {:ok, binding} = CatalogBinding.load(f.ceremony_dir, f.active_log)
    {:ok, genesis} = SigningLedger.init(f.ceremony_dir, binding)
    status_path = Path.join(f.root, "custodian-status.json")
    File.write!(status_path, SigningLedger.export_status(genesis, binding))
    {:ok, Map.merge(f, %{ready: ready, binding: binding, status_path: status_path})}
  end

  test "prepare probes and derives a complete first catalog without publication", f do
    history = File.read!(Journal.history_path(f.root))

    assert {:ok, prepared} =
             ReleaseCatalog.prepare(f.root, f.ready, f.ceremony_dir, f.probe, f.status_path)

    assert prepared.catalog.revision == 0
    assert prepared.catalog.previous == nil
    assert length(prepared.catalog.entries) == 2
    assert {:ok, package} = CatalogSigningPackage.review(prepared.package, f.ceremony_dir)
    assert package.mode == "pending"
    assert {:ok, f.ready} == Journal.read(f.root)
    assert File.read!(Journal.history_path(f.root)) == history

    assert {:ok, %{head: nil, pending: nil}} =
             CatalogStore.verify(f.root, f.binding.record.catalog_key)
  end

  test "independently signed package commits once and retries after the lost reply", f do
    {:ok, prepared} =
      ReleaseCatalog.prepare(f.root, f.ready, f.ceremony_dir, f.probe, f.status_path)

    {:ok, package} = CatalogSigningPackage.review(prepared.package, f.ceremony_dir)
    signer = LatticeCarrierServer.Operator.CeremonyFixture.signer_template().signer
    {:ok, envelope} = SignCatalog.sign(prepared.package, f.ceremony_dir, signer, package.digest)
    package_path = Path.join(f.root, "catalog-package.json")
    envelope_path = Path.join(f.root, "catalog-envelope.json")
    File.write!(package_path, prepared.package)
    File.write!(envelope_path, envelope)

    assert {:ok, catalogued} =
             ReleaseCatalog.commit(
               f.root,
               f.ready,
               f.ceremony_dir,
               f.probe,
               package_path,
               envelope_path
             )

    assert catalogued["phase"] == "catalogued"
    {:ok, current} = Journal.read(f.root)
    history = File.read!(Journal.history_path(f.root))

    assert {:ok, ^catalogued} =
             ReleaseCatalog.commit(
               f.root,
               f.ready,
               f.ceremony_dir,
               f.probe,
               package_path,
               envelope_path
             )

    assert {:ok, ^current} = Journal.read(f.root)
    assert File.read!(Journal.history_path(f.root)) == history
    ActivationFixture.restart!()
    assert {:ok, %{head: head}} = CatalogStore.verify(f.root, f.binding.record.catalog_key)
    assert head == catalogued["catalog_head"]
    assert {:ok, ^current} = Journal.read(f.root)
  end

  @tag initial: true
  test "initial catalog publication preserves the already-honored Space reference", f do
    before = File.read!(f.active_log)
    stat = File.stat!(f.active_log, time: :posix)

    {:ok, prepared} =
      ReleaseCatalog.prepare(f.root, f.ready, f.ceremony_dir, f.probe, f.status_path)

    {:ok, package} = CatalogSigningPackage.review(prepared.package, f.ceremony_dir)
    assert package.mode == "initial_existing"
    signer = LatticeCarrierServer.Operator.CeremonyFixture.signer_template().signer
    {:ok, envelope} = SignCatalog.sign(prepared.package, f.ceremony_dir, signer, package.digest)
    package_path = Path.join(f.root, "initial-catalog-package.json")
    envelope_path = Path.join(f.root, "initial-catalog-envelope.json")
    File.write!(package_path, prepared.package)
    File.write!(envelope_path, envelope)

    assert {:ok, record} =
             ReleaseCatalog.commit(
               f.root,
               f.ready,
               f.ceremony_dir,
               f.probe,
               package_path,
               envelope_path
             )

    assert record["phase"] == "catalogued"
    assert File.read!(f.active_log) == before
    assert File.stat!(f.active_log, time: :posix) == stat

    assert {:ok, ^record} =
             ReleaseCatalog.commit(
               f.root,
               f.ready,
               f.ceremony_dir,
               f.probe,
               package_path,
               envelope_path
             )

    ActivationFixture.restart!()
    assert {:ok, raw} = Journal.read(f.root)
    assert Journal.decode(raw) == {:ok, record}
    assert File.read!(f.active_log) == before

    refute LatticeCarrierServer.Operator.ReferenceMode.phase_allowed?(
             "listed",
             record["artifacts"]
           )
  end

  test "interrupted catalog link publication resumes through the real owner", f do
    {prepared, package_path, envelope_path, envelope} = signed!(f)
    sha = Journal.digest(envelope)
    dir = CatalogStore.path(f.root)
    File.mkdir!(dir)
    File.chmod!(dir, 0o700)
    final = CatalogStore.file_path(f.root, sha)
    File.write!(final, envelope)
    File.chmod!(final, 0o600)
    File.ln!(final, Path.join(dir, ".tmp." <> String.duplicate("a", 32)))

    assert {:ok, %{head: nil, pending: %{sha256: ^sha}}} =
             CatalogStore.verify(f.root, f.binding.record.catalog_key)

    assert {:ok, replay} =
             ReleaseCatalog.prepare(f.root, f.ready, f.ceremony_dir, f.probe, f.status_path)

    assert replay.catalog == prepared.catalog

    assert {:ok, record} =
             ReleaseCatalog.commit(
               f.root,
               f.ready,
               f.ceremony_dir,
               f.probe,
               package_path,
               envelope_path
             )

    assert record["phase"] == "catalogued"

    assert {:ok, %{head: head, pending: nil}} =
             CatalogStore.verify(f.root, f.binding.record.catalog_key)

    assert head == record["catalog_head"]
  end

  test "wrong signature and stale expected bytes refuse before journal or store mutation", f do
    {_prepared, package_path, envelope_path, envelope} = signed!(f)
    {:ok, decoded} = Treehouse.TransportCatalog.decode_catalog_json(envelope)
    bad = %{decoded | signature: <<0::512>>}

    File.write!(
      envelope_path,
      LatticeCarrierServer.Operator.PublicHistory.canonical(
        Lattice.Carrier.Wire.encode_value(bad)
      )
    )

    assert {:error, :invalid_catalog_signature} =
             ReleaseCatalog.commit(
               f.root,
               f.ready,
               f.ceremony_dir,
               f.probe,
               package_path,
               envelope_path
             )

    assert {:ok, f.ready} == Journal.read(f.root)
    refute File.exists?(CatalogStore.path(f.root))

    assert {:error, :stale_operator_intent} =
             ReleaseCatalog.prepare(
               f.root,
               f.ready <> " ",
               f.ceremony_dir,
               f.probe,
               f.status_path
             )
  end

  test "roster drift after signing is refused by commit's fresh observation", f do
    {_prepared, package_path, envelope_path, _envelope} = signed!(f)
    late = Lattice.Identity.from_seed("late", "publication-late-member")
    pub = Base.encode64(late.pub)
    {space, invitation} = Lattice.Sim.command(f.space, "creator", :issue_invitation, [pub, []])
    acceptance = Treehouse.Invitation.accept(late, space.replica, invitation)

    {_space, admission} =
      Lattice.Sim.command(space, "creator", :admit_member, [
        invitation.id,
        pub,
        "member",
        acceptance
      ])

    assert {:ok, _} =
             LatticeCarrierServer.Holder.relay(
               LatticeCarrierServer.Holder.via("space"),
               "member",
               invitation
             )

    assert {:ok, _} =
             LatticeCarrierServer.Holder.relay(
               LatticeCarrierServer.Holder.via("space"),
               "member",
               admission
             )

    assert {:error, :roster_drift_since_ready} =
             ReleaseCatalog.commit(
               f.root,
               f.ready,
               f.ceremony_dir,
               f.probe,
               package_path,
               envelope_path
             )

    assert {:ok, f.ready} == Journal.read(f.root)
    refute File.exists?(CatalogStore.path(f.root))
  end

  defp signed!(f) do
    {:ok, prepared} =
      ReleaseCatalog.prepare(f.root, f.ready, f.ceremony_dir, f.probe, f.status_path)

    {:ok, package} = CatalogSigningPackage.review(prepared.package, f.ceremony_dir)
    signer = LatticeCarrierServer.Operator.CeremonyFixture.signer_template().signer
    {:ok, envelope} = SignCatalog.sign(prepared.package, f.ceremony_dir, signer, package.digest)
    package_path = Path.join(f.root, "candidate-package.json")
    envelope_path = Path.join(f.root, "candidate-envelope.json")
    File.write!(package_path, prepared.package)
    File.write!(envelope_path, envelope)
    {prepared, package_path, envelope_path, envelope}
  end
end
