defmodule LatticeCarrierServer.Operator.ReleaseListingTest do
  use ExUnit.Case, async: false
  if :os.type() != {:unix, :linux}, do: @moduletag(skip: "Requires actual Linux operator owner")

  alias Lattice.{Identity, Log, Op, Sim}
  alias Lattice.Carrier.{WebSocket, Wire}
  alias Lattice.Transport.WebSocket.Client
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

    with_probe(f, fn conn ->
      assert {:error, {:peer_error, "read_only"}} = WebSocket.push(conn, [f.reference])
    end)

    assert {:ok, listed} = ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
    assert listed["phase"] == "listed"
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
    snapshot = file_snapshot(f.active_log)
    assert {:ok, ^listed} = ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
    assert File.read!(Journal.history_path(f.root)) == history
    assert file_snapshot(f.active_log) == snapshot
    ActivationFixture.restart!()
    assert {:ok, ^listed} = ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
    assert_catalog_observed(f)
  end

  @tag :initial
  test "initial listing and exact retry never rewrite the already present Space reference", f do
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

  test "a stale intent or changed reference artifact cannot advance the journal", f do
    assert {:error, :stale_operator_intent} =
             ReleaseListing.publish(f.root, f.ready, f.ceremony_dir, f.probe)

    {:ok, record} = Journal.decode(f.catalogued)
    [reference] = Enum.filter(record["artifacts"], &(&1["kind"] == "reference"))
    File.write!(reference["path"], "{}")
    assert {:error, _} = ReleaseListing.publish(f.root, f.catalogued, f.ceremony_dir, f.probe)
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
