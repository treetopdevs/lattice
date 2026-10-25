defmodule LatticeCarrierServer.Operator.PublicationFixture do
  @moduledoc false
  import ExUnit.Assertions
  import ExUnit.Callbacks

  alias LatticeCarrierServer.Operator.{
    ActivationFixture,
    CatalogBinding,
    CatalogSigningPackage,
    CeremonyFixture,
    Fixture,
    InitialBundle,
    InitialProvisioning,
    Journal,
    ReleaseCatalog,
    ReleaseReadiness,
    Staging
  }

  alias LatticeCarrierServer.Operator.CatalogCeremony.SignCatalog

  def ready(context) do
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
    status_path = Path.join(f.root, "custodian-status.json")
    # The first status is created from the custodian's own verified Space log,
    # before any signing package exists: no bootstrap cycle is possible.
    ExUnit.CaptureIO.capture_io(fn ->
      assert :ok =
               LatticeCarrierServer.Operator.CatalogCeremony.Cli.run([
                 "init-ledger",
                 "--ceremony",
                 f.ceremony_dir,
                 "--space-log",
                 f.active_log,
                 "--out",
                 status_path
               ])
    end)

    {:ok, Map.merge(f, %{ready: ready, binding: binding, status_path: status_path})}
  end

  def catalogued(context) do
    {:ok, f} = ready(context)

    {:ok, prepared} =
      ReleaseCatalog.prepare(f.root, f.ready, f.ceremony_dir, f.probe, f.status_path)

    {:ok, package} = CatalogSigningPackage.review(prepared.package, f.ceremony_dir)

    {:ok, envelope} =
      SignCatalog.sign(
        prepared.package,
        f.ceremony_dir,
        CeremonyFixture.signer_template().signer,
        package.digest
      )

    package_path = Path.join(f.root, "listing-package.json")
    envelope_path = Path.join(f.root, "listing-envelope.json")
    File.write!(package_path, prepared.package)
    File.write!(envelope_path, envelope)

    {:ok, _} =
      ReleaseCatalog.commit(f.root, f.ready, f.ceremony_dir, f.probe, package_path, envelope_path)

    {:ok, catalogued} = Journal.read(f.root)
    {:ok, Map.merge(f, %{catalogued: catalogued, catalog: prepared.catalog, envelope: envelope})}
  end
end
