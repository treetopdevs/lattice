defmodule LatticeCarrierServer.Operator.ReleaseReadinessTest do
  use ExUnit.Case, async: false
  if :os.type() != {:unix, :linux}, do: @moduletag(skip: "Requires actual Linux OS lock")
  alias Lattice.{Identity, Log, Sim}
  alias LatticeCarrierServer.{Manifest, ProbeRealm, Runtime}

  alias LatticeCarrierServer.Operator.{
    Fixture,
    Journal,
    ReleaseActivation,
    ReleaseQuiesce,
    ReleaseReadiness,
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
    {:ok, record} = Staging.prepare(f.root, nil, f.request, f.artifacts, f.ceremony_dir)
    {:ok, journal} = Journal.read(f.root)

    probe = Path.join(f.root, "probe.identity")
    write_key(probe, :crypto.hash(:sha256, "operator-probe"))

    {:ok,
     Map.merge(f, %{
       record: record,
       journal: journal,
       manifest: f.request.active_manifest,
       probe: probe
     })}
  end

  test "an activated release confirmed after a full restart is recorded ready", f do
    activated = activated!(f)
    restart!()

    assert {:ok, ready} = ReleaseReadiness.confirm(f.root, activated, f.probe, f.ceremony_dir)
    assert ready == Map.put(f.record, "phase", "ready")
    assert {:ok, raw} = Journal.read(f.root)
    assert raw == Journal.encode(ready)
    assert String.ends_with?(File.read!(Journal.history_path(f.root)), activated <> "\n")
    no_grants!()
  end

  test "a restart after confirm with the same bytes boots and keeps ready", f do
    activated = activated!(f)
    restart!()
    assert {:ok, ready} = ReleaseReadiness.confirm(f.root, activated, f.probe, f.ceremony_dir)
    {:ok, raw} = Journal.read(f.root)

    restart!()
    assert {:ok, ^raw} = Journal.read(f.root)
    assert Jason.decode!(raw) == ready
    assert is_binary(Runtime.deployment().incarnation)
    # The record describes the activated bytes; a new boot does not confirm it again.
    assert {:error, :stale_operator_intent} =
             ReleaseReadiness.confirm(f.root, activated, f.probe, f.ceremony_dir)
  end

  test "an operator root other than the boot's refuses", f do
    activated = activated!(f)
    restart!()
    other = Path.join(Path.dirname(f.root), "other-root-#{System.unique_integer([:positive])}")
    File.mkdir_p!(other)
    File.chmod!(other, 0o700)
    on_exit(fn -> File.rm_rf(other) end)

    unchanged!(f, activated, fn ->
      assert {:error, :release_boot_unguarded} =
               ReleaseReadiness.confirm(other, activated, f.probe, f.ceremony_dir)
    end)
  end

  test "a release booted without an operator root refuses", f do
    activated = activated!(f)
    Application.stop(:lattice_carrier_server)
    Application.delete_env(:lattice_carrier_server, :operator_root)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
    assert Runtime.deployment().manifest_digest == digest(File.read!(f.manifest))
    refute Map.has_key?(Runtime.deployment(), :incarnation)

    unchanged!(f, activated, fn ->
      assert {:error, :release_boot_unguarded} =
               ReleaseReadiness.confirm(f.root, activated, f.probe, f.ceremony_dir)
    end)
  end

  test "a pending journal refuses as stale", f do
    boot!(f)

    unchanged!(f, f.journal, fn ->
      assert {:error, :stale_operator_intent} =
               ReleaseReadiness.confirm(f.root, f.journal, f.probe, f.ceremony_dir)
    end)
  end

  test "an expectation that is not the current journal refuses", f do
    activated = activated!(f)
    restart!()

    unchanged!(f, activated, fn ->
      for stale <- [nil, f.journal, activated <> " "] do
        assert {:error, :stale_operator_intent} =
                 ReleaseReadiness.confirm(f.root, stale, f.probe, f.ceremony_dir)
      end
    end)
  end

  test "a deployment that loaded other bytes than the activated candidate refuses", f do
    # Activation does not restart: this boot still serves the pre-activation manifest.
    activated = activated!(f)

    unchanged!(f, activated, fn ->
      assert {:error, :release_manifest_mismatch} =
               ReleaseReadiness.confirm(f.root, activated, f.probe, f.ceremony_dir)
    end)
  end

  test "a route that is not ready refuses", f do
    activated = activated!(f)
    restart!()
    File.write!(f.service_identity, String.duplicate("0", 63))

    unchanged!(f, activated, fn ->
      assert {:error, :route_not_ready} =
               ReleaseReadiness.confirm(f.root, activated, f.probe, f.ceremony_dir)
    end)
  end

  test "a Space member admitted after activation refuses as roster drift", f do
    activated = activated!(f)
    Application.stop(:lattice_carrier_server)
    late = Identity.from_seed("late", "operator-space:late")
    member = Base.encode64(late.pub)
    {space, invitation} = Sim.command(f.space, "creator", :issue_invitation, [member, []])
    acceptance = Treehouse.Invitation.accept(late, space.replica, invitation)

    {space, admission} =
      Sim.command(space, "creator", :admit_member, [invitation.id, member, "member", acceptance])

    refute Sim.quarantined(space, "creator", admission.id)
    :ok = Log.dump(Sim.log(space, "creator"), f.active_log)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)

    unchanged!(f, activated, fn ->
      assert {:error, :roster_drift_since_activation} =
               ReleaseReadiness.confirm(f.root, activated, f.probe, f.ceremony_dir)
    end)
  end

  test "a probe that cannot authenticate refuses and leaves no grant", f do
    activated = activated!(f)
    restart!()
    # A zero lifetime registers a grant that has already expired, so the
    # server finds none live to consume and the probe cannot authenticate.
    Application.put_env(:lattice_carrier_server, :probe_grant_ttl_ms, 0)
    on_exit(fn -> Application.delete_env(:lattice_carrier_server, :probe_grant_ttl_ms) end)

    unchanged!(f, activated, fn ->
      assert {:error, :readiness_pull_failed} =
               ReleaseReadiness.confirm(f.root, activated, f.probe, f.ceremony_dir)
    end)
  end

  test "a probe slot that is already granted refuses busy and keeps the other grant", f do
    activated = activated!(f)
    restart!()
    admitted = admitted!(f)
    other = Identity.from_seed("operator", "another-probe")
    {:ok, ref} = ProbeRealm.register(admitted.name, other.pub)

    unchanged!(
      f,
      activated,
      fn ->
        assert {:error, :readiness_probe_busy} =
                 ReleaseReadiness.confirm(f.root, activated, f.probe, f.ceremony_dir)
      end,
      [ref]
    )
  end

  test "an unusable probe key refuses before any grant exists", f do
    activated = activated!(f)
    restart!()
    missing = Path.join(f.root, "absent.identity")
    shared = Path.join(f.root, "shared.identity")
    write_key(shared, :crypto.hash(:sha256, "operator-probe"), 0o640)
    corrupt = Path.join(f.root, "corrupt.identity")
    File.write!(corrupt, "short")
    File.chmod!(corrupt, 0o600)

    unchanged!(f, activated, fn ->
      for path <- [missing, shared, corrupt] do
        assert {:error, :readiness_probe_key_unreadable} =
                 ReleaseReadiness.confirm(f.root, activated, path, f.ceremony_dir)
      end
    end)
  end

  test "a probe key shared with the service, child root or a member refuses reuse", f do
    activated = activated!(f)
    restart!()

    seeds = [
      :crypto.hash(:sha256, "child-service"),
      Sim.identity(f.child, "creator").priv,
      Sim.identity(f.space, "creator").priv
    ]

    unchanged!(f, activated, fn ->
      for {seed, index} <- Enum.with_index(seeds) do
        path = Path.join(f.root, "reused-#{index}.identity")
        write_key(path, seed)

        assert {:error, :readiness_probe_key_reused} =
                 ReleaseReadiness.confirm(f.root, activated, path, f.ceremony_dir)
      end
    end)
  end

  test "confirm probes both the Space route and the child route and leaves no grant", f do
    activated = activated!(f)
    restart!()
    Application.put_env(:lattice_carrier_server, :readiness_probe_observer, self())
    on_exit(fn -> Application.delete_env(:lattice_carrier_server, :readiness_probe_observer) end)

    assert {:ok, _} = ReleaseReadiness.confirm(f.root, activated, f.probe, f.ceremony_dir)
    assert_received {:readiness_probe, space_route}
    assert_received {:readiness_probe, child_route}
    assert Enum.sort([space_route, child_route]) == Enum.sort([f.space_route, f.child_route])
    refute_received {:readiness_probe, _}
    no_grants!()
  end

  test "a child route probed against another replica refuses as a failed pull", f do
    activated = activated!(f)
    restart!()
    target = target!(f, "thread", f.child_route)

    assert :ok = ReleaseReadiness.probe_route(target, f.probe)
    wrong = %{target | replica: Sim.log(f.space, "creator").replica}

    assert {:error, :readiness_pull_failed} = ReleaseReadiness.probe_route(wrong, f.probe)
    no_grants!()
    assert {:ok, ^activated} = Journal.read(f.root)
  end

  test "a ceremony binding a different service key refuses", f do
    activated = activated!(f)
    restart!()
    {:ok, other} = Fixture.new()
    other = Map.new(other)

    unchanged!(f, activated, fn ->
      assert {:error, reason} =
               ReleaseReadiness.confirm(f.root, activated, f.probe, other.ceremony_dir)

      assert is_atom(reason)
    end)
  end

  # --- helpers ---------------------------------------------------------------

  # Stage is done in setup; seal and activate this boot, as the activation tests do.
  defp activated!(f) do
    Application.put_env(:lattice_carrier_server, :manifest, f.manifest)
    Application.put_env(:lattice_carrier_server, :operator_root, f.root)
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

    assert {:ok, receipt} = ReleaseQuiesce.drain(f.request.attempt, expected)
    assert {:ok, observation} = ReleaseStopSeal.stop_and_seal(deployment.owner, receipt)

    assert {:ok, _} =
             ReleaseActivation.activate(
               f.root,
               f.journal,
               deployment.owner,
               observation,
               f.ceremony_dir
             )

    {:ok, activated} = Journal.read(f.root)
    activated
  end

  defp target!(f, name, route) do
    {:ok, manifest} = Manifest.load(f.manifest)
    instance = Enum.find(manifest.instances, &(&1.name == name))
    {:ok, %{log: log}} = Log.restore_verified(instance.log_file)

    %{
      name: name,
      route: route,
      realm: instance.realm,
      pub: instance.pub,
      replica: log.replica,
      genesis: for({id, %{kind: :authority, body: {:genesis, _, _}}} <- log.ops, do: id)
    }
  end

  defp boot!(f) do
    Application.put_env(:lattice_carrier_server, :manifest, f.manifest)
    Application.put_env(:lattice_carrier_server, :operator_root, f.root)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
  end

  defp restart! do
    assert :ok = Application.stop(:lattice_carrier_server)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
  end

  defp admitted!(f) do
    # Every Treehouse instance shares the bound service key; the admitted one
    # is the staged child, named "thread" by the fixture.
    {:ok, record} = f.journal |> Journal.decode()
    pub = Base.decode64!(record["service"]["pub"])
    Enum.find(Runtime.instance_views(), &(&1.name == "thread" and &1.pub == pub))
  end

  # The owner never ran: journal and history bytes are what they were, and
  # no probe grant outlives the call (except `keep`, a grant set up by the test).
  defp unchanged!(f, journal, fun, keep \\ []) do
    history = File.read(Journal.history_path(f.root))
    fun.()
    assert {:ok, ^journal} = Journal.read(f.root)
    assert File.read(Journal.history_path(f.root)) == history
    assert Enum.map(:ets.tab2list(ProbeRealm.table()), &elem(&1, 1)) == keep
  end

  defp no_grants!, do: assert(:ets.tab2list(ProbeRealm.table()) == [])

  defp write_key(path, seed, mode \\ 0o600) do
    File.write!(path, Base.encode16(seed, case: :lower))
    File.chmod!(path, mode)
  end

  defp digest(bytes), do: :crypto.hash(:sha256, bytes)
end
