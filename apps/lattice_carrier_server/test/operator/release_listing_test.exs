defmodule LatticeCarrierServer.Operator.ReleaseListingTest do
  use ExUnit.Case, async: false
  if :os.type() != {:unix, :linux}, do: @moduletag(skip: "Requires actual Linux operator owner")

  alias Lattice.{Identity, Log, Op, Sim}
  alias Lattice.Carrier.WebSocket
  alias LatticeCarrierServer.{Holder, Listener, Manifest, ProbeRealm, Runtime}

  alias LatticeCarrierServer.Operator.{
    ActivationFixture,
    CatalogCli,
    CatalogStore,
    Journal,
    PublicationFixture,
    ReleaseListing,
    ReleaseReadiness
  }

  alias Treehouse.CatalogEntries

  setup context do
    PublicationFixture.catalogued(context)
  end

  test "the exact pending reference is delivered, served and receipted once", f do
    {:ok, %{log: before}} = Log.restore_verified(f.active_log)
    refute Map.has_key?(before.ops, f.reference.id)
    holder = GenServer.whereis(Holder.via(space_instance(f).name))
    assert {:ok, _} = Holder.subscribe(holder, self())

    with_probe(f, fn conn ->
      assert {:error, {:peer_error, "read_only"}} = WebSocket.push(conn, [f.reference])
    end)

    assert {:ok, listed} = ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
    assert listed["phase"] == "listed"
    {:ok, %{log: delivered}} = Log.restore_verified(f.active_log)
    assert Log.size(delivered) == Log.size(before) + 1
    assert_receive {:lattice_carrier_ops_available, ^holder, %{generation: next_generation}}
    {:ok, _} = Holder.acknowledge(holder, self(), next_generation)
    {:ok, raw} = Journal.read(f.root)
    assert Journal.encode(listed) == raw
    assert {:ok, store} = CatalogStore.verify(f.root, f.binding.record.catalog_key)
    assert store.head == listed["catalog_head"]

    with_probe(f, fn conn ->
      assert {:ok, ops, _} = WebSocket.pull(conn, MapSet.new())
      assert Enum.find(ops, &(&1.id == f.reference.id)) == f.reference
    end)

    assert_catalog_observed(f)
    history = File.read!(Journal.history_path(f.root))
    File.touch!(f.active_log, 1_600_000_000)
    snapshot = file_snapshot(f.active_log)
    assert {:ok, ^listed} = ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
    assert File.read!(Journal.history_path(f.root)) == history
    assert file_snapshot(f.active_log) == snapshot
    refute_receive {:lattice_carrier_ops_available, ^holder, _}, 50
    ActivationFixture.restart!()
    assert {:ok, ^listed} = ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
    assert_catalog_observed(f)
  end

  @tag :initial
  test "initial listing and exact retry never rewrite the already present Space reference", f do
    File.touch!(f.active_log, 1_600_000_000)
    snapshot = file_snapshot(f.active_log)
    assert {:ok, listed} = ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
    assert file_snapshot(f.active_log) == snapshot
    assert {:ok, ^listed} = ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
    assert file_snapshot(f.active_log) == snapshot
    ActivationFixture.restart!()
    assert File.read!(f.active_log) == elem(snapshot, 0)
    snapshot = file_snapshot(f.active_log)
    assert {:ok, ^listed} = ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
    assert file_snapshot(f.active_log) == snapshot
    assert_catalog_observed(f)
  end

  test "listed retry refuses a stale running operator incarnation without writes", f do
    assert {:ok, _} = ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
    before = file_snapshot(f.active_log)
    journal = elem(Journal.read(f.root), 1)
    history = File.read!(Journal.history_path(f.root))
    File.write!(Path.join(f.root, "operator-incarnation"), Journal.digest("later-boot"))

    assert {:error, :stale_operator_incarnation} =
             ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)

    assert file_snapshot(f.active_log) == before
    assert elem(Journal.read(f.root), 1) == journal
    assert File.read!(Journal.history_path(f.root)) == history
  end

  test "a stale intent or changed reference artifact cannot advance the journal", f do
    assert {:error, :stale_operator_intent} =
             ReleaseListing.publish(f.root, f.ready, f.ceremony_dir, f.probe)

    {:ok, record} = Journal.decode(f.catalogued)
    [reference] = Enum.filter(record["artifacts"], &(&1["kind"] == "reference"))
    File.write!(reference["path"], "{}")

    assert {:error, :catalog_reference_mismatch} =
             ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)

    assert {:ok, f.catalogued} == Journal.read(f.root)
    {:ok, %{log: space}} = Log.restore_verified(f.active_log)
    refute Map.has_key?(space.ops, f.reference.id)
  end

  test "closed local command data lists the pending reference and rejects signing options", f do
    assert_cli(f)
  end

  @tag :initial
  test "closed local command data lists an initial reference without rewriting it", f do
    before = file_snapshot(f.active_log)
    assert_cli(f)
    assert file_snapshot(f.active_log) == before
  end

  @tag :initial
  test "an additional honored initial reference refuses with a named competition reason", f do
    owner = Sim.identity(f.space, "creator")

    competing =
      Op.new(
        owner,
        f.reference.replica,
        f.reference.deps,
        :command,
        {:create_thread, [f.child.replica, "Competing"]},
        cap: f.reference.cap
      )

    relay_ops(f, [competing])

    assert {:error, :initial_reference_competing} =
             ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)

    assert {:ok, f.catalogued} == Journal.read(f.root)
  end

  test "a roster change between review and courier rejects the stale snapshot", f do
    previous = Application.get_env(:lattice_carrier_server, :listing_courier_hook)

    Application.put_env(:lattice_carrier_server, :listing_courier_hook, fn _ ->
      relay_ops(f, roster_change(f))
    end)

    on_exit(fn -> restore_env(:listing_courier_hook, previous) end)

    assert {:error, :stale_served_history} =
             ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)

    assert {:ok, f.catalogued} == Journal.read(f.root)
    {:ok, %{log: space}} = Log.restore_verified(f.active_log)
    refute Map.has_key?(space.ops, f.reference.id)
  end

  test "roster drift after delivery preserves the authentic reference without a receipt", f do
    instance = space_instance(f)
    key = {__MODULE__, :post_delivery_probe}
    previous = Application.get_env(:lattice_carrier_server, :readiness_probe_hook)

    Application.put_env(:lattice_carrier_server, :readiness_probe_hook, fn route ->
      if route == instance.route do
        count = Process.get(key, 0) + 1
        Process.put(key, count)
        if count == 2, do: relay_ops(f, roster_change(f))
      end
    end)

    on_exit(fn -> restore_env(:readiness_probe_hook, previous) end)

    assert {:error, :roster_drift_since_catalog} =
             ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)

    assert {:ok, f.catalogued} == Journal.read(f.root)
    {:ok, %{log: space}} = Log.restore_verified(f.active_log)
    assert space.ops[f.reference.id] == f.reference

    assert {:error, :roster_drift_since_catalog} =
             ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
  end

  test "concurrent listings converge on one reference and one receipt with exact retry", f do
    before = File.read!(Journal.history_path(f.root))

    tasks =
      for _ <- 1..2,
          do:
            Task.async(fn ->
              ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
            end)

    for task <- tasks do
      case Task.await(task, 30_000) do
        {:ok, %{"phase" => "listed"}} ->
          :ok

        {:error, reason} ->
          assert reason in [
                   :operator_busy,
                   :stale_operator_intent,
                   :stale_served_history,
                   :readiness_probe_busy,
                   :served_history_changed
                 ]
      end
    end

    assert {:ok, %{"phase" => "listed"}} =
             ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)

    after_history = File.read!(Journal.history_path(f.root))

    assert length(String.split(after_history, "\n", trim: true)) ==
             length(String.split(before, "\n", trim: true)) + 1

    {:ok, %{log: space}} = Log.restore_verified(f.active_log)
    assert space.ops[f.reference.id] == f.reference
  end

  test "a signed revocation concurrent with the reference refuses without roster drift", f do
    owner = Sim.identity(f.space, "creator")

    revoke =
      Op.new(
        owner,
        f.reference.replica,
        Log.frontier(Sim.log(f.space, "creator")),
        :authority,
        {:revoke, f.reference.cap}
      )

    relay_ops(f, [revoke])
    {:ok, %{log: space}} = Log.restore_verified(f.active_log)
    {:ok, proposed} = Log.accept(space, f.reference)

    assert Map.has_key?(
             Lattice.Authority.analyze(Treehouse.Space, proposed).reasons,
             f.reference.id
           )

    assert {:error, :reference_not_honored} =
             ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)

    assert {:ok, f.catalogued} == Journal.read(f.root)
    {:ok, %{log: space}} = Log.restore_verified(f.active_log)
    refute Map.has_key?(space.ops, f.reference.id)
  end

  test "an ambiguous courier call reports unknown outcome and exact retry remains safe", f do
    instance = space_instance(f)
    holder = Holder.via(instance.name)
    previous = Application.get_env(:lattice_carrier_server, :listing_courier_hook)

    Application.put_env(:lattice_carrier_server, :listing_courier_hook, fn _ ->
      :sys.suspend(holder)
    end)

    try do
      assert {:error, :courier_outcome_unknown} =
               ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)

      assert {:ok, f.catalogued} == Journal.read(f.root)
    after
      restore_env(:listing_courier_hook, previous)
      :sys.resume(holder)
    end

    assert {:ok, %{"phase" => "listed"}} =
             ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)

    {:ok, %{log: space}} = Log.restore_verified(f.active_log)
    assert space.ops[f.reference.id] == f.reference
  end

  test "an extra disk frame cannot be overwritten by the courier", f do
    disk_drift!(f, :disk_history_diverged)
  end

  @tag :initial
  test "initial presence retry refuses memory/disk drift without rewriting it", f do
    disk_drift!(f, :served_history_changed)
  end

  test "actual caller death after delivery recovers the original intent", f do
    instance = space_instance(f)
    previous = Application.get_env(:lattice_carrier_server, :readiness_probe_hook)
    observer = self()

    Application.put_env(:lattice_carrier_server, :readiness_probe_hook, fn route ->
      if route == instance.route do
        count = Process.get(:caller_death_probe, 0) + 1
        Process.put(:caller_death_probe, count)
        if count == 2, do: Process.exit(self(), :kill)
      end
    end)

    {pid, monitor} =
      spawn_monitor(fn ->
        send(
          observer,
          {:unexpected_listing_result,
           ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)}
        )
      end)

    try do
      assert_receive {:DOWN, ^monitor, :process, ^pid, :killed}, 10_000
    after
      restore_env(:readiness_probe_hook, previous)
    end

    assert {:ok, f.catalogued} == Journal.read(f.root)
    {:ok, %{log: space}} = Log.restore_verified(f.active_log)
    assert space.ops[f.reference.id] == f.reference
    snapshot = file_snapshot(f.active_log)

    assert {:error, :readiness_probe_busy} =
             ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)

    await_probe_expiry(instance.name, System.monotonic_time(:millisecond) + 11_000)

    assert {:ok, %{"phase" => "listed"}} =
             ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)

    assert file_snapshot(f.active_log) == snapshot
  end

  for stage <- ["before_journal", "journal", "reply"] do
    test "actual mutation owner death at #{stage} recovers with one receipt", f do
      owner_crash!(f, unquote(stage))
    end
  end

  @tag :initial
  test "initial owner death before acknowledgement never rewrites Space", f do
    File.touch!(f.active_log, 1_600_000_000)
    snapshot = file_snapshot(f.active_log)
    owner_crash!(f, "reply")
    assert file_snapshot(f.active_log) == snapshot
  end

  test "a second real listing carries the first reference and both histories", f do
    {:ok, first} = ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
    {:ok, expected} = Journal.read(f.root)
    next = PublicationFixture.next_ready(f, expected, first["catalog_head"], 2)
    {:ok, next} = PublicationFixture.catalogued_ready(next)
    assert length(next.catalog.entries) == 3

    assert {:ok, %{"phase" => "listed"}} =
             ReleaseListing.publish(next.root, next.catalogued, next.ceremony_dir, next.probe)

    {:ok, %{log: space}} = Log.restore_verified(f.active_log)
    assert space.ops[f.reference.id] == f.reference
    assert space.ops[next.reference.id] == next.reference
    assert_catalog_observed(next)
  end

  test "a carried creation made unhonored blocks the new listing", f do
    next = next_catalogue!(f)
    old_entry = Enum.find(f.catalog.entries, &(&1.kind == :thread))

    instance =
      Enum.find(loaded_instances(), fn instance ->
        {:ok, %{log: log}} = Log.restore_verified(instance.log_file)
        log.replica == old_entry.replica
      end)

    {:ok, %{log: old_log}} = Log.restore_verified(instance.log_file)
    owner = Sim.identity(f.child, "creator")
    creation = old_log.ops[old_entry.creation]

    revoke =
      Op.new(owner, old_log.replica, [old_entry.genesis], :authority, {:revoke, creation.cap})

    {realm, _} = Enum.find(instance.trusted_peers, fn {_realm, pub} -> pub == owner.pub end)
    assert {:ok, _} = Holder.relay(Holder.via(instance.name), realm, revoke)
    {:ok, %{log: changed}} = Log.restore_verified(instance.log_file)
    assert :ok = Log.verify_authenticity(changed)
    assert Map.has_key?(Lattice.Authority.analyze(Treehouse.Thread, changed).reasons, creation.id)

    assert {:error, :catalog_carried_entry_lapsed} =
             ReleaseListing.publish(next.root, next.catalogued, next.ceremony_dir, next.probe)

    assert {:ok, next.catalogued} == Journal.read(next.root)
    {:ok, %{log: space}} = Log.restore_verified(next.active_log)
    refute Map.has_key?(space.ops, next.reference.id)
  end

  test "an unavailable carried route refuses without publishing the new reference", f do
    next = next_catalogue!(f)
    old_entry = Enum.find(f.catalog.entries, &(&1.kind == :thread))

    instance =
      Enum.find(loaded_instances(), fn instance ->
        {:ok, %{log: log}} = Log.restore_verified(instance.log_file)
        log.replica == old_entry.replica
      end)

    assert :ok = :ranch.suspend_listener(Listener.ref(instance.name))

    assert {:error, _} =
             ReleaseListing.publish(next.root, next.catalogued, next.ceremony_dir, next.probe)

    assert {:ok, next.catalogued} == Journal.read(next.root)
    {:ok, %{log: space}} = Log.restore_verified(next.active_log)
    refute Map.has_key?(space.ops, next.reference.id)
  end

  defp next_catalogue!(f) do
    {:ok, first} = ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
    {:ok, expected} = Journal.read(f.root)
    next = PublicationFixture.next_ready(f, expected, first["catalog_head"], 2)
    {:ok, next} = PublicationFixture.catalogued_ready(next)
    next
  end

  defp loaded_instances do
    {:ok, manifest} = Manifest.load(Runtime.deployment().manifest_path)
    manifest.instances
  end

  @tag timeout: 120_000
  test "an over-budget child refuses before publishing the Space reference", f do
    {:ok, manifest} = Manifest.load(Runtime.deployment().manifest_path)
    child = Enum.find(manifest.instances, &(&1.log_file != f.active_log))
    :ok = Application.stop(:lattice_carrier_server)
    {:ok, %{log: log}} = Log.restore_verified(child.log_file)
    owner = Sim.identity(f.child, "creator")
    {:ok, record} = Journal.decode(f.catalogued)
    artifact = Enum.find(record["artifacts"], &(&1["kind"] == "log"))
    creation = log.ops[artifact["review"]["creation"]]
    deps = Log.frontier(log)
    count = 4_001 - Log.size(log)

    grown =
      Enum.reduce(1..count, log, fn number, current ->
        op =
          Op.new(owner, log.replica, deps, :command, {:post, ["budget #{number}"]},
            cap: creation.cap
          )

        Log.append!(current, op)
      end)

    assert :ok = Log.verify_authenticity(grown)
    assert :ok = Log.dump(grown, child.log_file)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
    before = file_snapshot(f.active_log)

    assert {:error, :courier_history_budget} =
             ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)

    assert file_snapshot(f.active_log) == before
    assert {:ok, f.catalogued} == Journal.read(f.root)
  end

  defp await_probe_expiry(instance, deadline) do
    if ProbeRealm.live_grant(instance) != nil do
      assert System.monotonic_time(:millisecond) < deadline,
             "dead caller's probe grant did not expire"

      Process.sleep(20)
      await_probe_expiry(instance, deadline)
    end
  end

  defp disk_drift!(f, expected_error) do
    previous = Application.get_env(:lattice_carrier_server, :listing_courier_hook)
    owner = Sim.identity(f.space, "creator")

    Application.put_env(:lattice_carrier_server, :listing_courier_hook, fn _ ->
      :ok =
        LatticeCarrierServer.Durability.with_target_lock(f.active_log, fn ->
          {:ok, %{log: current}} = Log.restore_verified(f.active_log)

          op =
            Op.new(
              owner,
              current.replica,
              Log.frontier(current),
              :command,
              {:set_title, ["Independent disk history"]},
              cap: f.reference.cap
            )

          :ok = Log.dump(Log.append!(current, op), f.active_log)
        end)

      Process.put(:disk_drift_bytes, File.read!(f.active_log))
    end)

    try do
      assert {:error, ^expected_error} =
               ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)

      assert File.read!(f.active_log) == Process.get(:disk_drift_bytes)
      assert {:ok, f.catalogued} == Journal.read(f.root)
      assert :ok = Holder.ready?(Holder.via(space_instance(f).name))
    after
      restore_env(:listing_courier_hook, previous)
    end
  end

  defp owner_crash!(f, stage) do
    previous = System.fetch_env!("PATH")
    python = System.find_executable("python3")
    helper = Path.expand("../../../../scripts/treehouse_operator_mutation.py", __DIR__)
    runner = Path.expand("../support/operator/catalog_mutation_fault_runner.py", __DIR__)
    bin = Path.join(f.root, "owner-fault-bin")
    File.mkdir!(bin)
    File.chmod!(bin, 0o700)
    wrapper = Path.join(bin, "python3")

    File.write!(wrapper, """
    #!#{python}
    import os, sys
    real = #{Jason.encode!(python)}
    target = [#{Jason.encode!(helper)}, #{Jason.encode!(f.root)}]
    if sys.argv[1:] == target:
        os.execv(real, [real, #{Jason.encode!(runner)}, *target, #{Jason.encode!(stage)}])
    os.execv(real, [real, *sys.argv[1:]])
    """)

    File.chmod!(wrapper, 0o700)
    System.put_env("PATH", bin <> ":" <> previous)

    try do
      assert {:error, :listing_outcome_unknown} =
               ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
    after
      System.put_env("PATH", previous)
    end

    {:ok, %{log: space}} = Log.restore_verified(f.active_log)
    assert space.ops[f.reference.id] == f.reference
    snapshot = file_snapshot(f.active_log)
    assert {:ok, listed} = ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
    assert listed["phase"] == "listed"
    assert file_snapshot(f.active_log) == snapshot
    history = File.read!(Journal.history_path(f.root))
    assert {:ok, ^listed} = ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
    assert File.read!(Journal.history_path(f.root)) == history
    assert file_snapshot(f.active_log) == snapshot
  end

  defp roster_change(f) do
    late = Identity.from_seed("late", "listing-late-member")
    member = Base.encode64(late.pub)
    {space, invitation} = Sim.command(f.space, "creator", :issue_invitation, [member, []])
    acceptance = Treehouse.Invitation.accept(late, space.replica, invitation)

    {_space, admission} =
      Sim.command(space, "creator", :admit_member, [invitation.id, member, "member", acceptance])

    [invitation, admission]
  end

  defp relay_ops(f, ops) do
    instance = space_instance(f)
    owner = Sim.identity(f.space, "creator")
    {realm, _} = Enum.find(instance.trusted_peers, fn {_realm, pub} -> pub == owner.pub end)
    for op <- ops, do: assert({:ok, _} = Holder.relay(Holder.via(instance.name), realm, op))
  end

  defp restore_env(key, nil), do: Application.delete_env(:lattice_carrier_server, key)
  defp restore_env(key, value), do: Application.put_env(:lattice_carrier_server, key, value)

  defp space_instance(f) do
    {:ok, manifest} = Manifest.load(Runtime.deployment().manifest_path)
    Enum.find(manifest.instances, &(&1.log_file == f.active_log))
  end

  defp with_member(f, fun) do
    instance = space_instance(f)
    owner = Sim.identity(f.space, "creator")
    {realm, _} = Enum.find(instance.trusted_peers, fn {_realm, pub} -> pub == owner.pub end)
    {ip, port} = :ranch.get_addr(Listener.ref(instance.name))

    {:ok, conn} =
      WebSocket.connect(
        hostname: ip |> :inet.ntoa() |> to_string(),
        port: port,
        identity: %{owner | realm_id: realm},
        realm: realm,
        path: instance.route,
        peer_realm: instance.realm,
        peer_pubkey: instance.pub,
        replica: f.catalog.space
      )

    try do
      fun.(conn)
    after
      WebSocket.close(conn)
    end
  end

  defp assert_cli(f) do
    intent = Path.join(f.root, "catalogued-intent.json")
    File.write!(intent, f.catalogued)

    args = [
      "list",
      "--root",
      f.root,
      "--expected",
      intent,
      "--ceremony",
      f.ceremony_dir,
      "--probe",
      f.probe
    ]

    ExUnit.CaptureIO.capture_io(:stderr, fn ->
      assert {:error, :invalid_catalog_options} = CatalogCli.run(args ++ ["--signer", "unread"])
      assert {:error, :invalid_catalog_options} = CatalogCli.run(args ++ ["--expected", intent])
    end)

    command = Path.join(f.root, "list-command.json")

    File.write!(
      command,
      Jason.encode!(%{"format" => "treehouse-catalog-command-v1", "args" => args})
    )

    output = ExUnit.CaptureIO.capture_io(fn -> assert :ok = CatalogCli.run_file(command) end)
    assert Jason.decode!(output)["phase"] == "listed"
    output = ExUnit.CaptureIO.capture_io(fn -> assert :ok = CatalogCli.run_file(command) end)
    assert Jason.decode!(output)["phase"] == "listed"
    assert {:ok, record} = Journal.read(f.root)
    {:ok, decoded} = Journal.decode(record)
    assert decoded["phase"] == "listed"
    # Even a semantically identical expected record is not the preserved raw intent.
    noncanonical = Jason.encode!(Jason.decode!(f.catalogued), pretty: true)

    assert {:error, :stale_operator_intent} =
             ReleaseListing.publish(f.root, noncanonical, f.ceremony_dir, f.probe)
  end

  defp assert_catalog_observed(f) do
    histories =
      Map.new(Runtime.deployment().instances, fn instance ->
        {:ok, %{log: log}} = Log.restore_verified(instance.log_file)
        {log.replica, log}
      end)

    assert {:ok, _} = CatalogEntries.observe(f.catalog, histories)
    {:ok, current} = Journal.read(f.root)
    assert {:ok, _} = ReleaseReadiness.review(f.root, current, f.probe, f.ceremony_dir, "listed")
  end

  defp file_snapshot(path) do
    stat = File.stat!(path, time: :posix)
    {File.read!(path), stat.inode, stat.mtime}
  end

  defp with_probe(f, fun) do
    {:ok, manifest} = Manifest.load(Runtime.deployment().manifest_path)
    instance = Enum.find(manifest.instances, &(&1.log_file == f.active_log))
    {:ok, secret, pub} = Manifest.read_identity_file(f.probe, ProbeRealm.realm())
    {:ok, grant} = ProbeRealm.register(instance.name, pub)
    {ip, port} = :ranch.get_addr(Listener.ref(instance.name))

    try do
      {:ok, conn} =
        WebSocket.connect(
          hostname: ip |> :inet.ntoa() |> to_string(),
          port: port,
          identity: LatticeCarrierServer.Secret.unwrap(secret),
          realm: ProbeRealm.realm(),
          path: instance.route,
          peer_realm: instance.realm,
          peer_pubkey: instance.pub,
          replica: f.catalog.space
        )

      try do
        fun.(conn)
      after
        WebSocket.close(conn)
      end
    after
      ProbeRealm.revoke(instance.name, grant)
    end
  end
end
