defmodule LatticeCarrierServer.Operator.ReleaseRuntimeTest do
  use ExUnit.Case, async: false
  alias Lattice.{Identity, Log, Op}
  alias LatticeCarrierServer.{Holder, Listener, Runtime}
  alias LatticeCarrierServer.Operator.{ReleaseGate, ReleaseQuiesce}

  defmodule GatedSync do
    def sync_file(path) do
      case :persistent_term.get({__MODULE__, :observer}, nil) do
        nil ->
          :ok

        observer ->
          send(observer, {:sync_entered, self()})

          receive do
            :continue_sync -> :ok
          end
      end

      LatticeCarrierServer.Durability.Posix.sync_file(path)
    end

    def rename(from, to), do: File.rename(from, to)
    def sync_directory(path), do: LatticeCarrierServer.Durability.Posix.sync_directory(path)
  end

  setup do
    previous = Application.get_env(:lattice_carrier_server, :manifest)
    previous_server = Application.get_env(:lattice_carrier_server, :server_options)
    Application.stop(:lattice_carrier_server)

    on_exit(fn ->
      :persistent_term.erase({GatedSync, :observer})
      Application.stop(:lattice_carrier_server)

      if previous,
        do: Application.put_env(:lattice_carrier_server, :manifest, previous),
        else: Application.delete_env(:lattice_carrier_server, :manifest)

      if previous_server,
        do: Application.put_env(:lattice_carrier_server, :server_options, previous_server),
        else: Application.delete_env(:lattice_carrier_server, :server_options)

      Application.ensure_all_started(:lattice_carrier_server)
    end)

    :ok
  end

  @tag :tmp_dir
  test "owned runtime drains exact logs, retry is identical, subsequent relay and inner bind refuse",
       %{tmp_dir: dir} do
    f = boot(dir)
    before = File.read!(f.path)
    assert {:ok, receipt} = ReleaseQuiesce.drain(f.attempt, f.expected)
    assert ReleaseGate.valid?(f.owner, receipt)
    assert {:ok, ^receipt} = ReleaseQuiesce.drain(f.attempt, f.expected)
    assert :suspended = :ranch.get_status(Listener.ref(f.name))
    assert {:error, :release_closed} = Holder.relay(f.holder, "relay", f.op)
    assert File.read!(f.path) == before
    # Actual Ranch resume restarts its acceptor supervisor and calls listen/1.
    assert {:error, _} = :ranch.resume_listener(Listener.ref(f.name))
    assert {:error, _} = ReleaseQuiesce.drain(nonce("different"), f.expected)
    assert File.read!(f.path) == before
  end

  @tag :tmp_dir
  test "no Ranch resume path reopens accepts on a drained listener", %{tmp_dir: dir} do
    f = boot(dir)
    port = LatticeCarrierServer.port(f.name)
    assert {:ok, _receipt} = ReleaseQuiesce.drain(f.attempt, f.expected)
    # Suspension terminates the acceptors supervisor that owns the listen
    # socket; every restart of it goes back through the gated listen/1.
    assert {:error, _} = :ranch.resume_listener(Listener.ref(f.name))
    # Ranch's global acceptor restart finds no acceptors supervisor under a
    # suspended listener and fails its own match rather than reopening it.
    assert_raise MatchError, fn -> :ranch.restart_all_acceptors() end
    assert :suspended = :ranch.get_status(Listener.ref(f.name))

    assert {:error, :econnrefused} =
             :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], 1_000)
  end

  @tag :tmp_dir
  test "the deployment digest is the digest of the exact manifest bytes parsed", %{tmp_dir: dir} do
    f = boot(dir)
    manifest = Application.get_env(:lattice_carrier_server, :manifest)
    assert {:ok, loaded} = LatticeCarrierServer.Manifest.load(manifest)
    assert loaded.sha256 == :crypto.hash(:sha256, File.read!(manifest))
    assert Runtime.deployment().manifest_digest == loaded.sha256
    assert f.expected.manifest_digest == loaded.sha256
  end

  @tag :tmp_dir
  test "a refused manifest preflight returns its structured reason from start", %{tmp_dir: dir} do
    manifest = Path.join(dir, "manifest.json")
    File.write!(manifest, "{not json")
    File.chmod!(manifest, 0o600)
    Application.put_env(:lattice_carrier_server, :manifest, manifest)

    assert {:error, {:lattice_carrier_server, {{:invalid_manifest, :manifest_corrupt}, _}}} =
             Application.ensure_all_started(:lattice_carrier_server)
  end

  @tag :tmp_dir
  test "accepted relay remains in sync worker until drain can capture its durable reply", %{
    tmp_dir: dir
  } do
    f = boot(dir)
    :persistent_term.put({GatedSync, :observer}, self())
    :sys.replace_state(f.holder, &Map.put(&1, :durability, GatedSync))
    relay = Task.async(fn -> Holder.relay(f.holder, "relay", f.op) end)
    assert_receive {:sync_entered, worker}, 2_000
    drain = Task.async(fn -> ReleaseQuiesce.drain(f.attempt, f.expected) end)
    assert Task.yield(drain, 30) == nil
    send(worker, :continue_sync)
    assert {:ok, %{accepted: [_]}} = Task.await(relay)
    assert {:ok, receipt} = Task.await(drain)
    assert ReleaseGate.valid?(f.owner, receipt)
    assert {:ok, %{log: restored, sha256: digest}} = Log.restore_verified(f.path)
    assert f.op.id in Log.op_ids(restored)
    assert [%{sha256: ^digest}] = receipt.evidence.logs
  end

  @tag :tmp_dir
  test "post-receipt Holder crash cannot rehearse or restart", %{tmp_dir: dir} do
    f = boot(dir)
    assert {:ok, receipt} = ReleaseQuiesce.drain(f.attempt, f.expected)
    bytes = File.read!(f.path)
    monitor = Process.monitor(f.holder)
    Process.exit(f.holder, :kill)
    assert_receive {:DOWN, ^monitor, :process, _, _}
    refute ReleaseGate.valid?(f.owner, receipt)
    assert {:error, :release_closed} = Runtime.start_instance(f.name)
    assert File.read!(f.path) == bytes
  end

  @tag :tmp_dir
  test "gate crash tears down the owned routes and cannot restore accepting incarnation", %{
    tmp_dir: dir
  } do
    f = boot(dir)
    assert {:ok, receipt} = ReleaseQuiesce.drain(f.attempt, f.expected)
    monitor = Process.monitor(f.holder)
    {gate, _} = f.owner
    Process.exit(gate, :kill)
    assert_receive {:DOWN, ^monitor, :process, _, _}, 3_000
    refute ReleaseGate.valid?(f.owner, receipt)
    refute ReleaseGate.accepting?(f.owner)
  end

  @tag :tmp_dir
  test "a stray message does not crash an accepting gate", %{tmp_dir: dir} do
    f = boot(dir)
    {gate, _} = f.owner
    send(gate, :unexpected)
    assert ReleaseGate.accepting?(f.owner)
    assert Process.alive?(gate)
  end

  @tag :tmp_dir
  test "a gate crash before any close restarts the routes under a fresh accepting incarnation",
       %{tmp_dir: dir} do
    f = boot(dir)
    monitor = Process.monitor(f.holder)
    {gate, _} = f.owner
    Process.exit(gate, :kill)
    assert_receive {:DOWN, ^monitor, :process, _, _}, 3_000

    # The deployment names the new owner before its routes finish starting;
    # wait until the restarted route actually serves before draining.
    current =
      eventually(fn ->
        owner = Runtime.deployment().owner
        holder = GenServer.whereis(Holder.via(f.name))

        owner != f.owner and is_pid(holder) and holder != f.holder and
          :ranch.get_status(Listener.ref(f.name)) == :running and owner
      end)

    refute ReleaseGate.accepting?(f.owner)
    assert ReleaseGate.accepting?(current)
    assert {:ok, receipt} = ReleaseQuiesce.drain(f.attempt, f.expected)
    assert ReleaseGate.valid?(current, receipt)
  end

  @tag :tmp_dir
  test "a gate crash after close began never reopens admission", %{tmp_dir: dir} do
    f = boot(dir)
    assert {:ok, _} = ReleaseGate.close(f.owner, f.attempt, f.expected)
    assert_gate_crash_stays_closed(f)
  end

  @tag :tmp_dir
  test "a gate crash after an accepting-phase invalidation never reopens admission", %{
    tmp_dir: dir
  } do
    f = boot(dir)
    assert {:error, :release_closed} = ReleaseGate.finish(f.owner, make_ref())
    refute ReleaseGate.accepting?(f.owner)
    assert_gate_crash_stays_closed(f)
  end

  defp assert_gate_crash_stays_closed(f) do
    monitor = Process.monitor(f.holder)
    {gate, _} = f.owner
    Process.exit(gate, :kill)
    assert_receive {:DOWN, ^monitor, :process, _, _}, 3_000
    # Whatever replacement the supervisor manages to start must not accept;
    # failing to start at all is equally closed.
    Process.sleep(200)

    case Process.whereis(ReleaseGate) do
      nil -> :ok
      _pid -> refute ReleaseGate.accepting?(ReleaseGate.owner())
    end

    holder =
      Process.whereis(LatticeCarrierServer.Registry) &&
        GenServer.whereis(Holder.via(f.name))

    if is_pid(holder),
      do: assert({:error, :release_closed} = Holder.relay(holder, "relay", f.op))
  end

  # Restarted processes and Ranch registrations appear asynchronously; a probe
  # that raises or exits before they exist counts as "not yet". The last
  # failure is reported if the condition never holds.
  defp eventually(fun, attempts \\ 50, last \\ nil) do
    {value, last} =
      try do
        {fun.(), last}
      catch
        kind, reason -> {nil, Exception.format(kind, reason)}
      end

    cond do
      value not in [nil, false] ->
        value

      attempts > 0 ->
        Process.sleep(50)
        eventually(fun, attempts - 1, last)

      true ->
        flunk("condition never held; last probe failure: #{last || "none"}")
    end
  end

  @tag :tmp_dir
  test "wrong manifest or route inventory refuses without changing journal or log", %{
    tmp_dir: dir
  } do
    f = boot(dir)
    before = File.read!(f.path)

    [instance] = f.expected.instances

    for expected <- [
          %{f.expected | instances: [%{instance | log_file: instance.log_file <> "-wrong"}]},
          %{f.expected | instances: [%{instance | pub: <<0::256>>}]},
          Map.put(f.expected, :manifest_digest, <<0::256>>),
          Map.put(f.expected, :instances, []),
          Map.put(f.expected, :instances, f.expected.instances ++ f.expected.instances)
        ] do
      assert {:error, _} = ReleaseQuiesce.drain(f.attempt, expected)
    end

    assert ReleaseGate.accepting?(f.owner)
    assert File.read!(f.path) == before
    refute File.exists?(Path.join(dir, "operator-journal.json"))
  end

  @tag :tmp_dir
  test "timeout keeps admission closed and same attempt can finish after actual worker drains", %{
    tmp_dir: dir
  } do
    f = boot(dir)
    :persistent_term.put({GatedSync, :observer}, self())
    :sys.replace_state(f.holder, &Map.put(&1, :durability, GatedSync))
    relay = Task.async(fn -> Holder.relay(f.holder, "relay", f.op) end)
    assert_receive {:sync_entered, worker}, 2_000
    assert {:error, _} = ReleaseQuiesce.drain(f.attempt, f.expected, 20)
    refute ReleaseGate.accepting?(f.owner)
    send(worker, :continue_sync)
    assert {:ok, _} = Task.await(relay)
    assert {:ok, receipt} = ReleaseQuiesce.drain(f.attempt, f.expected)
    assert ReleaseGate.valid?(f.owner, receipt)
  end

  @tag :tmp_dir
  test "Holder identity loss during capture suppresses receipt and cannot stand in for worker drain",
       %{tmp_dir: dir} do
    f = boot(dir)
    :persistent_term.put({GatedSync, :observer}, self())
    :sys.replace_state(f.holder, &Map.put(&1, :durability, GatedSync))

    relay =
      Task.async(fn ->
        try do
          Holder.relay(f.holder, "relay", f.op)
        catch
          :exit, _ -> :holder_lost
        end
      end)

    assert_receive {:sync_entered, worker}, 2_000
    worker_monitor = Process.monitor(worker)
    drain = Task.async(fn -> ReleaseQuiesce.drain(f.attempt, f.expected) end)
    assert Task.yield(drain, 20) == nil
    Process.exit(f.holder, :kill)
    assert {:error, _} = Task.await(drain)
    assert :holder_lost = Task.await(relay)
    assert_receive {:DOWN, ^worker_monitor, :process, ^worker, _}, 2_000
    refute ReleaseGate.accepting?(f.owner)
    assert {:error, _} = ReleaseQuiesce.drain(f.attempt, f.expected)
  end

  @tag :tmp_dir
  test "post-receipt listener crash cannot rebind and invalidates receipt", %{tmp_dir: dir} do
    f = boot(dir)
    assert {:ok, receipt} = ReleaseQuiesce.drain(f.attempt, f.expected)
    assert {:ok, snapshot} = ReleaseGate.snapshot(f.owner, f.attempt)
    {listener, _} = snapshot.identities[{:listener, f.name}]
    monitor = Process.monitor(listener)
    Process.exit(listener, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^listener, _}, 2_000
    refute ReleaseGate.valid?(f.owner, receipt)
    assert {:error, :release_closed} = ReleaseGate.acquire(f.owner, {:bind, f.name})
  end

  @tag :tmp_dir
  test "wrong replica and corrupt final log each suppress receipt", %{tmp_dir: dir} do
    f = boot(dir)
    [instance] = f.expected.instances
    expected = %{f.expected | instances: [%{instance | replica: "replica:wrong"}]}
    assert {:error, _} = ReleaseQuiesce.drain(f.attempt, expected)
    refute ReleaseGate.accepting?(f.owner)
    bytes = File.read!(f.path)
    File.write!(f.path, "corrupt")
    assert {:error, _} = ReleaseQuiesce.drain(f.attempt, expected)
    assert File.read!(f.path) == "corrupt"
    File.write!(f.path, bytes)
  end

  @tag :tmp_dir
  test "partial multi-route capture failure leaves every route gated", %{tmp_dir: dir} do
    f = boot(dir, 2)
    [first, second] = f.expected.instances
    expected = %{f.expected | instances: [first, %{second | replica: "replica:wrong-second"}]}
    bytes = Enum.map(f.expected.instances, &File.read!(&1.log_file))
    assert {:error, _} = ReleaseQuiesce.drain(f.attempt, expected)

    for instance <- f.expected.instances do
      assert :suspended = :ranch.get_status(Listener.ref(instance.name))
      assert {:error, :release_closed} = Holder.relay(Holder.via(instance.name), "relay", f.op)
    end

    assert bytes == Enum.map(f.expected.instances, &File.read!(&1.log_file))
  end

  @tag :tmp_dir
  test "already queued RouteOwner retry cannot create a new route after close", %{tmp_dir: dir} do
    f = boot(dir)

    {_, owner, _, _} =
      Enum.find(
        Supervisor.which_children(LatticeCarrierServer.RuntimeSupervisor),
        fn {id, _, _, _} -> id == {LatticeCarrierServer, f.name} end
      )

    :sys.suspend(owner)
    send(owner, :start_route)
    assert {:ok, receipt} = ReleaseQuiesce.drain(f.attempt, f.expected)
    :sys.resume(owner)
    # A synchronous state read waits behind the already queued retry.
    assert :sys.get_state(owner).route != nil
    assert GenServer.whereis(Holder.via(f.name)) == f.holder
    assert ReleaseGate.valid?(f.owner, receipt)
  end

  @tag :tmp_dir
  test "mixed standalone server remains boot-compatible but cannot claim a complete controlled inventory",
       %{tmp_dir: dir} do
    extra_path = Path.join(dir, "extra")
    :ok = Log.new("replica:extra") |> Log.dump(extra_path)
    identity = Identity.from_seed("extra", "extra")

    Application.put_env(:lattice_carrier_server, :server_options,
      instance: :extra,
      identity: identity,
      source: {:path, extra_path},
      trusted_peers: %{"extra" => identity.pub},
      listener: [port: 0]
    )

    f = boot(dir)
    assert is_integer(LatticeCarrierServer.port(:extra))
    assert {:error, :release_inventory_changed} = ReleaseQuiesce.drain(f.attempt, f.expected)
    assert ReleaseGate.accepting?(f.owner)
  end

  @tag :tmp_dir
  test "full application restart uses a fresh owned ref on the same port and refuses old capability",
       %{tmp_dir: dir} do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
    {:ok, {{127, 0, 0, 1}, port}} = :inet.sockname(socket)
    :gen_tcp.close(socket)
    f = boot(dir, 1, port)
    old_ref = Listener.ref(f.name)
    assert {:ok, receipt} = ReleaseQuiesce.drain(f.attempt, f.expected)
    {:ok, snapshot} = ReleaseGate.snapshot(f.owner, f.attempt)
    {listener, _} = snapshot.identities[{:listener, f.name}]
    monitor = Process.monitor(listener)
    Process.exit(listener, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^listener, _}, 2_000
    assert :ok = Application.stop(:lattice_carrier_server)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
    current = Runtime.deployment().owner
    refute Listener.ref(f.name) == old_ref
    assert LatticeCarrierServer.port(f.name) == port
    assert ReleaseGate.accepting?(current)
    refute ReleaseGate.valid?(current, receipt)
    refute ReleaseGate.valid?(f.owner, receipt)

    assert {:error, :release_closed} =
             Listener.Transport.listen(%{
               release_bind: {f.owner, f.name},
               socket_opts: [port: port]
             })
  end

  defp boot(dir, count \\ 1, listener_port \\ 0) do
    identity = Identity.from_seed("relay", "release-relay")
    seed = :crypto.hash(:sha256, "release-server")
    identity_path = Path.join(dir, "identity")
    File.write!(identity_path, Base.encode16(seed, case: :lower))
    File.chmod!(identity_path, 0o600)
    path = Path.join(dir, "log")
    replica = "replica:controlled-quiesce"
    :ok = Log.new(replica) |> Log.dump(path)
    name = "controlled-quiesce"

    entry = %{
      "name" => name,
      "realm" => "server",
      "identity_file" => identity_path,
      "log_file" => path,
      "listener" => %{"ip" => "127.0.0.1", "port" => listener_port},
      "trusted_peers" => [%{"realm" => "relay", "pubkey" => Base.encode64(identity.pub)}],
      "relay_realms" => ["relay"]
    }

    manifest = Path.join(dir, "manifest.json")

    entries =
      for index <- 1..count do
        if index == 1 do
          entry
        else
          other_path = path <> Integer.to_string(index)
          :ok = Log.new(replica) |> Log.dump(other_path)
          %{entry | "name" => name <> Integer.to_string(index), "log_file" => other_path}
        end
      end

    File.write!(manifest, Jason.encode!(%{"version" => 1, "instances" => entries}))
    Application.put_env(:lattice_carrier_server, :manifest, manifest)
    assert {:ok, _} = Application.ensure_all_started(:lattice_carrier_server)
    deployment = Runtime.deployment()

    expected = %{
      manifest_path: deployment.manifest_path,
      manifest_digest: deployment.manifest_digest,
      instances:
        Enum.map(
          deployment.instances,
          &(Map.take(&1, [:name, :realm, :pub, :log_file]) |> Map.put(:replica, replica))
        )
    }

    %{
      name: name,
      owner: deployment.owner,
      path: path,
      expected: expected,
      attempt: nonce("attempt"),
      holder: GenServer.whereis(Holder.via(name)),
      op: Op.new(identity, replica, [], :command, {:post, "durable-before-drain"})
    }
  end

  defp nonce(value), do: Base.url_encode64(:crypto.hash(:sha256, value), padding: false)
end
