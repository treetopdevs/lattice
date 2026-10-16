defmodule LatticeCarrierServer.Operator.ReleaseActivationTest do
  use ExUnit.Case, async: false
  if :os.type() != {:unix, :linux}, do: @moduletag(skip: "Requires actual Linux OS lock")
  alias Lattice.Log
  alias LatticeCarrierServer.{Manifest, Runtime}

  alias LatticeCarrierServer.Operator.{
    Fixture,
    Journal,
    ReleaseActivation,
    ReleaseGate,
    ReleaseQuiesce,
    Lock,
    ReleaseStopSeal,
    Staging
  }

  setup do
    previous = Application.get_env(:lattice_carrier_server, :manifest)
    Application.stop(:lattice_carrier_server)

    on_exit(fn ->
      Application.stop(:lattice_carrier_server)
      # The fixture root is gone by the time this restart runs.
      Application.delete_env(:lattice_carrier_server, :operator_root)

      if previous,
        do: Application.put_env(:lattice_carrier_server, :manifest, previous),
        else: Application.delete_env(:lattice_carrier_server, :manifest)

      Application.ensure_all_started(:lattice_carrier_server)
    end)

    {:ok, data} = Fixture.new()
    f = Map.new(data)
    {:ok, record} = Staging.prepare(f.root, nil, f.request, f.artifacts)
    {:ok, journal} = Journal.read(f.root)
    [candidate] = Enum.filter(record["artifacts"], &(&1["kind"] == "manifest"))

    {:ok,
     Map.merge(f, %{
       record: record,
       journal: journal,
       manifest: f.request.active_manifest,
       active_manifest: File.read!(f.request.active_manifest),
       candidate: candidate
     })}
  end

  test "a sealed release activates the staged candidate and a full restart serves its routes",
       f do
    {owner, observation} = sealed(f)

    assert {:ok, activated} = ReleaseActivation.activate(f.root, f.journal, owner, observation)
    assert activated == Map.put(f.record, "phase", "activated")
    assert Journal.digest(File.read!(f.manifest)) == f.candidate["sha256"]
    assert File.read!(f.manifest) == File.read!(f.candidate["path"])
    assert {:ok, raw} = Journal.read(f.root)
    assert Jason.decode!(raw) == activated
    # Activation neither reopens admission nor restarts a route in place.
    assert ReleaseGate.sealed?(owner, observation)
    refute ReleaseGate.accepting?(owner)
    assert {:error, :controlled_release_owned} = Runtime.prepare(f.manifest)
    assert File.read!(f.active_log) == f.active_bytes

    assert :ok = Application.stop(:lattice_carrier_server)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
    deployment = Runtime.deployment()
    assert Enum.map(deployment.instances, & &1.name) == ["space", "thread"]
    assert ReleaseGate.accepting?(deployment.owner)
    refute ReleaseGate.sealed?(deployment.owner, observation)
  end

  test "a drained but unsealed release refuses and writes nothing", f do
    {owner, receipt} = drained(f)

    assert {:error, :release_not_sealed} =
             ReleaseActivation.activate(f.root, f.journal, owner, receipt)

    unchanged!(f)
  end

  test "a seal taken for a different attempt refuses", f do
    {owner, observation} = sealed(f, nonce("another-attempt"))

    assert {:error, :release_attempt_mismatch} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation)

    unchanged!(f)
  end

  test "an observation from a previous incarnation never activates", f do
    {owner, observation} = sealed(f)
    assert :ok = Application.stop(:lattice_carrier_server)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)

    for current <- [owner, Runtime.deployment().owner] do
      assert {:error, _} = ReleaseActivation.activate(f.root, f.journal, current, observation)
    end

    unchanged!(f)
  end

  test "a stale journal expectation refuses", f do
    {owner, observation} = sealed(f)

    assert {:error, :stale_operator_intent} =
             ReleaseActivation.activate(f.root, nil, owner, observation)

    unchanged!(f)
  end

  test "a service identity rewritten after staging refuses before the owner runs", f do
    {owner, observation} = sealed(f)
    identity = f.record["service"]["identity_file"]
    File.write!(identity, String.upcase(File.read!(identity)))

    assert {:error, :stale_operator_intent} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation)

    unchanged!(f)
  end

  test "an existing route's identity rewritten after the seal refuses", f do
    {owner, observation} = sealed(f)
    identity = Path.join(f.root, "service.identity")
    File.write!(identity, Base.encode16(:crypto.hash(:sha256, "rotated"), case: :lower))

    assert {:error, :release_identity_changed} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation)

    unchanged!(f)
  end

  test "an existing route log rewritten after the seal refuses", f do
    {owner, observation} = sealed(f)
    :ok = Log.dump(f.updated_log, f.active_log)

    assert {:error, :release_bytes_changed} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation)

    assert File.read!(f.manifest) == f.active_manifest
    assert {:ok, journal} = Journal.read(f.root)
    assert journal == f.journal
  end

  test "an active manifest changed after the seal refuses", f do
    {owner, observation} = sealed(f)
    changed = f.active_manifest <> "\n"
    File.write!(f.manifest, changed)

    assert {:error, {:operator_refused, "stale_operator_intent"}} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation)

    assert File.read!(f.manifest) == changed
    assert {:ok, journal} = Journal.read(f.root)
    assert journal == f.journal
  end

  test "a symlinked active manifest is refused, not followed", f do
    {owner, observation} = sealed(f)
    real = Path.join(f.root, "real-active.json")
    File.rename!(f.manifest, real)
    File.ln_s!(real, f.manifest)

    assert {:error, {:operator_refused, "unsafe_operator_file"}} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation)

    assert {:ok, %{type: :symlink}} = File.lstat(f.manifest)
    assert File.read!(real) == f.active_manifest
    assert {:ok, journal} = Journal.read(f.root)
    assert journal == f.journal
  end

  test "an active manifest directory the service cannot write refuses before any write", f do
    {owner, observation} = sealed(f)
    File.chmod!(f.root, 0o500)
    on_exit(fn -> File.chmod(f.root, 0o700) end)

    assert {:error, {:operator_refused, "unsafe_operator_directory"}} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation)

    File.chmod!(f.root, 0o700)
    unchanged!(f)
    assert Path.wildcard(Path.join(f.root, ".active.json.activate.*"), match_dot: true) == []
  end

  test "a tampered staged candidate manifest refuses", f do
    {owner, observation} = sealed(f)
    File.write!(f.candidate["path"], File.read!(f.candidate["path"]) <> "\n")

    assert {:error, {:operator_refused, "immutable_artifact_conflict"}} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation)

    unchanged!(f)
  end

  test "a tampered staged child log refuses before the manifest is replaced", f do
    {owner, observation} = sealed(f)
    [child] = Enum.filter(f.record["artifacts"], &(&1["kind"] == "log"))
    File.write!(child["path"], File.read!(child["path"]) <> "\n")

    assert {:error, {:operator_refused, "immutable_artifact_conflict"}} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation)

    unchanged!(f)
  end

  test "a manifest replaced before a lost journal commit completes only the journal on retry",
       f do
    {owner, observation} = sealed(f)
    # The owner's replace landed, then it died before the journal commit.
    File.write!(f.manifest, File.read!(f.candidate["path"]))

    assert {:ok, activated} = ReleaseActivation.activate(f.root, f.journal, owner, observation)
    assert activated["phase"] == "activated"
    assert File.read!(f.manifest) == File.read!(f.candidate["path"])
  end

  test "a retry after a lost journal commit still checks every staged artifact", f do
    {owner, observation} = sealed(f)
    File.write!(f.manifest, File.read!(f.candidate["path"]))
    [child] = Enum.filter(f.record["artifacts"], &(&1["kind"] == "log"))
    File.write!(child["path"], File.read!(child["path"]) <> "\n")

    assert {:error, {:operator_refused, "immutable_artifact_conflict"}} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation)

    assert {:ok, journal} = Journal.read(f.root)
    assert journal == f.journal
  end

  test "an ordinary journal commit can never write an activated record", f do
    other = Base.url_encode64(:crypto.hash(:sha256, "other-attempt"), padding: false)

    assert {:error, {:operator_refused, "stale_operator_intent"}} =
             Journal.compare_and_set(
               f.root,
               f.journal,
               %{f.record | "attempt" => other, "phase" => "activated"}
             )

    assert {:ok, journal} = Journal.read(f.root)
    assert journal == f.journal
  end

  test "an activated journal never activates twice", f do
    {owner, observation} = sealed(f)
    assert {:ok, _} = ReleaseActivation.activate(f.root, f.journal, owner, observation)
    {:ok, activated} = Journal.read(f.root)

    for expected <- [f.journal, activated] do
      assert {:error, _} = ReleaseActivation.activate(f.root, expected, owner, observation)
    end

    assert {:ok, ^activated} = Journal.read(f.root)
  end

  test "an ordinary journal commit can never move an attempt's phase", f do
    assert {:error, {:operator_refused, "stale_operator_intent"}} =
             Journal.compare_and_set(f.root, f.journal, Map.put(f.record, "phase", "activated"))

    {owner, observation} = sealed(f)
    assert {:ok, activated} = ReleaseActivation.activate(f.root, f.journal, owner, observation)
    {:ok, raw} = Journal.read(f.root)

    assert {:error, {:operator_refused, "stale_operator_intent"}} =
             Journal.compare_and_set(f.root, raw, Map.put(activated, "phase", "carrier_pending"))

    assert {:ok, ^raw} = Journal.read(f.root)
  end

  test "a release booted without the operator root never activates", f do
    {owner, observation} = sealed(f, nil, false)

    assert {:error, :release_boot_unguarded} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation)

    unchanged!(f)
  end

  test "a crash after the manifest replace reconciles the pending record at the next boot", f do
    sealed(f)
    # The owner's replace landed, then the whole carrier died before the
    # journal commit; the restarted release must not serve the candidate
    # under a record that still says carrier_pending.
    File.write!(f.manifest, File.read!(f.candidate["path"]))
    assert :ok = Application.stop(:lattice_carrier_server)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)

    assert Runtime.deployment().manifest_digest ==
             Base.decode16!(f.candidate["sha256"], case: :lower)

    assert {:ok, raw} = Journal.read(f.root)
    assert raw == Journal.encode(Map.put(f.record, "phase", "activated"))
  end

  test "a boot reconcile still checks every staged artifact and refuses to boot", f do
    sealed(f)
    File.write!(f.manifest, File.read!(f.candidate["path"]))
    File.write!(f.candidate["path"], File.read!(f.candidate["path"]) <> "\n")
    assert :ok = Application.stop(:lattice_carrier_server)
    assert {:error, _} = Application.ensure_all_started(:lattice_carrier_server)
    assert Runtime.deployment() == nil
    assert {:ok, journal} = Journal.read(f.root)
    assert journal == f.journal
  end

  test "a boot refuses while an activation holds the operator lock", f do
    sealed(f)
    assert :ok = Application.stop(:lattice_carrier_server)
    holder = hold_lock(f.root)

    assert {:error, _} = Application.ensure_all_started(:lattice_carrier_server)
    assert Runtime.deployment() == nil

    release_lock(holder)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
    assert Runtime.deployment().manifest_digest == :crypto.hash(:sha256, f.active_manifest)
  end

  test "an owner that starts after a restart refuses the old incarnation", f do
    {_owner, observation} = sealed(f)
    logs = Enum.map(observation.receipt.evidence.logs, &%{path: &1.path, sha256: &1.sha256})
    stale = Runtime.deployment().incarnation
    assert :ok = Application.stop(:lattice_carrier_server)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
    refute Runtime.deployment().incarnation == stale

    activated = Journal.encode(Map.put(f.record, "phase", "activated"))
    check = %{path: f.manifest, sha256: f.record["manifest_digest"]}

    assert {:error, {:operator_refused, "stale_operator_incarnation"}} =
             apply(Lock, :activate, [
               f.root,
               f.journal,
               f.request.attempt,
               check,
               logs,
               activated,
               stale
             ])

    unchanged!(f)
  end

  test "a boot whose loaded manifest was replaced under it refuses", f do
    {owner, observation} = sealed(f)
    assert {:ok, _} = ReleaseActivation.activate(f.root, f.journal, owner, observation)
    {:ok, activated} = Journal.read(f.root)

    assert {:error, {:operator_refused, "stale_operator_intent"}} =
             apply(Lock, :boot, [f.root, f.manifest, f.record["manifest_digest"]])

    assert {:ok, ^activated} = Journal.read(f.root)
  end

  test "an activated record over the pre-activation bytes refuses to boot", f do
    {owner, observation} = sealed(f)
    assert {:ok, _} = ReleaseActivation.activate(f.root, f.journal, owner, observation)
    assert :ok = Application.stop(:lattice_carrier_server)
    File.write!(f.manifest, f.active_manifest)

    assert {:error, _} = Application.ensure_all_started(:lattice_carrier_server)
    assert Runtime.deployment() == nil
  end

  defp hold_lock(root) do
    python = System.find_executable("python3")

    script =
      "import fcntl,os,sys\n" <>
        "fd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600)\n" <>
        "fcntl.flock(fd,fcntl.LOCK_EX)\nprint('held',flush=True)\nsys.stdin.readline()\n"

    port =
      Port.open({:spawn_executable, python}, [
        :binary,
        :exit_status,
        {:line, 64},
        args: ["-c", script, Path.join(root, "operator.lock")]
      ])

    assert_receive {^port, {:data, {:eol, "held"}}}, 5_000
    port
  end

  defp release_lock(port) do
    Port.command(port, "\n")
    assert_receive {^port, {:exit_status, 0}}, 5_000
  end

  defp drained(f, attempt \\ nil, guarded \\ true) do
    Application.put_env(:lattice_carrier_server, :manifest, f.manifest)

    if guarded,
      do: Application.put_env(:lattice_carrier_server, :operator_root, f.root),
      else: Application.delete_env(:lattice_carrier_server, :operator_root)

    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
    deployment = Runtime.deployment()
    {:ok, manifest} = Manifest.load(f.manifest)
    replicas = Map.new(manifest.instances, &{&1.name, Log.restore_verified(&1.log_file)})

    expected = %{
      manifest_path: deployment.manifest_path,
      manifest_digest: deployment.manifest_digest,
      instances:
        Enum.map(deployment.instances, fn instance ->
          {:ok, %{log: log}} = replicas[instance.name]
          instance |> Map.take([:name, :realm, :pub, :log_file]) |> Map.put(:replica, log.replica)
        end)
    }

    assert {:ok, receipt} = ReleaseQuiesce.drain(attempt || f.request.attempt, expected)
    {deployment.owner, receipt}
  end

  defp sealed(f, attempt \\ nil, guarded \\ true) do
    {owner, receipt} = drained(f, attempt, guarded)
    assert {:ok, observation} = ReleaseStopSeal.stop_and_seal(owner, receipt)
    {owner, observation}
  end

  defp unchanged!(f) do
    assert File.read!(f.manifest) == f.active_manifest
    assert {:ok, journal} = Journal.read(f.root)
    assert journal == f.journal
    assert File.read!(f.active_log) == f.active_bytes
  end

  defp nonce(value), do: Base.url_encode64(:crypto.hash(:sha256, value), padding: false)
end
