defmodule LatticeCarrierServer.Operator.SemanticStagingTest do
  use ExUnit.Case, async: false
  alias Lattice.Carrier.Wire
  alias Lattice.{Log, Op}
  alias LatticeCarrierServer.Manifest
  alias LatticeCarrierServer.Operator.{Journal, Staging}

  setup do
    {:ok, staged()}
  end

  defp staged(opts \\ []) do
    {:ok, data} = LatticeCarrierServer.Operator.Fixture.new(opts)
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
    Map.merge(f, %{retained: retained, manifest: manifest})
  end

  test "actual bounded child, profile, grant inventory and signed reference replay", f do
    assert {:ok, _service} = Staging.inspect_staged(f.retained, f.manifest)
    refute File.exists?(Journal.path(f.root))
  end

  test "staging binds the admitted service identity file, realm, key and digest", f do
    identity_file = Path.join(f.root, "child-service.identity")
    # The fixture's child-service file holds sha256("child-service") as its seed.
    pub = Lattice.Identity.from_seed("child-service", "child-service").pub

    assert {:ok, service} = Staging.inspect_staged(f.retained, f.manifest)

    assert service == %{
             "identity_file" => identity_file,
             "realm" => "child-service",
             "pub" => Base.encode64(pub),
             "sha256" => Journal.digest(File.read!(identity_file))
           }

    assert Journal.service_identity_current?(service)
  end

  test "a service identity rotated after staging no longer verifies", f do
    {:ok, service} = Staging.inspect_staged(f.retained, f.manifest)

    File.write!(
      service["identity_file"],
      Base.encode16(:crypto.hash(:sha256, "rotated-service"), case: :lower)
    )

    refute Journal.service_identity_current?(service)
  end

  test "a same-key rewrite of the identity file no longer matches the bound digest", f do
    {:ok, service} = Staging.inspect_staged(f.retained, f.manifest)
    # Same seed, different bytes (upper-case hex): the key still matches, but
    # the reviewed file is not the one on disk any more.
    File.write!(service["identity_file"], String.upcase(File.read!(service["identity_file"])))

    refute Journal.service_identity_current?(service)
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

    # An honored active grant omitted from the review is an inexact inventory,
    # refused on the artifact itself rather than only through the roster.
    omitted = %{child | review: Map.put(child.review, "grants", [])}

    assert {:error, :invalid_staged_signed_artifact} =
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

  test "a root-authored tombstone on the child refuses the bundle", f do
    [child | rest] = f.retained
    {:ok, %{log: original}} = Log.restore_verified(child.path)
    root = Lattice.Identity.from_seed("creator", "independent-child:creator")
    target = child.review["creation"]

    tombstone = Op.new(root, original.replica, [target], :tombstone, {:delete, target})
    :ok = Log.dump(Log.append!(original, tombstone), child.path)
    bytes = File.read!(child.path)

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.inspect_staged(
               [%{child | bytes: bytes, digest: Journal.digest(bytes)} | rest],
               f.manifest
             )
  end

  test "an honored child grant omitted from the reviewed inventory refuses", f do
    [child | rest] = f.retained

    {expanded, _grant} =
      Lattice.Sim.grant(f.child, "creator", "nominee",
        ops: [:post],
        expires_epoch: 7
      )

    :ok = Log.dump(Lattice.Sim.log(expanded, "creator"), child.path)
    bytes = File.read!(child.path)

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.inspect_staged(
               [%{child | bytes: bytes, digest: Journal.digest(bytes)} | rest],
               f.manifest
             )
  end

  test "an honored role transfer outside the reviewed inventory refuses", f do
    [child | rest] = f.retained

    {transferred, _deleg} =
      Lattice.Sim.transfer(f.child, "creator", "nominee", :moderator,
        ops: [:post],
        expires_epoch: 7
      )

    :ok = Log.dump(Lattice.Sim.log(transferred, "creator"), child.path)
    bytes = File.read!(child.path)

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.inspect_staged(
               [%{child | bytes: bytes, digest: Journal.digest(bytes)} | rest],
               f.manifest
             )
  end

  test "one attempt refuses a second child without its own signed Space reference", f do
    [child | _] = f.retained

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.inspect_staged(f.retained ++ [child], f.manifest)
  end

  test "a reviewed profile pin carrying unreviewed beacon witnesses refuses", _f do
    outsider = Lattice.Identity.from_seed("outsider", "operator-outsider").pub

    hostile =
      staged(
        pin_beacon: %{
          mode: :witnessed,
          version: 1,
          witnesses: [outsider],
          threshold: 1,
          max_epoch_step: 1
        }
      )

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.inspect_staged(hostile.retained, hostile.manifest)
  end

  test "a reviewed profile pin widening the beacon epoch step refuses", _f do
    # Reviewed witnesses and threshold, but a quorum could jump 65,535 group
    # days at once and lapse grants the step-one lifecycle expects to keep.
    hostile = staged(pin_beacon: {:max_epoch_step, 65_535})

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.inspect_staged(hostile.retained, hostile.manifest)
  end

  test "the reviewed witness set is accepted in any signed order", _f do
    reordered = staged(pin_beacon: :reordered_witnesses)

    assert {:ok, _service} = Staging.inspect_staged(reordered.retained, reordered.manifest)
  end

  test "an epoch-beacon policy on the child root genesis refuses", _f do
    hostile =
      staged(
        root_policies: %{
          __beacon__: %{
            mode: :witnessed,
            version: 1,
            witnesses: ["nominee"],
            threshold: 1,
            max_epoch_step: 1
          }
        }
      )

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.inspect_staged(hostile.retained, hostile.manifest)
  end

  test "candidate cannot open relay ingress on the admitted child", f do
    candidate = candidate_json(f)
    [old, child] = candidate["instances"]
    child = Map.put(child, "relay_realms", ["member"])
    retained = replace_candidate(f, Map.put(candidate, "instances", [old, child]))

    assert {:error, :invalid_candidate_manifest} =
             Staging.inspect_staged(retained, f.manifest)
  end

  test "candidate requires the independently rooted child as a bootstrap peer", f do
    candidate = candidate_json(f)
    [old, child] = candidate["instances"]
    child = Map.put(child, "trusted_peers", old["trusted_peers"])
    retained = replace_candidate(f, Map.put(candidate, "instances", [old, child]))

    assert {:error, :invalid_candidate_manifest} =
             Staging.inspect_staged(retained, f.manifest)
  end

  test "a candidate whose child root reuses the active Space root refuses", _f do
    hostile = staged(child_creator: :reuse_space_root)

    assert {:error, :invalid_candidate_manifest} =
             Staging.inspect_staged(hostile.retained, hostile.manifest)
  end

  test "a candidate whose child root reuses the admitted carrier service key refuses", _f do
    hostile = staged(child_creator: :reuse_carrier_service_key)

    assert {:error, :invalid_candidate_manifest} =
             Staging.inspect_staged(hostile.retained, hostile.manifest)
  end

  test "a second, non-root Space member stages honestly", _f do
    two = staged(second_member: true)

    assert {:ok, _service} = Staging.inspect_staged(two.retained, two.manifest)
  end

  test "a Space whose root is not a roster member stages honestly", _f do
    rootless = staged(second_member: true, root_member: false)

    assert {:ok, _service} = Staging.inspect_staged(rootless.retained, rootless.manifest)
  end

  test "a candidate whose carrier service key is the Space root's refuses", _f do
    # The root is off the roster here, so only the root comparison can refuse.
    rootless = staged(second_member: true, root_member: false)
    retained = with_service_identity(rootless, Lattice.Sim.identity(rootless.space, "creator"))

    assert {:error, :invalid_candidate_manifest} =
             Staging.inspect_staged(retained, rootless.manifest)
  end

  test "a candidate whose carrier service key is a non-root member's refuses", _f do
    two = staged(second_member: true)
    retained = with_service_identity(two, Lattice.Sim.identity(two.space, "member2"))

    assert {:error, :invalid_candidate_manifest} =
             Staging.inspect_staged(retained, two.manifest)
  end

  test "a child replica already served by an active instance refuses", f do
    active_json = Jason.decode!(File.read!(f.request.active_manifest))
    [active_record] = active_json["instances"]
    served_log = Path.join(f.root, "served-child.log")
    :ok = Log.dump(Lattice.Sim.log(f.child, "creator"), served_log)
    served_identity = Path.join(f.root, "served-child.identity")

    File.write!(
      served_identity,
      Base.encode16(:crypto.hash(:sha256, "served-child-service"), case: :lower)
    )

    File.chmod!(served_identity, 0o600)

    served =
      active_record
      |> Map.put("name", "served-child")
      |> Map.put("log_file", served_log)
      |> Map.put("identity_file", served_identity)
      |> put_in(["listener", "port"], 41_003)

    served_active_path = Path.join(f.root, "served-active.json")

    File.write!(
      served_active_path,
      Jason.encode!(%{"version" => 1, "instances" => [active_record, served]})
    )

    File.chmod!(served_active_path, 0o600)
    {:ok, active} = Manifest.load(served_active_path)

    candidate = candidate_json(f)
    retained = replace_candidate(f, Map.update!(candidate, "instances", &[served | &1]))

    assert {:error, :invalid_candidate_manifest} =
             Staging.inspect_staged(retained, active)
  end

  test "a Space reference already present in active history is not carrier pending", f do
    :ok = Log.dump(f.updated_log, f.active_log)

    assert {:error, :invalid_staged_signed_artifact} =
             Staging.inspect_staged(f.retained, f.manifest)
  end

  test "candidate cannot change an active instance configuration", f do
    candidate = candidate_json(f)
    [old, child] = candidate["instances"]
    changed = put_in(old, ["listener", "port"], 41_001)
    retained = replace_candidate(f, Map.put(candidate, "instances", [changed, child]))

    assert {:error, :invalid_candidate_manifest} =
             Staging.inspect_staged(retained, f.manifest)
  end

  test "duplicate active histories for the referenced Space are ambiguous", f do
    active_json = Jason.decode!(File.read!(f.request.active_manifest))
    [active_record] = active_json["instances"]
    duplicate_log = Path.join(f.root, "duplicate-space.log")
    File.cp!(f.active_log, duplicate_log)
    duplicate_identity = Path.join(f.root, "duplicate-space.identity")

    File.write!(
      duplicate_identity,
      Base.encode16(:crypto.hash(:sha256, "duplicate-service"), case: :lower)
    )

    File.chmod!(duplicate_identity, 0o600)

    duplicate =
      active_record
      |> Map.put("name", "duplicate-space")
      |> Map.put("log_file", duplicate_log)
      |> Map.put("identity_file", duplicate_identity)
      |> put_in(["listener", "port"], 41_002)

    duplicate_active_path = Path.join(f.root, "duplicate-active.json")

    File.write!(
      duplicate_active_path,
      Jason.encode!(%{"version" => 1, "instances" => [active_record, duplicate]})
    )

    File.chmod!(duplicate_active_path, 0o600)
    {:ok, ambiguous} = Manifest.load(duplicate_active_path)

    candidate = candidate_json(f)
    retained = replace_candidate(f, Map.update!(candidate, "instances", &[duplicate | &1]))

    assert {:error, :invalid_candidate_manifest} =
             Staging.inspect_staged(retained, ambiguous)
  end

  # Points the admitted child instance at an identity file holding `identity`'s seed.
  defp with_service_identity(f, identity) do
    path = Path.join(f.root, "#{identity.realm_id}-as-service.identity")
    File.write!(path, Base.encode16(identity.priv, case: :lower))
    File.chmod!(path, 0o600)

    candidate = candidate_json(f)
    [old, child] = candidate["instances"]

    replace_candidate(
      f,
      Map.put(candidate, "instances", [old, Map.put(child, "identity_file", path)])
    )
  end

  defp candidate_json(f) do
    manifest = Enum.find(f.retained, &(&1.kind == :manifest))
    Jason.decode!(manifest.bytes)
  end

  defp replace_candidate(f, candidate) do
    Enum.map(f.retained, fn
      %{kind: :manifest} = manifest ->
        bytes = Jason.encode!(candidate)
        File.write!(manifest.path, bytes)
        %{manifest | bytes: bytes, digest: Journal.digest(bytes)}

      artifact ->
        artifact
    end)
  end
end
