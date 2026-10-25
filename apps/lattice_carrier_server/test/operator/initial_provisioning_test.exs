defmodule LatticeCarrierServer.Operator.InitialProvisioningTest do
  use ExUnit.Case, async: false
  if :os.type() != {:unix, :linux}, do: @moduletag(skip: "Requires Linux durable directory sync")
  alias Lattice.Sim

  alias LatticeCarrierServer.Operator.{
    Fixture,
    InitialBundle,
    InitialProvisioning,
    Journal,
    Staging
  }

  setup do
    {:ok, f} = Fixture.new(second_member: true)
    child = Sim.log(f[:child], "creator")
    {:ok, %{bootstraps: [bootstrap]}} = Treehouse.CatalogBootstrap.observe(f[:updated_log])
    bytes = InitialBundle.encode(f[:updated_log], child, bootstrap.id, f[:reference].id)
    input = Path.join(f[:root], "public-bundle.json")
    File.write!(input, bytes)
    output = Path.expand(".initial-import-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf!(output) end)

    opts = [
      bundle: input,
      ceremony: f[:ceremony_dir],
      output: output,
      operator_root: f[:root],
      identity_file: f[:service_identity]
    ]

    {:ok, fixture: Map.new(f), opts: opts, output: output}
  end

  test "verified import retries exactly and feeds the real guarded staging API", f do
    assert {:ok, imported} = InitialProvisioning.prepare(f.opts)
    before = snapshot(f.output)
    assert {:ok, ^imported} = InitialProvisioning.prepare(f.opts)
    assert snapshot(f.output) == before
    assert {:ok, nil} = Journal.read(f.fixture.root)
    assert File.read!(f.fixture.active_log) == f.fixture.active_bytes

    assert {:ok, record} =
             Staging.prepare(
               f.fixture.root,
               nil,
               imported.request,
               imported.artifacts,
               f.fixture.ceremony_dir
             )

    assert record["phase"] == "carrier_pending"
    assert snapshot(f.output) == before
    assert File.read!(f.fixture.active_log) == f.fixture.active_bytes
  end

  test "staging inputs reload after live Space growth and reject immutable tampering", f do
    assert {:ok, imported} = InitialProvisioning.prepare(f.opts)
    assert {:ok, reloaded} = InitialProvisioning.load_staging(f.output, f.fixture.ceremony_dir)
    assert reloaded.request == imported.request
    assert reloaded.artifacts == imported.artifacts

    path = Path.join(f.output, "space.log")
    assert {:ok, %{log: space}} = Lattice.Log.restore_verified(path)
    stranger = Lattice.Identity.from_seed("noise", "reload-noise")

    noise =
      Lattice.Op.new(
        stranger,
        space.replica,
        Lattice.Log.frontier(space),
        :command,
        {:post, ["noise"]}
      )

    assert {:ok, changed} = Lattice.Log.accept(space, noise)
    assert Map.has_key?(Lattice.Authority.analyze(Treehouse.Space, changed).reasons, noise.id)
    assert :ok = Lattice.Log.dump(changed, path)
    before = snapshot(f.output)
    assert {:ok, ^reloaded} = InitialProvisioning.load_staging(f.output, f.fixture.ceremony_dir)
    assert snapshot(f.output) == before
    assert {:error, _} = InitialProvisioning.prepare(f.opts)

    File.write!(Path.join(f.output, "review.json"), "tampered")
    before = snapshot(f.output)

    assert {:error, :invalid_staging_inputs} =
             InitialProvisioning.load_staging(f.output, f.fixture.ceremony_dir)

    assert snapshot(f.output) == before
  end

  test "missing completion marker preserves partial output and refuses retry", f do
    assert {:ok, imported} = InitialProvisioning.prepare(f.opts)
    File.rm!(imported.index)
    File.rm!(imported.active_manifest)
    assert {:error, _} = LatticeCarrierServer.Manifest.load(imported.active_manifest)

    assert {:error, _} =
             LatticeCarrierServer.Manifest.load(Path.join(f.output, "initial.manifest.data"))

    before = snapshot(f.output)
    assert {:error, :initial_provisioning_refused} = InitialProvisioning.prepare(f.opts)
    assert snapshot(f.output) == before
    refute File.exists?(imported.index)
    assert {:ok, nil} = Journal.read(f.fixture.root)
  end

  test "conflicting completed output is preserved rather than repaired", f do
    assert {:ok, _} = InitialProvisioning.prepare(f.opts)
    review = Path.join(f.output, "review.json")
    File.write!(review, "conflicting user bytes")
    before = snapshot(f.output)
    assert {:error, :initial_provisioning_refused} = InitialProvisioning.prepare(f.opts)
    assert snapshot(f.output) == before
  end

  test "a symlink output and a wrong service identity refuse without overwriting", f do
    target = f.output <> "-target"
    File.mkdir!(target)
    File.chmod!(target, 0o700)
    on_exit(fn -> File.rm_rf!(target) end)
    File.ln_s!(target, f.output)
    assert {:error, :initial_provisioning_refused} = InitialProvisioning.prepare(f.opts)
    assert File.ls!(target) == []
    File.rm!(f.output)

    File.write!(
      f.fixture.service_identity,
      Base.encode16(:crypto.hash(:sha256, "different-service"))
    )

    assert {:error, :initial_provisioning_refused} = InitialProvisioning.prepare(f.opts)
    refute File.exists?(f.output)
    assert {:ok, nil} = Journal.read(f.fixture.root)
  end

  test "an extra output entry and a hard-linked file make retry ambiguous", f do
    assert {:ok, _} = InitialProvisioning.prepare(f.opts)
    extra = Path.join(f.output, "unexpected")
    File.write!(extra, "keep")
    assert {:error, :initial_provisioning_refused} = InitialProvisioning.prepare(f.opts)
    assert File.read!(extra) == "keep"
    File.rm!(extra)
    alias_path = f.output <> "-alias"
    on_exit(fn -> File.rm(alias_path) end)
    File.ln!(Path.join(f.output, "reference.json"), alias_path)
    assert {:error, :initial_provisioning_refused} = InitialProvisioning.prepare(f.opts)
    assert File.exists?(alias_path)
  end

  test "ordinary workflow signed frames pass ceremony, import, controlled boot and staging", f do
    shell = Path.expand("../../../../clients/treehouse-tauri-shell", __DIR__)

    port =
      Port.open(
        {:spawn_executable, String.to_charlist(Path.join(shell, "node_modules/.bin/tsx"))},
        [
          :binary,
          :exit_status,
          :stderr_to_stdout,
          {:line, 2_097_152},
          {:cd, String.to_charlist(shell)},
          {:args, ["test/support/initial_provisioning_workflow.ts"]}
        ]
      )

    on_exit(fn -> if Port.info(port), do: Port.close(port) end)

    ceremony =
      LatticeCarrierServer.Operator.CeremonyFixture.copy_ceremony(
        Path.join(f.fixture.root, "ordinary-ceremony")
      )

    pre = phase(port, "space")
    pre_path = Path.join(f.fixture.root, "ordinary-pre.json")
    File.write!(pre_path, pre["exported"])

    assert {:ok, payload} =
             LatticeCarrierServer.Operator.CatalogCeremony.binding_payload(
               ceremony: ceremony,
               space_log: pre_path,
               service_public_key: Base.encode64(f.fixture.service_pub),
               service_id: LatticeCarrierServer.Operator.CeremonyFixture.id("ordinary-service"),
               origin: LatticeCarrierServer.Operator.CeremonyFixture.origin()
             )

    true = Port.command(port, Jason.encode!(payload) <> "\n")
    bound = phase(port, "bound")
    bound_path = Path.join(f.fixture.root, "ordinary-bound.json")
    File.write!(bound_path, bound["exported"])

    assert {:ok, _} =
             LatticeCarrierServer.Operator.CatalogCeremony.verify_binding(
               ceremony: ceremony,
               space_log: bound_path
             )

    assert {:ok, _} = LatticeCarrierServer.Operator.CeremonyFixture.report(ceremony)
    true = Port.command(port, "\"verified\"\n")
    completed = phase(port, "bundle")
    assert_receive {^port, {:exit_status, 0}}, 30_000
    public = Path.join(f.fixture.root, "ordinary-final.json")
    File.write!(public, completed["bytes"])
    opts = Keyword.merge(f.opts, bundle: public, ceremony: ceremony)
    assert {:ok, imported} = InitialProvisioning.prepare(opts)

    boot_import!(f.fixture.root, imported)
    assert LatticeCarrierServer.Runtime.deployment().operator_root == f.fixture.root
    assert LatticeCarrierServer.Health.ready?()

    assert {:ok, record} =
             Staging.prepare(f.fixture.root, nil, imported.request, imported.artifacts, ceremony)

    assert record["phase"] == "carrier_pending"
    activated = activate_import!(f.fixture.root, imported, ceremony)
    assert {:ok, resumed} = InitialProvisioning.load_staging(f.output, ceremony)
    assert resumed.request == imported.request
    assert resumed.artifacts == imported.artifacts
    assert :ok = Application.stop(:lattice_carrier_server)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
    probe = probe!(f.fixture.root)

    assert {:ok, ready} =
             LatticeCarrierServer.Operator.ReleaseReadiness.confirm(
               f.fixture.root,
               activated,
               probe,
               ceremony
             )

    assert ready["phase"] == "ready"
  end

  test "operator command imports with public output and never starts a deployment", f do
    args =
      ["treehouse.initial_provisioning"] ++
        Enum.flat_map(Keyword.merge(f.opts, space_port: 4101, thread_port: 4102), fn {key, value} ->
          ["--" <> (key |> Atom.to_string() |> String.replace("_", "-")), to_string(value)]
        end)

    {output, status} =
      System.cmd(System.find_executable("mix"), args,
        stderr_to_stdout: true,
        env: [{"MIX_ENV", Atom.to_string(Mix.env())}]
      )

    assert status == 0, output <> "\noutput inventory: " <> inspect(File.ls(f.output))
    result = output |> String.trim() |> String.split("\n") |> List.last() |> Jason.decode!()
    assert result["claim"] == "verified_offline_import"
    assert File.exists?(result["index"])
    refute String.contains?(output, File.read!(f.fixture.service_identity))
    assert {:ok, nil} = Journal.read(f.fixture.root)
    refute File.exists?(Path.join(f.fixture.root, "operator-incarnation"))
  end

  test "ordinary command refuses zero ports before creating output", f do
    args =
      ["treehouse.initial_provisioning"] ++
        Enum.flat_map(Keyword.merge(f.opts, space_port: 0, thread_port: 0), fn {key, value} ->
          ["--" <> (key |> Atom.to_string() |> String.replace("_", "-")), to_string(value)]
        end)

    {output, status} =
      System.cmd(System.find_executable("mix"), args,
        stderr_to_stdout: true,
        env: [{"MIX_ENV", Atom.to_string(Mix.env())}]
      )

    refute status == 0
    assert String.contains?(output, "listener_ports_required")
    refute File.exists?(f.output)
  end

  test "a previous controlled boot marker prevents creating another initial output", f do
    File.write!(Path.join(f.fixture.root, "operator-incarnation"), Journal.digest("prior-boot"))
    assert {:error, :initial_provisioning_refused} = InitialProvisioning.prepare(f.opts)
    refute File.exists?(f.output)
  end

  test "initial activation re-observes a newly honored reference and refuses drift", f do
    assert {:ok, imported} = InitialProvisioning.prepare(f.opts)
    boot_import!(f.fixture.root, imported)

    assert {:ok, _} =
             Staging.prepare(
               f.fixture.root,
               nil,
               imported.request,
               imported.artifacts,
               f.fixture.ceremony_dir
             )

    {:ok, journal} = Journal.read(f.fixture.root)
    {:ok, %{log: space}} = Lattice.Log.restore_verified(Path.join(f.output, "space.log"))
    root = Sim.identity(f.fixture.space, "creator")

    extra =
      Lattice.Op.new(
        root,
        space.replica,
        Lattice.Log.frontier(space),
        :command,
        {:create_thread, [f.fixture.child.replica, "Alias"]},
        cap: f.fixture.reference.cap
      )

    assert {:ok, _} =
             LatticeCarrierServer.Holder.relay(
               LatticeCarrierServer.Holder.via("space"),
               InitialProvisioning.client_realm(root.pub),
               extra
             )

    {:ok, %{log: changed}} = Lattice.Log.restore_verified(Path.join(f.output, "space.log"))
    refute Map.has_key?(Lattice.Authority.analyze(Treehouse.Space, changed).reasons, extra.id)
    {deployment, observation} = seal_import!(imported)

    assert {:error, :invalid_staged_signed_artifact} =
             LatticeCarrierServer.Operator.ReleaseActivation.activate(
               f.fixture.root,
               journal,
               deployment.owner,
               observation,
               f.fixture.ceremony_dir
             )

    assert {:ok, ^journal} = Journal.read(f.fixture.root)
  end

  test "initial readiness tolerates quarantined traffic retained by the live relay", f do
    assert {:ok, imported} = InitialProvisioning.prepare(f.opts)
    boot_import!(f.fixture.root, imported)

    assert {:ok, _} =
             Staging.prepare(
               f.fixture.root,
               nil,
               imported.request,
               imported.artifacts,
               f.fixture.ceremony_dir
             )

    activated = activate_import!(f.fixture.root, imported, f.fixture.ceremony_dir)
    assert :ok = Application.stop(:lattice_carrier_server)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
    child = Sim.log(f.fixture.child, "creator")
    stranger = Lattice.Identity.from_seed("noise", "live-relay-noise")

    noise =
      Lattice.Op.new(
        stranger,
        child.replica,
        Lattice.Log.frontier(child),
        :command,
        {:post, ["noise"]}
      )

    root = Sim.identity(f.fixture.child, "creator")

    assert {:ok, _} =
             LatticeCarrierServer.Holder.relay(
               LatticeCarrierServer.Holder.via("thread"),
               InitialProvisioning.client_realm(root.pub),
               noise
             )

    child_path = Enum.find(JSON.decode!(activated)["artifacts"], &(&1["kind"] == "log"))["path"]
    assert {:ok, %{log: retained}} = Lattice.Log.restore_verified(child_path)
    assert retained.ops[noise.id] == noise
    assert Map.has_key?(Lattice.Authority.analyze(Treehouse.Thread, retained).reasons, noise.id)

    assert {:ok, ready} =
             LatticeCarrierServer.Operator.ReleaseReadiness.confirm(
               f.fixture.root,
               activated,
               probe!(f.fixture.root),
               f.fixture.ceremony_dir
             )

    assert ready["phase"] == "ready"
  end

  test "initial readiness refuses authentic child revocation without changing its receipt", f do
    assert {:ok, imported} = InitialProvisioning.prepare(f.opts)
    boot_import!(f.fixture.root, imported)

    assert {:ok, _} =
             Staging.prepare(
               f.fixture.root,
               nil,
               imported.request,
               imported.artifacts,
               f.fixture.ceremony_dir
             )

    activated = activate_import!(f.fixture.root, imported, f.fixture.ceremony_dir)
    assert :ok = Application.stop(:lattice_carrier_server)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
    delegation = hd(hd(f.fixture.artifacts).review["grants"])["delegation"]
    {_sim, revoke} = Sim.revoke(f.fixture.child, "creator", delegation)
    root = Sim.identity(f.fixture.child, "creator")

    assert {:ok, _} =
             LatticeCarrierServer.Holder.relay(
               LatticeCarrierServer.Holder.via("thread"),
               InitialProvisioning.client_realm(root.pub),
               revoke
             )

    assert {:error, :invalid_staged_signed_artifact} =
             LatticeCarrierServer.Operator.ReleaseReadiness.confirm(
               f.fixture.root,
               activated,
               probe!(f.fixture.root),
               f.fixture.ceremony_dir
             )

    assert {:ok, ^activated} = Journal.read(f.fixture.root)
  end

  defp boot_import!(root, imported) do
    previous =
      Map.new(
        [:manifest, :operator_root],
        &{&1, Application.fetch_env(:lattice_carrier_server, &1)}
      )

    Application.stop(:lattice_carrier_server)

    on_exit(fn ->
      Application.stop(:lattice_carrier_server)

      for {key, value} <- previous do
        case value do
          {:ok, old} -> Application.put_env(:lattice_carrier_server, key, old)
          :error -> Application.delete_env(:lattice_carrier_server, key)
        end
      end

      Application.ensure_all_started(:lattice_carrier_server)
    end)

    Application.put_env(:lattice_carrier_server, :manifest, imported.active_manifest)
    Application.put_env(:lattice_carrier_server, :operator_root, root)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
  end

  defp seal_import!(imported) do
    deployment = LatticeCarrierServer.Runtime.deployment()
    {:ok, manifest} = LatticeCarrierServer.Manifest.load(imported.active_manifest)
    replicas = Map.new(manifest.instances, &{&1.name, Lattice.Log.restore_verified(&1.log_file)})

    expected = %{
      manifest_path: deployment.manifest_path,
      manifest_digest: deployment.manifest_digest,
      instances:
        Enum.map(deployment.instances, fn instance ->
          {:ok, %{log: log}} = replicas[instance.name]
          instance |> Map.take([:name, :realm, :pub, :log_file]) |> Map.put(:replica, log.replica)
        end)
    }

    assert {:ok, receipt} =
             LatticeCarrierServer.Operator.ReleaseQuiesce.drain(
               imported.request.attempt,
               expected
             )

    assert {:ok, observation} =
             LatticeCarrierServer.Operator.ReleaseStopSeal.stop_and_seal(
               deployment.owner,
               receipt
             )

    {deployment, observation}
  end

  defp activate_import!(root, imported, ceremony) do
    {:ok, journal} = Journal.read(root)
    {deployment, observation} = seal_import!(imported)

    assert {:ok, _} =
             LatticeCarrierServer.Operator.ReleaseActivation.activate(
               root,
               journal,
               deployment.owner,
               observation,
               ceremony
             )

    {:ok, activated} = Journal.read(root)
    activated
  end

  defp probe!(root) do
    path = Path.join(root, "ordinary-probe.identity")
    File.write!(path, Base.encode16(:crypto.hash(:sha256, "ordinary-probe")))
    File.chmod!(path, 0o600)
    path
  end

  defp phase(port, expected) do
    receive do
      {^port, {:data, {:eol, bytes}}} ->
        case Jason.decode(bytes) do
          {:ok, %{"phase" => ^expected} = message} -> message
          _ -> flunk("ordinary workflow failed at #{expected}: #{diagnostic(port, bytes, 20)}")
        end

      {^port, {:exit_status, status}} ->
        flunk("ordinary workflow exited #{status} before #{expected}")
    after
      30_000 -> flunk("ordinary workflow timed out before #{expected}")
    end
  end

  defp diagnostic(_port, bytes, 0), do: String.slice(bytes, 0, 4000)

  defp diagnostic(port, bytes, left) do
    receive do
      {^port, {:data, {:eol, line}}} -> diagnostic(port, bytes <> "\n" <> line, left - 1)
      {^port, {:exit_status, status}} -> String.slice(bytes <> "\nexit #{status}", 0, 4000)
    after
      100 -> String.slice(bytes, 0, 4000)
    end
  end

  defp snapshot(output) do
    Map.new(File.ls!(output), fn name -> {name, File.read!(Path.join(output, name))} end)
  end
end
