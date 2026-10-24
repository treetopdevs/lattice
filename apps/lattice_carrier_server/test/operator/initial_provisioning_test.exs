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

  test "missing completion marker preserves partial output and refuses retry", f do
    assert {:ok, imported} = InitialProvisioning.prepare(f.opts)
    File.rm!(imported.index)
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
    Application.put_env(:lattice_carrier_server, :operator_root, f.fixture.root)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
    assert LatticeCarrierServer.Runtime.deployment().operator_root == f.fixture.root
    assert LatticeCarrierServer.Health.ready?()

    assert {:ok, record} =
             Staging.prepare(f.fixture.root, nil, imported.request, imported.artifacts, ceremony)

    assert record["phase"] == "carrier_pending"
  end

  test "a previous controlled boot marker prevents creating another initial output", f do
    File.write!(Path.join(f.fixture.root, "operator-incarnation"), Journal.digest("prior-boot"))
    assert {:error, :initial_provisioning_refused} = InitialProvisioning.prepare(f.opts)
    refute File.exists?(f.output)
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
