defmodule LatticeCarrierServer.Operator.SemanticStagingTest do
  use ExUnit.Case, async: false
  alias Lattice.Carrier.Wire
  alias Lattice.{Log, Op}
  alias LatticeCarrierServer.Manifest
  alias LatticeCarrierServer.Operator.{Journal, Staging}
  Code.require_file("../support/operator/fixture.exs", __DIR__)

  setup do
    {:ok, data} = LatticeCarrierServer.Operator.Fixture.new()
    f = Map.new(data)

    retained =
      Enum.map(f.artifacts, fn artifact ->
        digest = Journal.digest(artifact.bytes)
        path = Staging.artifact_path(f.root, f.request.attempt, digest)
        # Test fixture publication only; never masquerades as an OS-locked mutation.
        File.mkdir_p!(Path.dirname(path))
        File.write!(path, artifact.bytes)
        File.chmod!(path, 0o600)
        Map.merge(artifact, %{path: path, digest: digest})
      end)

    {:ok, manifest} = Manifest.load(f.request.active_manifest)
    {:ok, Map.merge(f, %{retained: retained, manifest: manifest})}
  end

  test "actual bounded child, profile, grant inventory and signed reference replay", f do
    assert :ok = Staging.inspect_staged(f.retained, f.manifest)
    refute File.exists?(Journal.path(f.root))
  end

  test "missing reviewed profile, creation or grant introduction refuses", f do
    [child | rest] = f.retained
    absent = Base.url_encode64(:crypto.hash(:sha256, "absent"), padding: false)

    for key <- ["profile_genesis", "profile_id", "creation"] do
      invalid = %{child | review: Map.put(child.review, key, absent)}

      assert {:error, :invalid_staged_signed_artifact} =
               Staging.inspect_staged([invalid | rest], f.manifest)
    end

    [grant] = child.review["grants"]

    invalid = %{
      child
      | review: Map.put(child.review, "grants", [%{grant | "introduction" => absent}])
    }

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.inspect_staged([invalid | rest], f.manifest)

    omitted = %{child | review: Map.put(child.review, "grants", [])}

    assert {:error, :invalid_candidate_manifest} =
             Staging.inspect_staged([omitted | rest], f.manifest)
  end

  test "signed semantically refused child command refuses the bundle", f do
    [child | rest] = f.retained
    {:ok, %{log: log}} = Log.restore_verified(child.path)
    root = Lattice.Identity.from_seed("creator", "independent-child:creator")

    op =
      Op.new(root, log.replica, Log.frontier(log), :command, {:post, ["refused"]}, cap: "missing")

    assert Op.valid?(op)
    changed = Log.append!(log, op)
    :ok = Log.dump(changed, child.path)
    bytes = File.read!(child.path)
    invalid = %{child | bytes: bytes, digest: Journal.digest(bytes)}

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.inspect_staged([invalid | rest], f.manifest)
  end

  test "signed reference with unknown dependencies is a refusal, never an exception", f do
    root = Lattice.Identity.from_seed("creator", "operator-space:creator")
    missing = Base.url_encode64(:crypto.hash(:sha256, "missing-dependency"), padding: false)

    op =
      Op.new(root, f.reference.replica, [missing], :command, f.reference.body,
        cap: f.reference.cap
      )

    assert Op.valid?(op)

    artifacts =
      Enum.map(f.retained, fn
        %{kind: :reference} = a -> %{a | bytes: Jason.encode!(Wire.encode_op(op)), op_id: op.id}
        a -> a
      end)

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.inspect_staged(artifacts, f.manifest)
  end

  test "a complete child without its bounded pin and a revoked grant both refuse", f do
    [child | rest] = f.retained
    {:ok, %{log: original}} = Log.restore_verified(child.path)
    root = Lattice.Identity.from_seed("creator", "independent-child:creator")
    grant_id = hd(child.review["grants"])["delegation"]

    revoked =
      Op.new(root, original.replica, Log.frontier(original), :authority, {:revoke, grant_id})

    :ok = Log.dump(Log.append!(original, revoked), child.path)
    revoked_bytes = File.read!(child.path)

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.inspect_staged(
               [%{child | bytes: revoked_bytes, digest: Journal.digest(revoked_bytes)} | rest],
               f.manifest
             )

    kept = Map.take(original.ops, [child.op_id, child.review["creation"]])
    :ok = Log.dump(Log.from_ops(original.replica, kept), child.path)
    incomplete = File.read!(child.path)

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.inspect_staged(
               [%{child | bytes: incomplete, digest: Journal.digest(incomplete)} | rest],
               f.manifest
             )
  end
end
