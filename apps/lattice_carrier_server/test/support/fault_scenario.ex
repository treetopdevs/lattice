defmodule LatticeCarrierServer.FaultScenario do
  @moduledoc """
  Test-only process-level fault scenarios for the plan 203 evidence format (plan 204).

  `stall_shutdown/2` holds the carrier holder inside the fsync of one accepted relay
  and drains the release under a short deadline; `crash_relay/2` relays signed posts
  to a second BEAM running `priv/server_node.exs`, halts it, and restarts it from the
  same log path. Each returns the server's final verified log as `"thread.server"`,
  the invariant's checks in `Lattice.FaultScenario.spec/1` order, and timings.

  Both scenarios create their `Treehouse.Thread` replica in `Lattice.Sim` from
  `Lattice.FaultScenario.replica_name/2` and the seed, so the verifier table derives
  the same expected replica id. Fault injection never ships in the release: this
  module compiles only under `test/support`.

  `boot/3`, `GatedSync` and `isolate_application/0` are copied from
  `test/operator/release_runtime_test.exs`; the second-BEAM helpers are copied from
  `test/township_projection_test.exs`.
  """

  import ExUnit.Assertions
  import ExUnit.Callbacks, only: [on_exit: 1]

  alias Lattice.Carrier.WebSocket
  alias Lattice.{FaultScenario, Identity, Log, Op, Sim}
  alias LatticeCarrierServer.{Holder, Runtime}
  alias LatticeCarrierServer.Operator.ReleaseQuiesce
  alias Treehouse.Thread

  @script Path.expand("../../priv/server_node.exs", __DIR__)
  @stall_drain_timeout_ms 1_000

  @type result :: %{
          logs: FaultScenario.logs(),
          checks: [{String.t(), boolean()}],
          observed_ms: %{String.t() => non_neg_integer()}
        }

  defmodule GatedSync do
    @moduledoc "Durability that parks the persistence worker until `:continue_sync`."
    alias LatticeCarrierServer.Durability.Posix

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

      Posix.sync_file(path)
    end

    def rename(from, to), do: File.rename(from, to)
    def sync_directory(path), do: Posix.sync_directory(path)
  end

  @doc """
  Stop the running carrier application for one test and restore it afterwards.

  Mix starts `:lattice_carrier_server` before the suite; `boot/3` must start it
  fresh from its own manifest. Call from `setup`.
  """
  @spec isolate_application() :: :ok
  def isolate_application do
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

  @doc """
  The scenario's seeded Sim: `owner` creates the Thread replica and grants `writer`
  `:post`; `writer` then authors `posts` posts. Returns the Sim, the synced base log
  (genesis and grant) and the posts in authoring order.
  """
  @spec thread(String.t(), String.t(), pos_integer()) :: {Sim.t(), Log.t(), [Op.t()]}
  def thread(name, seed, posts) do
    %{sim_realms: realms, root: root} = FaultScenario.spec(name)

    {sim, _genesis} =
      Thread
      |> Sim.new(FaultScenario.replica_name(name, "thread"), realms, seed: seed)
      |> Sim.create_replica(root)

    {sim, _cap} = Sim.grant(sim, root, "writer", ops: [:post], live: true)
    sim = Sim.sync_all(sim)
    base = Sim.log(sim, root)

    {ops, sim} =
      Enum.map_reduce(1..posts, sim, fn n, sim ->
        {sim, op} = Sim.command(sim, "writer", :post, ["#{name} #{n}"])
        {op, sim}
      end)

    {Sim.sync_all(sim), base, ops}
  end

  @doc """
  Boot the carrier application from a one-instance manifest over `base` at
  `dir/log`, with `"relay"` as the only relay realm.
  """
  @spec boot(Path.t(), Log.t()) :: map()
  def boot(dir, %Log{replica: replica} = base) do
    identity = Identity.from_seed("relay", "release-relay")
    seed = :crypto.hash(:sha256, "release-server")
    identity_path = Path.join(dir, "identity")
    File.write!(identity_path, Base.encode16(seed, case: :lower))
    File.chmod!(identity_path, 0o600)
    path = Path.join(dir, "log")
    :ok = Log.dump(base, path)
    name = "fault-stall"

    entry = %{
      "name" => name,
      "realm" => "server",
      "identity_file" => identity_path,
      "log_file" => path,
      "listener" => %{"ip" => "127.0.0.1", "port" => 0},
      "trusted_peers" => [%{"realm" => "relay", "pubkey" => Base.encode64(identity.pub)}],
      "relay_realms" => ["relay"]
    }

    manifest = Path.join(dir, "manifest.json")
    File.write!(manifest, Jason.encode!(%{"version" => 1, "instances" => [entry]}))
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
      attempt: nonce("attempt:#{System.unique_integer([:positive])}"),
      holder: GenServer.whereis(Holder.via(name))
    }
  end

  # --- stall_shutdown ----------------------------------------------------------

  @doc """
  Run `stall_shutdown` in `dir`. `variant: :released` is the negative control: the
  stalled sync is released while `drain/3` still waits, so the drain succeeds.
  """
  @spec stall_shutdown(Path.t(), String.t(), keyword()) :: result()
  def stall_shutdown(dir, seed, opts \\ []) do
    {_sim, base, [first, second]} = thread("stall_shutdown", seed, 2)
    f = boot(dir, base)
    :persistent_term.put({GatedSync, :observer}, self())
    :sys.replace_state(f.holder, &Map.put(&1, :durability, GatedSync))
    relay = Task.async(fn -> Holder.relay(f.holder, "relay", first) end)
    assert_receive {:sync_entered, worker}, 2_000
    bytes_0 = File.read!(f.path)
    started = now()

    drain =
      if opts[:variant] == :released do
        task = Task.async(fn -> ReleaseQuiesce.drain(f.attempt, f.expected) end)
        assert Task.yield(task, 30) == nil
        send(worker, :continue_sync)
        Task.await(task)
      else
        ReleaseQuiesce.drain(f.attempt, f.expected, @stall_drain_timeout_ms)
      end

    drain_ms = now() - started

    # Still holding the gate: the drain's own call must be queued behind the stalled relay.
    owner = f.owner
    {:messages, queued} = Process.info(f.holder, :messages)
    reached? = Enum.any?(queued, &match?({:"$gen_call", _, {:drain_release, ^owner}}, &1))
    unchanged? = File.read!(f.path) == bytes_0

    send(worker, :continue_sync)
    first_reply = Task.await(relay, Holder.relay_call_timeout_ms() + 1_000)
    bytes_1 = File.read!(f.path)
    second_reply = Holder.relay(f.holder, "relay", second)

    acked =
      Enum.flat_map([first_reply, second_reply], fn
        {:ok, %{accepted: ids}} -> ids
        _refused -> []
      end)

    {persisted, log} = persisted(f.path)

    checks = [
      {"drain_returned_error", match?({:error, _}, drain)},
      {"drain_call_reached_holder", reached?},
      {"bytes_unchanged_while_stalled", unchanged?},
      {"admission_closed",
       second_reply == {:error, :release_closed} and File.read!(f.path) == bytes_1},
      # The stalled relay itself must have been acknowledged, or the subset is vacuous.
      {"acked_subset_of_persisted",
       log != nil and first.id in acked and Enum.all?(acked, &(&1 in persisted))}
    ]

    %{logs: logs(log), checks: checks, observed_ms: %{"drain" => drain_ms}}
  end

  # --- crash_relay -------------------------------------------------------------

  @doc """
  Run `crash_relay` in `dir`. `variant: :lost_log` is the negative control: the
  server restarts from a fresh empty log for the same replica, simulating lost
  persistence.
  """
  @spec crash_relay(Path.t(), String.t(), keyword()) :: result()
  def crash_relay(dir, seed, opts \\ []) do
    {sim, base, posts} = thread("crash_relay", seed, 3)
    writer = Sim.identity(sim, "writer")
    observer = Identity.from_seed("observer", "fault-crash-relay")
    server = Identity.from_seed("server", "fault-crash-relay-server")
    path = Path.join(dir, "thread.log")
    :ok = Log.dump(base, path)

    peer = spawn_server(path, observer, writer)
    {:ok, conn} = WebSocket.connect(connect_opts(peer, writer, server, base.replica))

    {replies, conn} = relay_all(conn, posts)
    acked = Enum.flat_map(replies, &accepted_ids/1)

    _ = WebSocket.close(conn)
    started = now()
    halt_server(peer)

    restart_path =
      if opts[:variant] == :lost_log do
        lost = Path.join(dir, "lost.log")
        :ok = base.replica |> Log.new() |> Log.dump(lost)
        lost
      else
        path
      end

    peer = spawn_server(restart_path, observer, writer)
    restart_ms = now() - started

    # Before any resend: a resend would repopulate a lost log and hide the loss.
    {advertised, served} = served(peer, observer, server, base.replica)
    # Every post must have been acknowledged, so an errored relay cannot shrink the set.
    survived? =
      acked == Enum.map(posts, & &1.id) and MapSet.subset?(MapSet.new(acked), served)

    bytes_before = File.read!(restart_path)

    {:ok, conn} = WebSocket.connect(connect_opts(peer, writer, server, base.replica))

    {resent, conn} = relay_all(conn, posts)

    _ = WebSocket.close(conn)
    {advertised_after, served_after} = served(peer, observer, server, base.replica)
    stop_server(peer)

    oracle = Sim.log(sim, "owner")
    {_ids, log} = persisted(restart_path)

    checks = [
      {"acked_survive_restart", survived?},
      {"duplicates_silent",
       Enum.all?(resent, &match?({:ok, %{accepted: []}}, &1)) and served_after == served and
         advertised_after == advertised and
         File.read!(restart_path) == bytes_before},
      {"frontier_after_equals_sim",
       log != nil and served_after == MapSet.new(Log.op_ids(oracle)) and
         Enum.sort(Log.frontier(log)) == Enum.sort(Log.frontier(oracle))},
      {"state_after_equals_sim",
       log != nil and Lattice.state(Thread, log) == Lattice.state(Thread, oracle)}
    ]

    %{logs: logs(log), checks: checks, observed_ms: %{"halt_to_ready" => restart_ms}}
  end

  # Relay each op in order, keeping every reply, errors included.
  defp relay_all(conn, ops) do
    Enum.map_reduce(ops, conn, fn op, conn ->
      case WebSocket.relay(conn, op) do
        {:ok, report, conn} -> {{:ok, report}, conn}
        {:error, _} = error -> {error, conn}
      end
    end)
  end

  defp accepted_ids({:ok, %{accepted: ids}}), do: ids
  defp accepted_ids(_error), do: []

  # The carrier's "frontier" exchange advertises every op id the server holds; the
  # pull serves the ops themselves. Both are read as the distinct observer realm.
  defp served(peer, observer, server, replica) do
    {:ok, conn} = WebSocket.connect(connect_opts(peer, observer, server, replica))
    {:ok, advertised, conn} = WebSocket.advertise(conn, nil)
    {:ok, ops, conn} = WebSocket.pull(conn, MapSet.new())
    :ok = WebSocket.close(conn)
    {advertised, MapSet.new(ops, & &1.id)}
  end

  # --- Shared ------------------------------------------------------------------

  defp persisted(path) do
    case Log.restore_verified(path) do
      {:ok, %{log: log}} -> {Log.op_ids(log), log}
      {:error, _} -> {[], nil}
    end
  end

  defp logs(nil), do: %{}
  defp logs(log), do: %{"thread.server" => log}

  defp now, do: System.monotonic_time(:millisecond)

  defp nonce(value), do: Base.url_encode64(:crypto.hash(:sha256, value), padding: false)

  # --- Second BEAM (copied from township_projection_test.exs) -----------------

  defp spawn_server(source_path, observer, relay_identity) do
    args =
      Enum.flat_map(code_paths(), &["-pa", &1]) ++
        [
          @script,
          "0",
          "server",
          "fault-crash-relay-server",
          observer.realm_id,
          Base.encode64(observer.pub),
          source_path,
          relay_identity.realm_id,
          Base.encode64(relay_identity.pub)
        ]

    port =
      Port.open({:spawn_executable, elixir_bin()}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        {:line, 4_096},
        {:args, args},
        {:cd, repo_root()}
      ])

    os_pid = port |> Port.info(:os_pid) |> elem(1)

    on_exit(fn ->
      _ = System.cmd("kill", ["-9", Integer.to_string(os_pid)], stderr_to_stdout: true)
    end)

    {port, await_ready(port, [])}
  end

  # `server_node.exs` answers a line on stdin with `System.halt(0)`, which is
  # `:erlang.halt/1`: no application stop, no flush beyond what was synced.
  defp halt_server({port, _ws_port}) do
    true = Port.command(port, "halt\n")
    assert_receive {^port, {:exit_status, _status}}, 10_000
  end

  defp stop_server(peer), do: halt_server(peer)

  defp connect_opts({_port, ws_port}, identity, server, replica) do
    [
      hostname: "127.0.0.1",
      port: ws_port,
      identity: identity,
      realm: identity.realm_id,
      peer_realm: server.realm_id,
      peer_pubkey: server.pub,
      replica: replica
    ]
  end

  defp await_ready(port, seen) do
    receive do
      {^port, {:data, {:eol, "SERVER_READY " <> ws_port}}} ->
        String.to_integer(String.trim(ws_port))

      {^port, {:data, {:eol, line}}} ->
        await_ready(port, [line | seen])

      {^port, {:data, {:noeol, chunk}}} ->
        await_ready(port, [chunk | seen])

      {^port, {:exit_status, status}} ->
        flunk("server exited (#{status}) before READY:\n#{format_output(seen)}")
    after
      60_000 -> flunk("server never became ready:\n#{format_output(seen)}")
    end
  end

  defp code_paths do
    :code.get_path()
    |> Enum.map(&(List.to_string(&1) |> Path.expand()))
    |> Enum.filter(&File.dir?/1)
  end

  defp elixir_bin do
    shim = Path.expand("~/.asdf/shims/elixir")

    cond do
      File.exists?(shim) -> shim
      path = System.find_executable("elixir") -> path
      true -> flunk("no elixir executable available to spawn the server")
    end
  end

  defp repo_root, do: Path.expand("../../../..", __DIR__)
  defp format_output(lines), do: lines |> Enum.reverse() |> Enum.join("\n")
end
