defmodule LatticeCarrierServer.Operator.ReleaseActivationTest do
  use ExUnit.Case, async: false
  if :os.type() != {:unix, :linux}, do: @moduletag(skip: "Requires actual Linux OS lock")
  alias Lattice.{Identity, Log, Sim}
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

  setup context do
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
    f = if context[:unbound], do: unbind_active(f), else: f
    {:ok, record} = Staging.prepare(f.root, nil, f.request, f.artifacts, f.ceremony_dir)
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

    assert {:ok, activated} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    assert activated == Map.put(f.record, "phase", "activated")
    assert Journal.digest(File.read!(f.manifest)) == f.candidate["sha256"]
    assert File.read!(f.manifest) == File.read!(f.candidate["path"])
    assert Bitwise.band(File.stat!(f.manifest).mode, 0o7777) == 0o600
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

  @tag :unbound
  test "a migrated deployment, its Space instance moved to the bound values, activates", f do
    {:ok, sealed_manifest} = Manifest.load(f.manifest)
    [space] = sealed_manifest.instances
    refute space.realm == f.binding_realm
    {owner, observation} = sealed(f)

    assert {:ok, activated} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    assert activated["service"]["realm"] == f.binding_realm
    assert File.read!(f.manifest) == File.read!(f.candidate["path"])
    {:ok, served} = Manifest.load(f.manifest)
    assert Enum.all?(served.instances, &(&1.realm == f.binding_realm and &1.pub == f.service_pub))
    assert File.read!(f.active_log) == f.active_bytes
  end

  test "a service realm edited in the journal after staging refuses as a binding mismatch", f do
    edited = rewrite_service(f, &Map.put(&1, "realm", "edited-realm"))
    {owner, observation} = sealed(f)

    assert {:error, :service_binding_mismatch} =
             ReleaseActivation.activate(f.root, edited, owner, observation, f.ceremony_dir)

    unchanged!(%{f | journal: edited})
  end

  test "a service key edited in the journal after staging refuses as a binding mismatch", f do
    other = Base.encode64(Identity.from_seed("other", "edited-service").pub)
    edited = rewrite_service(f, &Map.put(&1, "pub", other))
    {owner, observation} = sealed(f)

    assert {:error, :service_binding_mismatch} =
             ReleaseActivation.activate(f.root, edited, owner, observation, f.ceremony_dir)

    unchanged!(%{f | journal: edited})
  end

  test "a ceremony directory that binds a different service refuses", f do
    {:ok, other} = Fixture.new()
    other = Map.new(other)
    {owner, observation} = sealed(f)

    assert {:error, :binding_not_in_served_log} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, other.ceremony_dir)

    unchanged!(f)
  end

  test "a missing ceremony directory refuses", f do
    {owner, observation} = sealed(f)
    missing = Path.join(f.root, "no-such-ceremony")

    assert {:error, reason} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, missing)

    assert is_atom(reason) and reason != :release_activation_refused
    unchanged!(f)
  end

  test "a Space member admitted after staging refuses as roster drift before the owner runs",
       f do
    # The staged review covered only the root member; the sealed Space log now
    # carries a second one, so neither the child grants nor the bootstrap
    # peers describe the roster the restarted release would serve.
    late = Identity.from_seed("late", "operator-space:late")
    member = Base.encode64(late.pub)
    {space, invitation} = Sim.command(f.space, "creator", :issue_invitation, [member, []])
    acceptance = Treehouse.Invitation.accept(late, space.replica, invitation)

    {space, admission} =
      Sim.command(space, "creator", :admit_member, [invitation.id, member, "member", acceptance])

    refute Sim.quarantined(space, "creator", admission.id)
    :ok = Log.dump(Sim.log(space, "creator"), f.active_log)
    {owner, observation} = sealed(f)

    assert {:error, :roster_drift_since_staging} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    assert File.read!(f.manifest) == f.active_manifest
    assert {:ok, journal} = Journal.read(f.root)
    assert journal == f.journal
    refute File.exists?(Journal.history_path(f.root))
  end

  test "activation keeps the replaced manifest's permission bits", f do
    File.chmod!(f.manifest, 0o644)
    {owner, observation} = sealed(f)

    assert {:ok, _} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    assert File.read!(f.manifest) == File.read!(f.candidate["path"])
    assert Bitwise.band(File.stat!(f.manifest).mode, 0o7777) == 0o644
  end

  test "activation appends the replaced pending journal to the operator history", f do
    {owner, observation} = sealed(f)

    assert {:ok, _} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    history = File.read!(Journal.history_path(f.root))
    assert String.ends_with?(history, f.journal <> "\n")
    assert Bitwise.band(File.stat!(Journal.history_path(f.root)).mode, 0o777) == 0o600
  end

  test "a drained but unsealed release refuses and writes nothing", f do
    {owner, receipt} = drained(f)

    assert {:error, :release_not_sealed} =
             ReleaseActivation.activate(f.root, f.journal, owner, receipt, f.ceremony_dir)

    unchanged!(f)
  end

  test "a seal taken for a different attempt refuses", f do
    {owner, observation} = sealed(f, nonce("another-attempt"))

    assert {:error, :release_attempt_mismatch} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    unchanged!(f)
  end

  test "an observation from a previous incarnation never activates", f do
    {owner, observation} = sealed(f)
    assert :ok = Application.stop(:lattice_carrier_server)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)

    for current <- [owner, Runtime.deployment().owner] do
      assert {:error, _} =
               ReleaseActivation.activate(f.root, f.journal, current, observation, f.ceremony_dir)
    end

    unchanged!(f)
  end

  test "a stale journal expectation refuses", f do
    {owner, observation} = sealed(f)

    assert {:error, :stale_operator_intent} =
             ReleaseActivation.activate(f.root, nil, owner, observation, f.ceremony_dir)

    unchanged!(f)
  end

  test "a service identity rewritten after staging refuses before the owner runs", f do
    {owner, observation} = sealed(f)
    identity = f.record["service"]["identity_file"]
    File.write!(identity, String.upcase(File.read!(identity)))

    assert {:error, :stale_operator_intent} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    unchanged!(f)
  end

  test "an existing route's identity rewritten after the seal refuses", f do
    {owner, observation} = sealed(f)
    # One identity file serves every Treehouse instance (OD-1), so rewriting it
    # is also the staged service identity changing: the journal digest refuses first.
    File.write!(f.service_identity, Base.encode16(:crypto.hash(:sha256, "rotated"), case: :lower))

    assert {:error, :stale_operator_intent} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    unchanged!(f)
  end

  test "an existing route log rewritten after the seal refuses", f do
    {owner, observation} = sealed(f)
    :ok = Log.dump(f.updated_log, f.active_log)

    assert {:error, :release_bytes_changed} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    assert File.read!(f.manifest) == f.active_manifest
    assert {:ok, journal} = Journal.read(f.root)
    assert journal == f.journal
  end

  test "an active manifest changed after the seal refuses", f do
    {owner, observation} = sealed(f)
    changed = f.active_manifest <> "\n"
    File.write!(f.manifest, changed)

    assert {:error, {:operator_refused, "stale_operator_intent"}} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

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
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

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
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    File.chmod!(f.root, 0o700)
    unchanged!(f)
    assert Path.wildcard(Path.join(f.root, ".active.json.activate.*"), match_dot: true) == []
  end

  test "a tampered staged candidate manifest refuses", f do
    {owner, observation} = sealed(f)
    File.write!(f.candidate["path"], File.read!(f.candidate["path"]) <> "\n")

    assert {:error, {:operator_refused, "immutable_artifact_conflict"}} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    unchanged!(f)
  end

  test "a tampered staged child log refuses before the manifest is replaced", f do
    {owner, observation} = sealed(f)
    [child] = Enum.filter(f.record["artifacts"], &(&1["kind"] == "log"))
    File.write!(child["path"], File.read!(child["path"]) <> "\n")

    assert {:error, {:operator_refused, "immutable_artifact_conflict"}} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    unchanged!(f)
  end

  test "a manifest replaced before a lost journal commit completes only the journal on retry",
       f do
    {owner, observation} = sealed(f)
    # The owner's replace landed, then it died before the journal commit.
    File.write!(f.manifest, File.read!(f.candidate["path"]))

    assert {:ok, activated} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    assert activated["phase"] == "activated"
    assert File.read!(f.manifest) == File.read!(f.candidate["path"])
  end

  test "a retry after a lost journal commit still checks every staged artifact", f do
    {owner, observation} = sealed(f)
    File.write!(f.manifest, File.read!(f.candidate["path"]))
    [child] = Enum.filter(f.record["artifacts"], &(&1["kind"] == "log"))
    File.write!(child["path"], File.read!(child["path"]) <> "\n")

    assert {:error, {:operator_refused, "immutable_artifact_conflict"}} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

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

    assert {:ok, _} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    {:ok, activated} = Journal.read(f.root)

    for expected <- [f.journal, activated] do
      assert {:error, _} =
               ReleaseActivation.activate(f.root, expected, owner, observation, f.ceremony_dir)
    end

    assert {:ok, ^activated} = Journal.read(f.root)
  end

  test "an ordinary journal commit can never move an attempt's phase", f do
    assert {:error, {:operator_refused, "stale_operator_intent"}} =
             Journal.compare_and_set(f.root, f.journal, Map.put(f.record, "phase", "activated"))

    {owner, observation} = sealed(f)

    assert {:ok, activated} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    {:ok, raw} = Journal.read(f.root)

    assert {:error, {:operator_refused, "stale_operator_intent"}} =
             Journal.compare_and_set(f.root, raw, Map.put(activated, "phase", "carrier_pending"))

    assert {:ok, ^raw} = Journal.read(f.root)
  end

  test "a release booted without the operator root never activates", f do
    {owner, observation} = sealed(f, nil, false)

    assert {:error, :release_boot_unguarded} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

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

    assert {:error, {:operator_refused, "operator_busy"}} =
             Lock.boot(f.root, f.manifest, f.record["manifest_digest"])

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

  test "a boot refuses a deployment file that aliases an operator file", f do
    for reserved <- ~w(operator-incarnation operator-journal-history.jsonl),
        field <- [:log_file, :identity_file] do
      Application.stop(:lattice_carrier_server)
      boot_refuses_alias!(f, reserved, field)
    end
  end

  test "a boot whose loaded manifest was replaced under it refuses", f do
    {owner, observation} = sealed(f)

    assert {:ok, _} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    {:ok, activated} = Journal.read(f.root)

    assert {:error, {:operator_refused, "stale_operator_intent"}} =
             apply(Lock, :boot, [f.root, f.manifest, f.record["manifest_digest"]])

    assert {:ok, ^activated} = Journal.read(f.root)
  end

  test "an activated record over the pre-activation bytes refuses to boot", f do
    {owner, observation} = sealed(f)

    assert {:ok, _} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    assert :ok = Application.stop(:lattice_carrier_server)
    File.write!(f.manifest, f.active_manifest)

    old_digest = Base.encode16(:crypto.hash(:sha256, f.active_manifest), case: :lower)

    assert {:error, {:operator_refused, "stale_operator_intent"}} =
             Lock.boot(f.root, f.manifest, old_digest)

    assert {:error, _} = Application.ensure_all_started(:lattice_carrier_server)
    assert Runtime.deployment() == nil
  end

  test "a boot over an already activated record with its candidate active serves it", f do
    {owner, observation} = sealed(f)

    assert {:ok, _} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    {:ok, activated} = Journal.read(f.root)
    stale = Runtime.deployment().incarnation
    assert :ok = Application.stop(:lattice_carrier_server)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)

    assert Runtime.deployment().manifest_digest ==
             Base.decode16!(f.candidate["sha256"], case: :lower)

    assert {:ok, ^activated} = Journal.read(f.root)
    assert is_binary(Runtime.deployment().incarnation)
    refute Runtime.deployment().incarnation == stale
  end

  test "a briefly held operator lock lets the boot succeed after a bounded retry", f do
    sealed(f)
    assert :ok = Application.stop(:lattice_carrier_server)
    holder = hold_lock(f.root)
    starter = Task.async(fn -> Application.ensure_all_started(:lattice_carrier_server) end)
    Process.sleep(1_500)
    refute Task.yield(starter, 0)
    release_lock(holder)

    assert {:ok, _} = Task.await(starter, 15_000)
    assert Runtime.deployment().manifest_digest == :crypto.hash(:sha256, f.active_manifest)
  end

  test "an activation root other than the boot's operator root never activates", f do
    {owner, observation} = sealed(f)
    other = Path.join(Path.dirname(f.root), "other-root-#{System.unique_integer([:positive])}")
    File.mkdir_p!(other)
    File.chmod!(other, 0o700)
    on_exit(fn -> File.rm_rf(other) end)

    assert {:error, :release_boot_unguarded} =
             ReleaseActivation.activate(other, f.journal, owner, observation, f.ceremony_dir)

    unchanged!(f)
  end

  test "a missing incarnation marker never activates", f do
    {owner, observation} = sealed(f)
    File.rm!(Path.join(f.root, "operator-incarnation"))

    assert {:error, {:operator_refused, "stale_operator_incarnation"}} =
             ReleaseActivation.activate(f.root, f.journal, owner, observation, f.ceremony_dir)

    unchanged!(f)
  end

  test "a malformed incarnation reply is refused, never trusted" do
    dir = Path.join(System.tmp_dir!(), "fake-py-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    stub = Path.join(dir, "python3")
    previous_path = System.get_env("PATH")
    on_exit(fn -> System.put_env("PATH", previous_path) end)

    replies = [
      ~s({"incarnation":"#{String.duplicate("g", 64)}"}),
      ~s({"incarnation":"#{String.duplicate("a", 64)}","x":1}),
      ~s({"incarnation":"#{String.duplicate("a", 63)}"})
    ]

    for reply <- replies do
      File.write!(stub, "#!/bin/sh\nread line\nprintf '%s\\n' '#{reply}'\n")
      File.chmod!(stub, 0o755)
      System.put_env("PATH", dir <> ":" <> previous_path)

      assert {:error, :invalid_operator_response} =
               Lock.boot(dir, Path.join(dir, "m.json"), String.duplicate("0", 64))
    end
  end

  defp boot_refuses_alias!(f, reserved, field) do
    {:ok, manifest} = Manifest.load(f.manifest)
    [instance | _] = manifest.instances

    # A relaying instance's preflight rewrites its log (breaking a hard link to
    # it) before the collision check runs, so this boot serves a relay-free copy
    # of the active manifest; the collision check is the same for both.
    boot_manifest = Path.join(f.root, "alias-active.json")

    File.write!(
      boot_manifest,
      f.manifest
      |> File.read!()
      |> Jason.decode!()
      |> Map.update!("instances", fn instances ->
        Enum.map(instances, &Map.delete(&1, "relay_realms"))
      end)
      |> Jason.encode!()
    )

    File.chmod!(boot_manifest, 0o600)

    alias_root =
      Path.join(Path.dirname(f.root), "alias-operator-root-#{System.unique_integer([:positive])}")

    File.mkdir_p!(alias_root)
    on_exit(fn -> File.rm_rf(alias_root) end)
    File.chmod!(alias_root, 0o700)
    target = Map.fetch!(instance, field)
    File.ln!(target, Path.join(alias_root, reserved))
    bytes = File.read!(target)

    Application.put_env(:lattice_carrier_server, :manifest, boot_manifest)
    Application.put_env(:lattice_carrier_server, :operator_root, alias_root)

    assert {:error, reason} = Application.ensure_all_started(:lattice_carrier_server)
    assert inspect(reason) =~ "operator_path_collision"
    assert File.read!(target) == bytes
  end

  # Rewrites the pending record's service fields on disk; the returned bytes are
  # the journal `expected` must then equal.
  defp rewrite_service(f, fun) do
    edited = Journal.encode(Map.update!(f.record, "service", fun))
    File.write!(Journal.path(f.root), edited)
    edited
  end

  # The pre-binding deployment: the active Space instance on a free realm with
  # its own identity file, no route, no relay set and only the root peer. The
  # request digest follows the rewritten active manifest.
  defp unbind_active(f) do
    old = Path.join(f.root, "old.identity")
    File.write!(old, Base.encode16(:crypto.hash(:sha256, "old-service"), case: :lower))
    File.chmod!(old, 0o600)

    manifest =
      f.request.active_manifest
      |> File.read!()
      |> Jason.decode!()
      |> Map.update!("instances", fn [space] ->
        [
          space
          |> Map.put("realm", "old-realm")
          |> Map.put("identity_file", old)
          |> Map.delete("route")
          |> Map.put("relay_realms", [])
          |> Map.update!("trusted_peers", &Enum.take(&1, 1))
        ]
      end)

    File.write!(f.request.active_manifest, Jason.encode!(manifest))
    digest = Journal.digest(File.read!(f.request.active_manifest))
    %{f | request: %{f.request | manifest_digest: digest}}
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
