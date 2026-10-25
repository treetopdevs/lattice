defmodule LatticeCarrierServer.Operator.ReleaseCatalogTest do
  use ExUnit.Case, async: false
  if :os.type() != {:unix, :linux}, do: @moduletag(skip: "Requires actual Linux operator owner")

  alias LatticeCarrierServer.Operator.{
    ActivationFixture,
    CatalogSigningPackage,
    CatalogStore,
    Fixture,
    InitialProvisioning,
    Journal,
    ReleaseCatalog,
    ReleaseReadiness,
    Staging
  }

  alias LatticeCarrierServer.Operator.CatalogCeremony.{SignCatalog, SigningLedger}

  setup context do
    LatticeCarrierServer.Operator.PublicationFixture.ready(context)
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

    assert LatticeCarrierServer.Operator.ReferenceMode.phase_allowed?(
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

  @tag initial: true
  test "a second catalog carries every entry and extends the independently signed chain", f do
    {first, package_path, envelope_path, first_envelope} = signed!(f)

    assert {:ok, first_record} =
             ReleaseCatalog.commit(
               f.root,
               f.ready,
               f.ceremony_dir,
               f.probe,
               package_path,
               envelope_path
             )

    {:ok, current} = Journal.read(f.root)
    {:ok, signed_status} = SigningLedger.status(f.ceremony_dir, f.binding)
    status_path = Path.join(f.root, "custodian-after-first.json")
    File.write!(status_path, SigningLedger.export_status(signed_status, f.binding))
    next = next_release!(f, current, first_record["catalog_head"], 2)

    {:ok, prepared} =
      ReleaseCatalog.prepare(next.root, next.ready, next.ceremony_dir, next.probe, status_path)

    assert prepared.catalog.revision == 1
    assert prepared.catalog.previous == first_record["catalog_head"]
    assert length(prepared.catalog.entries) == 3
    assert Enum.all?(first.catalog.entries, &(&1 in prepared.catalog.entries))
    {:ok, package} = CatalogSigningPackage.review(prepared.package, f.ceremony_dir)
    assert map_size(package.histories) == 3
    signer = LatticeCarrierServer.Operator.CeremonyFixture.signer_template().signer
    {:ok, envelope} = SignCatalog.sign(prepared.package, f.ceremony_dir, signer, package.digest)

    assert {:ok, ^first_envelope} =
             SignCatalog.sign(
               first.package,
               f.ceremony_dir,
               "/absent",
               CatalogSigningPackage.digest(first.catalog)
             )

    assert {:ok, after_replay} = SigningLedger.status(f.ceremony_dir, f.binding)
    assert after_replay.head["revision"] == 1
    assert length(after_replay.chain) == 2
    package_path = Path.join(f.root, "second-package.json")
    envelope_path = Path.join(f.root, "second-envelope.json")
    File.write!(package_path, prepared.package)
    File.write!(envelope_path, envelope)

    assert {:ok, second_record} =
             ReleaseCatalog.commit(
               next.root,
               next.ready,
               next.ceremony_dir,
               next.probe,
               package_path,
               envelope_path
             )

    assert {:ok, store} = CatalogStore.verify(f.root, f.binding.record.catalog_key)
    assert store.head == second_record["catalog_head"]
    assert store.head_revision == 1
    assert map_size(store.envelopes) == 2
  end

  @tag initial: true
  @tag timeout: 180_000
  test "the real publication flow permits thirteen entries and refuses the fourteenth", f do
    complete =
      Enum.reduce(1..12, f, fn number, previous ->
        {:ok, actual} = Journal.read(f.root)
        {:ok, previous_record} = Journal.decode(actual)

        next =
          if number == 1,
            do: previous,
            else: next_release!(previous, actual, previous_record["catalog_head"], number)

        {:ok, status} = SigningLedger.status(f.ceremony_dir, f.binding)
        status_path = Path.join(f.root, "capacity-status-#{number}.json")
        File.write!(status_path, SigningLedger.export_status(status, f.binding))

        assert {:ok, prepared} =
                 ReleaseCatalog.prepare(f.root, next.ready, f.ceremony_dir, f.probe, status_path)

        assert length(prepared.catalog.entries) == number + 1
        {:ok, package} = CatalogSigningPackage.review(prepared.package, f.ceremony_dir)
        signer = LatticeCarrierServer.Operator.CeremonyFixture.signer_template().signer

        {:ok, envelope} =
          SignCatalog.sign(prepared.package, f.ceremony_dir, signer, package.digest)

        package_path = Path.join(f.root, "capacity-package-#{number}.json")
        envelope_path = Path.join(f.root, "capacity-envelope-#{number}.json")
        File.write!(package_path, prepared.package)
        File.write!(envelope_path, envelope)

        assert {:ok, _} =
                 ReleaseCatalog.commit(
                   f.root,
                   next.ready,
                   f.ceremony_dir,
                   f.probe,
                   package_path,
                   envelope_path
                 )

        if package.mode == "pending" do
          # Fixture-only publication through the actual relay holder, so later
          # catalogs can observe all earlier references. This is not a listed receipt.
          realm = InitialProvisioning.client_realm(f.binding.record.space_root)

          assert {:ok, _} =
                   LatticeCarrierServer.Holder.relay(
                     LatticeCarrierServer.Holder.via("space"),
                     realm,
                     package.reference
                   )
        end

        next
      end)

    {:ok, actual} = Journal.read(f.root)
    {:ok, record} = Journal.decode(actual)
    next = next_release!(complete, actual, record["catalog_head"], 13)
    {:ok, status} = SigningLedger.status(f.ceremony_dir, f.binding)
    status_path = Path.join(f.root, "capacity-full-status.json")
    File.write!(status_path, SigningLedger.export_status(status, f.binding))

    assert {:error, :catalog_capacity} =
             ReleaseCatalog.prepare(f.root, next.ready, f.ceremony_dir, f.probe, status_path)

    assert {:ok, next.ready} == Journal.read(f.root)
    assert {:ok, store} = CatalogStore.verify(f.root, f.binding.record.catalog_key)
    assert map_size(store.envelopes) == 12
    assert store.head_revision == 11
  end

  test "relay command file adapter prepares and commits inside the existing guarded VM", f do
    cli = LatticeCarrierServer.Operator.CatalogCli
    expected_path = Path.join(f.root, "reviewed-ready-intent.json")
    package_path = Path.join(f.root, "cli-package.json")
    envelope_path = Path.join(f.root, "cli-envelope.json")
    request_path = Path.join(f.root, "catalog-command.json")
    File.write!(expected_path, f.ready)

    base = [
      "--root",
      f.root,
      "--expected",
      expected_path,
      "--ceremony",
      f.ceremony_dir,
      "--probe",
      f.probe
    ]

    prepare = ["prepare", "--status", f.status_path, "--out", package_path] ++ base

    File.write!(
      request_path,
      Jason.encode!(%{format: "treehouse-catalog-command-v1", args: prepare})
    )

    out = ExUnit.CaptureIO.capture_io(fn -> assert :ok = cli.run_file(request_path) end)
    response = Jason.decode!(out)
    assert response["package"] == package_path
    {:ok, package} = CatalogSigningPackage.review(File.read!(package_path), f.ceremony_dir)
    assert response["review"]["confirm_catalog"] == package.digest
    signer = LatticeCarrierServer.Operator.CeremonyFixture.signer_template().signer

    {:ok, envelope} =
      SignCatalog.sign(File.read!(package_path), f.ceremony_dir, signer, package.digest)

    File.write!(envelope_path, envelope)
    commit = ["commit", "--package", package_path, "--envelope", envelope_path] ++ base

    File.write!(
      request_path,
      Jason.encode!(%{format: "treehouse-catalog-command-v1", args: commit})
    )

    out = ExUnit.CaptureIO.capture_io(fn -> assert :ok = cli.run_file(request_path) end)
    assert Jason.decode!(out)["phase"] == "catalogued"
    assert LatticeCarrierServer.Runtime.deployment().operator_root == f.root

    ExUnit.CaptureIO.capture_io(:stderr, fn ->
      assert {:error, :invalid_catalog_options} = cli.run(prepare ++ ["--signer", "do-not-echo"])
      File.write!(request_path, ~s({"format":"treehouse-catalog-command-v1","args":[],"args":[]}))
      assert {:error, :invalid_catalog_command} = cli.run_file(request_path)
    end)
  end

  test "restaging cannot conceal a signed but unpublished catalog revision", f do
    {_prepared, _package_path, _envelope_path, _envelope} = signed!(f)
    {:ok, status} = SigningLedger.status(f.ceremony_dir, f.binding)
    path = Path.join(f.root, "pending-signature-status.json")
    File.write!(path, SigningLedger.export_status(status, f.binding))
    request = %{f.request | manifest_digest: Journal.digest(File.read!(f.manifest))}

    assert {:error, :custodian_status_required} =
             Staging.prepare(f.root, f.ready, request, f.artifacts, f.ceremony_dir)

    assert {:error, :catalog_signature_pending} =
             Staging.prepare(f.root, f.ready, request, f.artifacts, f.ceremony_dir, path)

    assert {:ok, f.ready} == Journal.read(f.root)
    refute File.exists?(CatalogStore.path(f.root))
  end

  test "actual owner death after catalog link recovers through guarded commit", f do
    owner_crash!(f, "link")
  end

  test "actual owner death after journal replacement returns the existing receipt", f do
    owner_crash!(f, "journal")
  end

  defp owner_crash!(f, stage) do
    {prepared, package_path, envelope_path, envelope} = signed!(f)
    {:ok, ready_record} = Journal.decode(f.ready)
    sha = Journal.digest(envelope)
    id = Treehouse.TransportCatalog.catalog_id(prepared.catalog)

    artifact = %{
      "kind" => "catalog",
      "op_id" => id,
      "path" => CatalogStore.file_path(f.root, sha),
      "replica" => prepared.catalog.space,
      "review" => nil,
      "sha256" => sha
    }

    record =
      ready_record
      |> Map.put("phase", "catalogued")
      |> Map.put("catalog_head", id)
      |> Map.update!("artifacts", &(&1 ++ [artifact]))

    deployment = LatticeCarrierServer.Runtime.deployment()

    plan = %{
      version: 1,
      kind: "catalogued",
      expected: f.ready,
      record: Journal.encode(record),
      attempt: ready_record["attempt"],
      checks: [
        %{
          path: deployment.manifest_path,
          sha256: Base.encode16(deployment.manifest_digest, case: :lower)
        }
      ],
      artifacts: [%{sha256: sha, bytes: Base.encode64(envelope)}],
      incarnation: deployment.incarnation
    }

    helper = Path.expand("../../../../scripts/treehouse_operator_mutation.py", __DIR__)
    runner = Path.expand("../support/operator/catalog_mutation_fault_runner.py", __DIR__)

    {output, status} =
      System.cmd(
        System.find_executable("python3"),
        [runner, helper, f.root, stage, Jason.encode!(plan)],
        stderr_to_stdout: true
      )

    assert status != 0
    refute String.contains?(output, ~s("ok":true))
    assert File.exists?(CatalogStore.file_path(f.root, sha)), output

    assert {:ok, ^record} =
             ReleaseCatalog.commit(
               f.root,
               f.ready,
               f.ceremony_dir,
               f.probe,
               package_path,
               envelope_path
             )

    {:ok, after_retry} = Journal.read(f.root)
    history = File.read!(Journal.history_path(f.root))

    assert {:ok, ^record} =
             ReleaseCatalog.commit(
               f.root,
               f.ready,
               f.ceremony_dir,
               f.probe,
               package_path,
               envelope_path
             )

    assert {:ok, ^after_retry} = Journal.read(f.root)
    assert File.read!(Journal.history_path(f.root)) == history

    assert {:ok, %{head: ^id, pending: nil}} =
             CatalogStore.verify(f.root, f.binding.record.catalog_key)
  end

  test "an unpublished carried reference refuses until the exact frame is served", f do
    {_prepared, package_path, envelope_path, _} = signed!(f)

    assert {:ok, record} =
             ReleaseCatalog.commit(
               f.root,
               f.ready,
               f.ceremony_dir,
               f.probe,
               package_path,
               envelope_path
             )

    {:ok, actual} = Journal.read(f.root)
    # No courier or fixture relay publishes the first reference in this test.
    next = next_release!(f, actual, record["catalog_head"], 2)
    {:ok, status} = SigningLedger.status(f.ceremony_dir, f.binding)
    path = Path.join(f.root, "status-with-unlisted-reference.json")
    File.write!(path, SigningLedger.export_status(status, f.binding))

    assert {:error, :catalog_reference_pending} =
             ReleaseCatalog.prepare(f.root, next.ready, f.ceremony_dir, f.probe, path)

    assert {:ok, next.ready} == Journal.read(f.root)
    assert {:ok, store} = CatalogStore.verify(f.root, f.binding.record.catalog_key)
    assert store.head == record["catalog_head"]
    assert map_size(store.envelopes) == 1

    assert {:ok, _} =
             LatticeCarrierServer.Holder.relay(
               LatticeCarrierServer.Holder.via("space"),
               "member",
               f.reference
             )

    assert {:ok, prepared} =
             ReleaseCatalog.prepare(f.root, next.ready, f.ceremony_dir, f.probe, path)

    assert prepared.catalog.previous == record["catalog_head"]
    assert length(prepared.catalog.entries) == 3
  end

  defp next_release!(f, expected, head, number) do
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
