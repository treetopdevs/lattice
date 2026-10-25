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

  alias LatticeCarrierServer.Operator.CatalogCeremony.{SignCatalog, SigningLedger}

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

    {:ok, data} =
      Fixture.new(
        second_member: context[:initial] == true,
        listener_ports: context[:listener_ports] || [0, 0]
      )

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

    f = if context[:relative_manifest], do: relative_manifest(f), else: f
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

  defp relative_manifest(f) do
    depth =
      max(length(Path.split(f.root)), length(Path.split(f.request.active_manifest))) + 8

    prefix = String.duplicate("../", depth)

    artifacts = Enum.map(f.artifacts, &relative_artifact(&1, prefix))

    Map.merge(f, %{artifacts: artifacts, relative_manifest_depth: depth})
  end

  defp relative_artifact(%{kind: :manifest} = artifact, prefix) do
    manifest =
      artifact.bytes
      |> Jason.decode!()
      |> Map.update!(
        "instances",
        &Enum.map(&1, fn instance -> relative_instance(instance, prefix) end)
      )

    %{artifact | bytes: Jason.encode!(manifest)}
  end

  defp relative_artifact(artifact, _prefix), do: artifact

  defp relative_instance(instance, prefix) do
    Enum.reduce(~w(log_file identity_file), instance, fn key, fields ->
      Map.update!(fields, key, &(prefix <> String.trim_leading(&1, "/")))
    end)
  end

  def catalogued(context) do
    {:ok, f} = ready(context)
    catalogued_ready(f)
  end

  def catalogued_ready(f) do
    {:ok, status} = SigningLedger.status(f.ceremony_dir, f.binding)
    status_path = Path.join(f.root, "listing-status-#{System.unique_integer([:positive])}.json")
    File.write!(status_path, SigningLedger.export_status(status, f.binding))
    f = %{f | status_path: status_path}

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

    package_path = Path.join(f.root, "listing-package-#{prepared.catalog.revision}.json")
    envelope_path = Path.join(f.root, "listing-envelope-#{prepared.catalog.revision}.json")
    File.write!(package_path, prepared.package)
    File.write!(envelope_path, envelope)

    {:ok, _} =
      ReleaseCatalog.commit(f.root, f.ready, f.ceremony_dir, f.probe, package_path, envelope_path)

    {:ok, catalogued} = Journal.read(f.root)
    {:ok, record} = Journal.decode(catalogued)
    reference = Enum.find(record["artifacts"], &(&1["kind"] == "reference"))

    {:ok, op} =
      reference["path"] |> File.read!() |> Jason.decode!() |> Lattice.Carrier.Wire.decode_op()

    {:ok,
     Map.merge(f, %{
       catalogued: catalogued,
       catalog: prepared.catalog,
       envelope: envelope,
       reference: op
     })}
  end

  def next_ready(f, expected, head, number) do
    tag = "catalog-child-#{number}"
    {:ok, %{log: space_log}} = Lattice.Log.restore_verified(f.active_log)

    {:ok, donor_data} =
      Fixture.new(second_member: length(Staging.roster(space_log)) == 2, child_tag: tag)

    donor = Map.new(donor_data)
    child_artifact = Enum.find(donor.artifacts, &(&1.kind == :log))
    sim = %{f.space | logs: Map.put(f.space.logs, "creator", space_log)}

    {_sim, reference} =
      Lattice.Sim.command(sim, "creator", :create_thread, [donor.child.replica, "Branch"])

    attempt = LatticeCarrierServer.Operator.CeremonyFixture.id("catalog-attempt-#{number}")
    child_path = Staging.artifact_path(f.root, attempt, Journal.digest(child_artifact.bytes))
    manifest = Jason.decode!(File.read!(f.manifest))
    template = Enum.find(manifest["instances"], &(&1["name"] == "thread"))

    root_key = Lattice.Sim.identity(donor.child, "creator").pub

    peers =
      [Base.encode64(root_key) | Staging.roster(space_log)]
      |> Enum.uniq()
      |> Enum.sort()
      |> Enum.map(fn key ->
        %{"pubkey" => key, "realm" => InitialProvisioning.client_realm(Base.decode64!(key))}
      end)

    instance =
      template
      |> Map.put("name", "thread-#{number}")
      |> Map.put("log_file", child_path)
      |> Map.put("route", "/r/" <> LatticeCarrierServer.Operator.CeremonyFixture.id(tag))
      |> Map.put("trusted_peers", peers)
      |> Map.put("relay_realms", Enum.map(peers, & &1["realm"]))

    manifest = Map.update!(manifest, "instances", &(&1 ++ [instance]))

    artifacts = [
      child_artifact,
      %{
        kind: :reference,
        bytes: Jason.encode!(Lattice.Carrier.Wire.encode_op(reference)),
        replica: space_log.replica,
        op_id: reference.id,
        review: nil
      },
      %{kind: :manifest, bytes: Jason.encode!(manifest), replica: nil, op_id: nil, review: nil}
    ]

    request = %{
      active_manifest: f.manifest,
      attempt: attempt,
      generation: number,
      catalog_head: head,
      manifest_digest: Journal.digest(File.read!(f.manifest))
    }

    {:ok, status} = SigningLedger.status(f.ceremony_dir, f.binding)
    status_path = Path.join(f.root, "restaging-status-#{number}.json")
    File.write!(status_path, SigningLedger.export_status(status, f.binding))

    assert {:ok, _} =
             Staging.prepare(f.root, expected, request, artifacts, f.ceremony_dir, status_path)

    {:ok, pending} = Journal.read(f.root)
    next = Map.merge(f, %{journal: pending, request: request, artifacts: artifacts})
    activated = ActivationFixture.activated!(next)
    ActivationFixture.restart!()
    assert {:ok, _} = ReleaseReadiness.confirm(f.root, activated, f.probe, f.ceremony_dir)
    {:ok, ready} = Journal.read(f.root)
    Map.put(next, :ready, ready)
  end
end
