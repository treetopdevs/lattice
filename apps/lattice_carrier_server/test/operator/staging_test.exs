defmodule LatticeCarrierServer.Operator.StagingTest do
  use ExUnit.Case, async: false
  if :os.type() != {:unix, :linux}, do: @moduletag(skip: "Requires actual Linux OS lock")
  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.Operator.{Journal, Staging}

  Code.require_file("../support/operator/fixture.ex", __DIR__)

  setup do
    LatticeCarrierServer.Operator.Fixture.new()
  end

  test "signed independent child and exact frozen reference stage without rewriting served log",
       f do
    assert {:ok, record} =
             Staging.prepare(f.root, nil, f.request, f.artifacts)

    assert record["phase"] == "carrier_pending"
    assert File.read!(f.active_log) == f.active_bytes

    for artifact <- f.artifacts do
      assert File.read!(
               Staging.artifact_path(f.root, f.request.attempt, Journal.digest(artifact.bytes))
             ) == artifact.bytes
    end

    assert {:ok, journal} = Journal.read(f.root)

    assert {:ok, ^record} =
             Staging.prepare(f.root, journal, f.request, f.artifacts)

    assert {:ok, ^journal} = Journal.read(f.root)
    assert File.read!(f.active_log) == f.active_bytes
  end

  test "wrong signed replica never emits a prepared journal and preserves existing bytes", f do
    [child | rest] = f.artifacts

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.prepare(f.root, nil, f.request, [%{child | replica: "wrong"} | rest])

    assert {:ok, nil} = Journal.read(f.root)
    assert File.read!(f.active_log) == f.active_bytes
  end

  test "changed active manifest refuses before any staged attempt", f do
    File.write!(f.request.active_manifest, File.read!(f.request.active_manifest) <> "\n")

    assert {:error, :unsupported_or_stale_operator_intent} =
             Staging.prepare(f.root, nil, f.request, f.artifacts)

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
             Staging.prepare(f.root, nil, f.request, artifacts)

    assert {:ok, nil} = Journal.read(f.root)
    assert File.read!(f.active_log) == f.active_bytes
  end

  test "extra retained artifact refuses omission rather than cleaning it up", f do
    assert {:ok, _} =
             Staging.prepare(f.root, nil, f.request, f.artifacts)

    {:ok, journal} = Journal.read(f.root)
    extra = Path.join([f.root, "attempt-" <> Journal.digest(f.request.attempt), "unexpected"])
    File.write!(extra, "preserve")

    assert {:error, {:operator_refused, "ambiguous_staging_inventory"}} =
             Staging.prepare(f.root, journal, f.request, f.artifacts)

    assert File.read!(extra) == "preserve"
    assert {:ok, ^journal} = Journal.read(f.root)
    assert File.read!(f.active_log) == f.active_bytes
  end

  test "truncated immutable artifact never gets overwritten on retry", f do
    assert {:ok, _} =
             Staging.prepare(f.root, nil, f.request, f.artifacts)

    {:ok, journal} = Journal.read(f.root)
    [artifact | _] = f.artifacts
    path = Staging.artifact_path(f.root, f.request.attempt, Journal.digest(artifact.bytes))
    File.write!(path, "truncated")

    assert {:error, {:operator_refused, "immutable_artifact_conflict"}} =
             Staging.prepare(f.root, journal, f.request, f.artifacts)

    assert File.read!(path) == "truncated"
    assert {:ok, ^journal} = Journal.read(f.root)
    assert File.read!(f.active_log) == f.active_bytes
  end

  test "an unrelated expected genesis ID refuses without journal promotion", f do
    [child | rest] = f.artifacts

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.prepare(f.root, nil, f.request, [%{child | op_id: f.reference.id} | rest])

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
             Staging.prepare(f.root, nil, f.request, artifacts)

    assert {:ok, nil} = Journal.read(f.root)
    assert File.read!(f.active_log) == f.active_bytes
  end
end
