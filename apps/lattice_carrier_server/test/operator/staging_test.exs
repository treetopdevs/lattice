defmodule LatticeCarrierServer.Operator.StagingTest do
  use ExUnit.Case, async: false
  alias Lattice.Carrier.Wire
  alias Lattice.{Log, Sim}
  alias LatticeCarrierServer.Operator.{Journal, Staging}

  defmodule LocalSequence do
    def sync_file(path), do: LatticeCarrierServer.Durability.Posix.sync_file(path)
    def rename(a, b), do: File.rename(a, b)
    def sync_directory(_), do: :ok
  end

  setup do
    root = Path.expand(".operator-stage-#{System.unique_integer([:positive])}", File.cwd!())
    File.mkdir!(root)
    File.chmod!(root, 0o700)
    on_exit(fn -> File.rm_rf!(root) end)

    {space, _} =
      Sim.new(Treehouse.Space, "space:operator", ["creator"], seed: "operator-space")
      |> Sim.create_replica("creator")

    {space, _} = Sim.command(space, "creator", :create_space, ["Canopy"])

    {child, genesis} =
      Sim.new(Treehouse.Thread, "thread:operator", ["creator"], seed: "independent-child")
      |> Sim.create_replica("creator")

    {child, _} = Sim.command(child, "creator", :create_thread, ["Branch"])
    assert Sim.identity(space, "creator").pub != Sim.identity(child, "creator").pub

    {space_with_ref, reference} =
      Sim.command(space, "creator", :create_thread, [child.replica, "Branch"])

    refute Sim.quarantined(space_with_ref, "creator", reference.id)
    active_log = Path.join(root, "existing.log")
    :ok = Log.dump(Sim.log(space, "creator"), active_log)
    child_source = Path.join(root, "child-source.log")
    :ok = Log.dump(Sim.log(child, "creator"), child_source)
    child_bytes = File.read!(child_source)
    identity = Path.join(root, "service.identity")
    File.write!(identity, Base.encode16(:crypto.hash(:sha256, "operator-service"), case: :lower))
    File.chmod!(identity, 0o600)

    instance = %{
      "name" => "space",
      "realm" => "service",
      "identity_file" => identity,
      "log_file" => active_log,
      "listener" => %{"ip" => "127.0.0.1", "port" => 0},
      "trusted_peers" => [
        %{"realm" => "member", "pubkey" => Base.encode64(Sim.identity(space, "creator").pub)}
      ]
    }

    active = Path.join(root, "active.json")
    File.write!(active, Jason.encode!(%{"version" => 1, "instances" => [instance]}))
    File.chmod!(active, 0o600)
    attempt = Base.encode64(:crypto.hash(:sha256, "reviewed-attempt"))
    child_path = Staging.artifact_path(root, attempt, Journal.digest(child_bytes))

    next_instance = %{
      instance
      | "name" => "thread",
        "log_file" => child_path,
        "realm" => "child-service"
    }

    # Existing Manifest contract requires unique identity files across instances.
    child_identity = Path.join(root, "child-service.identity")

    File.write!(
      child_identity,
      Base.encode16(:crypto.hash(:sha256, "child-service"), case: :lower)
    )

    File.chmod!(child_identity, 0o600)
    next_instance = %{next_instance | "identity_file" => child_identity}

    artifacts = [
      %{kind: :log, bytes: child_bytes, replica: child.replica, op_id: genesis.id},
      %{
        kind: :reference,
        bytes: Jason.encode!(Wire.encode_op(reference)),
        replica: space.replica,
        op_id: reference.id
      },
      %{
        kind: :manifest,
        bytes: Jason.encode!(%{"version" => 1, "instances" => [instance, next_instance]}),
        replica: nil,
        op_id: nil
      }
    ]

    request = %{
      active_manifest: active,
      attempt: attempt,
      generation: 1,
      catalog_head: nil,
      manifest_digest: Journal.digest(File.read!(active))
    }

    {:ok,
     root: root,
     request: request,
     artifacts: artifacts,
     active_log: active_log,
     active_bytes: File.read!(active_log),
     updated_log: Sim.log(space_with_ref, "creator"),
     reference: reference}
  end

  test "signed independent child and exact frozen reference stage without rewriting served log",
       f do
    assert {:ok, record} =
             Staging.prepare(f.root, nil, f.request, f.artifacts, durability: LocalSequence)

    assert record["phase"] == "carrier_pending"
    assert File.read!(f.active_log) == f.active_bytes

    for artifact <- f.artifacts do
      assert File.read!(
               Staging.artifact_path(f.root, f.request.attempt, Journal.digest(artifact.bytes))
             ) == artifact.bytes
    end

    assert {:ok, journal} = Journal.read(f.root)

    assert {:ok, ^record} =
             Staging.prepare(f.root, journal, f.request, f.artifacts, durability: LocalSequence)

    assert {:ok, ^journal} = Journal.read(f.root)
    assert File.read!(f.active_log) == f.active_bytes
  end

  test "wrong signed replica never emits a prepared journal and preserves existing bytes", f do
    [child | rest] = f.artifacts

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.prepare(f.root, nil, f.request, [%{child | replica: "wrong"} | rest],
               durability: LocalSequence
             )

    assert {:ok, nil} = Journal.read(f.root)
    assert File.read!(f.active_log) == f.active_bytes
  end

  test "changed active manifest refuses before any staged attempt", f do
    File.write!(f.request.active_manifest, File.read!(f.request.active_manifest) <> "\n")

    assert {:error, :stale_or_invalid_operator_intent} =
             Staging.prepare(f.root, nil, f.request, f.artifacts, durability: LocalSequence)

    refute File.exists?(Path.join(f.root, "attempt-" <> Journal.digest(f.request.attempt)))
    assert File.read!(f.active_log) == f.active_bytes
  end

  test "invalid signature refuses and retains exact artifacts for investigation", f do
    artifacts =
      Enum.map(f.artifacts, fn
        %{kind: :reference} = a ->
          frame = Jason.decode!(a.bytes) |> Map.put("sig", Base.encode64(<<0::512>>))
          %{a | bytes: Jason.encode!(frame)}

        a ->
          a
      end)

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.prepare(f.root, nil, f.request, artifacts, durability: LocalSequence)

    assert {:ok, nil} = Journal.read(f.root)
    assert File.read!(f.active_log) == f.active_bytes
  end

  test "extra retained artifact refuses omission rather than cleaning it up", f do
    assert {:ok, _} =
             Staging.prepare(f.root, nil, f.request, f.artifacts, durability: LocalSequence)

    {:ok, journal} = Journal.read(f.root)
    extra = Path.join([f.root, "attempt-" <> Journal.digest(f.request.attempt), "unexpected"])
    File.write!(extra, "preserve")

    assert {:error, :ambiguous_staging_inventory} =
             Staging.prepare(f.root, journal, f.request, f.artifacts, durability: LocalSequence)

    assert File.read!(extra) == "preserve"
    assert {:ok, ^journal} = Journal.read(f.root)
    assert File.read!(f.active_log) == f.active_bytes
  end

  test "truncated immutable artifact never gets overwritten on retry", f do
    assert {:ok, _} =
             Staging.prepare(f.root, nil, f.request, f.artifacts, durability: LocalSequence)

    {:ok, journal} = Journal.read(f.root)
    [artifact | _] = f.artifacts
    path = Staging.artifact_path(f.root, f.request.attempt, Journal.digest(artifact.bytes))
    File.write!(path, "truncated")

    assert {:error, :immutable_artifact_conflict} =
             Staging.prepare(f.root, journal, f.request, f.artifacts, durability: LocalSequence)

    assert File.read!(path) == "truncated"
    assert {:ok, ^journal} = Journal.read(f.root)
    assert File.read!(f.active_log) == f.active_bytes
  end

  defmodule ConcurrentAcceptedAppend do
    def sync_file(path), do: LocalSequence.sync_file(path)
    def rename(a, b), do: File.rename(a, b)

    def sync_directory(_) do
      case Process.delete(:operator_test_append) do
        {path, log} -> Log.dump(log, path)
        nil -> :ok
      end
    end
  end

  test "a concurrently acknowledged frame is preserved and prevents stale preparation", f do
    Process.put(:operator_test_append, {f.active_log, f.updated_log})

    assert {:error, :stale_or_invalid_operator_intent} =
             Staging.prepare(f.root, nil, f.request, f.artifacts,
               durability: ConcurrentAcceptedAppend
             )

    assert {:ok, %{log: restored}} = Log.restore_verified(f.active_log)
    assert Map.has_key?(restored.ops, f.reference.id)
    assert {:ok, nil} = Journal.read(f.root)
  end

  test "an unrelated expected genesis ID refuses without journal promotion", f do
    [child | rest] = f.artifacts

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.prepare(f.root, nil, f.request, [%{child | op_id: f.reference.id} | rest],
               durability: LocalSequence
             )

    assert {:ok, nil} = Journal.read(f.root)
    assert File.read!(f.active_log) == f.active_bytes
  end

  test "validly signed reference with refused authority cannot become prepared", f do
    root = Lattice.Identity.from_seed("creator", "operator-space:creator")

    op =
      Lattice.Op.new(root, f.reference.replica, f.reference.deps, :command, f.reference.body,
        cap: "missing-cap"
      )

    assert Lattice.Op.valid?(op)

    artifacts =
      Enum.map(f.artifacts, fn
        %{kind: :reference} = a -> %{a | bytes: Jason.encode!(Wire.encode_op(op)), op_id: op.id}
        a -> a
      end)

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.prepare(f.root, nil, f.request, artifacts, durability: LocalSequence)

    assert {:ok, nil} = Journal.read(f.root)
    assert File.read!(f.active_log) == f.active_bytes
  end
end
