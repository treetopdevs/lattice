defmodule LatticeNodeSpike.NodeCarrierSpikeTest do
  @moduledoc """
  The plan-010 GATE, executed for real: this test is one BEAM OS process
  (realm `node_b`); it spawns a **second BEAM OS process** (realm `node_a`,
  `priv/peer_node.exs`) and talks to it exclusively over a real WebSocket
  (`:gen_tcp` + RFC 6455 handshake against a Cowboy listener). No Erlang
  distribution is involved.

  GATE assertions, in order:

    1. determinism across OS processes — the seeded shared prefix hashes to the
       same op ids on both nodes without any transfer;
    2. partition (socket closed) → both sides append offline → heal (reconnect
       + `Lattice.Carrier.sync/3`) → **byte-identical reduced state** on both
       nodes, equal to the `Lattice.Sim` oracle for the same op set;
    3. a second sync transfers nothing (idempotent over the wire);
    4. a tampered op injected on the wire is quarantined by the receiver's
       `Lattice.Log.accept/2` signature check — and does not poison the
       genuine op with the same id;
    5. a live ephemeral message crosses the carrier without touching the log.
  """

  use ExUnit.Case, async: false

  alias Lattice.Carrier
  alias Lattice.Carrier.Backoff
  alias Lattice.Log
  alias Lattice.Sim
  alias Lattice.Sync
  alias LatticeNodeSpike.{Scenario, WsCarrier}

  @moduletag timeout: 120_000

  @script Path.expand("../priv/peer_node.exs", __DIR__)

  test "carrier session rejects the wrong peer key before sync" do
    {port, ws_port} = spawn_peer("node_a")
    wrong_pubkey = Lattice.Identity.from_seed("node_a", "wrong-carrier-spike").pub

    assert {:error, :bad_signature} = connect(ws_port, peer_pubkey: wrong_pubkey)

    {:ok, conn} = connect(ws_port)
    assert {:ok, %{"type" => "shutdown_result"}} = WsCarrier.shutdown(conn)
    assert_receive {^port, {:exit_status, 0}}, 10_000
  end

  test "reconnect waits on deterministic non-zero backoff while peer reaches divergence" do
    {port, ws_port} = spawn_peer("node_a")
    backoff = Backoff.new(base_ms: 5, max_ms: 20, jitter_ms: 0, seed: "node_a")

    assert Enum.any?(0..3, &(Backoff.delay_ms(backoff, &1) > 0))

    {:ok, conn} = connect(ws_port)
    :ok = WsCarrier.close(conn)

    {:ok, conn} = reconnect_when_diverged(ws_port, backoff: backoff)
    assert {:ok, "diverged"} = WsCarrier.status(conn)
    assert {:ok, %{"type" => "shutdown_result"}} = WsCarrier.shutdown(conn)
    assert_receive {^port, {:exit_status, 0}}, 10_000
  end

  test "large transfers are split into bounded push frames" do
    {port, ws_port} = spawn_peer("node_a")
    sim_b = Scenario.base_sim() |> bulk_posts(150)
    log_b = Sim.log(sim_b, "node_b")

    {:ok, conn} = connect(ws_port)
    {:ok, log_b, stats, conn} = Carrier.sync(WsCarrier, conn, log_b)

    assert %{sent: 150, received: 0} = Map.take(stats, [:sent, :received])

    batches = WsCarrier.last_push_batches(conn)
    assert length(batches) > 1
    assert Enum.all?(batches, &(&1.count <= 64))
    assert Enum.all?(batches, &(&1.bytes <= 65_536))

    {:ok, peer_report} = WsCarrier.state_report(conn)
    assert peer_report["op_ids"] == Enum.sort(Log.op_ids(log_b))

    assert {:ok, %{"type" => "shutdown_result"}} = WsCarrier.shutdown(conn)
    assert_receive {^port, {:exit_status, 0}}, 10_000
  end

  test "GATE: two OS-process BEAM nodes converge over a real WebSocket carrier" do
    {port, ws_port} = spawn_peer("node_a")

    # ------------------------------------------------------------------
    # Link up: both OS processes derived the shared prefix independently.
    # ------------------------------------------------------------------
    sim_b = Scenario.base_sim()
    log_b = Sim.log(sim_b, "node_b")

    {:ok, conn} = connect(ws_port)
    assert {:ok, "base"} = WsCarrier.status(conn)

    {:ok, peer_ids, conn} = WsCarrier.advertise(conn, log_b)

    assert MapSet.equal?(peer_ids, Log.op_ids(log_b)),
           "seeded prefix must be byte-identical across OS processes (same op ids)"

    # Nothing to transfer: the prefix already converged on both nodes.
    {:ok, _log_b, stats, conn} = Carrier.sync(WsCarrier, conn, log_b)
    assert %{sent: 0, received: 0} = Map.take(stats, [:sent, :received])

    # ------------------------------------------------------------------
    # Partition: close the socket. Each OS process appends offline.
    # ------------------------------------------------------------------
    :ok = WsCarrier.close(conn)
    sim_b = Scenario.diverge(sim_b, "node_b")
    log_b = Sim.log(sim_b, "node_b")

    # ------------------------------------------------------------------
    # Heal: reconnect + Carrier.sync. Both directions transfer 3 ops.
    # ------------------------------------------------------------------
    {:ok, conn} = reconnect_when_diverged(ws_port)
    {:ok, log_b, stats, conn} = Carrier.sync(WsCarrier, conn, log_b)
    assert %{sent: 3, received: 3} = Map.take(stats, [:sent, :received])
    assert stats.pushed.quarantined == []
    assert stats.pulled.quarantined == []

    # ------------------------------------------------------------------
    # Convergence: byte-identical reduced state on both nodes == Sim oracle.
    # ------------------------------------------------------------------
    local_bytes = Scenario.state_bytes(log_b)
    {:ok, peer_report} = WsCarrier.state_report(conn)

    assert Base.decode64!(peer_report["state_b64"]) == local_bytes
    assert peer_report["op_ids"] == Enum.sort(Log.op_ids(log_b))
    assert peer_report["frontier"] == Log.frontier(log_b)

    oracle = Scenario.oracle_sim()

    for realm <- ["node_a", "node_b"] do
      oracle_log = Sim.log(oracle, realm)
      assert MapSet.equal?(Log.op_ids(oracle_log), Log.op_ids(log_b))
      assert Scenario.state_bytes(oracle_log) == local_bytes
    end

    # ------------------------------------------------------------------
    # Idempotency: a second reconcile transfers nothing over the wire.
    # ------------------------------------------------------------------
    {:ok, log_b, stats, conn} = Carrier.sync(WsCarrier, conn, log_b)
    assert %{sent: 0, received: 0} = Map.take(stats, [:sent, :received])

    # ------------------------------------------------------------------
    # Integrity: a tampered op injected on the wire is quarantined by the
    # receiver's Log.accept signature check; the genuine op still lands.
    # ------------------------------------------------------------------
    {_sim, genuine} = Sim.command(sim_b, "node_b", :post, ["node_b: post-heal note"])
    tampered = %{genuine | body: {:post, "forged over the wire"}}
    refute Lattice.Op.valid?(tampered)

    {:ok, report, conn} = WsCarrier.push(conn, [tampered])
    assert report.accepted == []
    assert [{quarantined_id, :bad_signature}] = report.quarantined
    assert quarantined_id == tampered.id

    {:ok, peer_report} = WsCarrier.state_report(conn)
    refute tampered.id in peer_report["op_ids"]
    assert [tampered.id, "bad_signature"] in peer_report["structural_quarantine"]
    assert Base.decode64!(peer_report["state_b64"]) == local_bytes

    # No id-poisoning across the carrier: the genuine op is still accepted.
    {:ok, report, conn} = WsCarrier.push(conn, [genuine])
    assert report.accepted == [genuine.id]

    {log_b, local_report} = Sync.deliver(log_b, [genuine])
    assert local_report.accepted == [genuine.id]

    {:ok, peer_report} = WsCarrier.state_report(conn)
    assert Base.decode64!(peer_report["state_b64"]) == Scenario.state_bytes(log_b)

    # ------------------------------------------------------------------
    # Live ephemeral: crosses the carrier, never enters the log.
    # ------------------------------------------------------------------
    size_before = peer_report["log_size"]
    {:ok, conn} = WsCarrier.live(conn, %{typing: "node_b"})
    {:ok, peer_report} = WsCarrier.state_report(conn)
    assert peer_report["log_size"] == size_before

    # ------------------------------------------------------------------
    # Graceful teardown of the second OS process.
    # ------------------------------------------------------------------
    assert {:ok, %{"type" => "shutdown_result"}} = WsCarrier.shutdown(conn)
    assert_receive {^port, {:exit_status, 0}}, 10_000
  end

  # --- Second-OS-process plumbing ----------------------------------------------

  defp spawn_peer(realm) do
    args =
      Enum.flat_map(code_paths(), &["-pa", &1]) ++
        [@script, realm, "node_b", Base.encode64(identity("node_b").pub)]

    port =
      Port.open({:spawn_executable, elixir_bin()}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        {:line, 4096},
        {:args, args},
        {:cd, repo_root()}
      ])

    os_pid = port |> Port.info(:os_pid) |> elem(1)

    on_exit(fn ->
      # The port closes with the test process (stdin EOF halts the peer); this
      # is the belt-and-braces backstop for a wedged child.
      _ = System.cmd("kill", ["-9", Integer.to_string(os_pid)], stderr_to_stdout: true)
    end)

    {port, await_ready(port, [])}
  end

  defp bulk_posts(sim, count) do
    Enum.reduce(1..count, sim, fn i, acc ->
      {acc, _op} = Sim.command(acc, "node_b", :post, ["bulk #{i}"])
      acc
    end)
  end

  defp await_ready(port, seen) do
    receive do
      {^port, {:data, {:eol, "PEER_READY " <> ws_port}}} ->
        String.to_integer(String.trim(ws_port))

      {^port, {:data, {:eol, line}}} ->
        await_ready(port, [line | seen])

      {^port, {:data, {:noeol, chunk}}} ->
        await_ready(port, [chunk | seen])

      {^port, {:exit_status, status}} ->
        flunk("peer OS process exited (#{status}) before READY:\n#{format_output(seen)}")
    after
      60_000 ->
        flunk("peer OS process never became ready:\n#{format_output(seen)}")
    end
  end

  defp reconnect_when_diverged(ws_port, opts \\ []) do
    attempts = Keyword.get(opts, :attempts, 50)

    backoff =
      Keyword.get_lazy(opts, :backoff, fn ->
        Backoff.new(base_ms: 100, max_ms: 100, seed: "node_a")
      end)

    {:ok, conn} = connect(ws_port)

    case WsCarrier.status(conn) do
      {:ok, "diverged"} ->
        {:ok, conn}

      {:ok, "base"} when attempts > 0 ->
        # The peer diverges on the *close* of the previous socket; give the
        # cowboy terminate → Peer cast a moment to land, without closing this
        # socket again (that would be a second partition).
        await_divergence(conn, attempts, backoff, Backoff.reset_attempt())

      other ->
        flunk("unexpected peer status after reconnect: #{inspect(other)}")
    end
  end

  defp await_divergence(conn, attempts, backoff, attempt) do
    case WsCarrier.status(conn) do
      {:ok, "diverged"} ->
        {:ok, conn}

      {:ok, "base"} when attempts > 0 ->
        Process.sleep(Backoff.delay_ms(backoff, attempt))
        await_divergence(conn, attempts - 1, backoff, attempt + 1)

      {:ok, "base"} ->
        flunk("peer never diverged: #{inspect(conn)}")
    end
  end

  defp code_paths do
    :code.get_path()
    |> Enum.map(&List.to_string/1)
    |> Enum.filter(&String.contains?(&1, "_build"))
  end

  defp elixir_bin do
    shim = Path.expand("~/.asdf/shims/elixir")

    cond do
      File.exists?(shim) -> shim
      path = System.find_executable("elixir") -> path
      true -> flunk("no elixir executable available to spawn the peer OS process")
    end
  end

  defp repo_root, do: Path.expand("../../..", __DIR__)

  defp format_output(lines), do: lines |> Enum.reverse() |> Enum.join("\n")

  defp connect(ws_port, opts \\ []) do
    defaults = [
      port: ws_port,
      identity: identity("node_b"),
      realm: "node_b",
      peer_realm: "node_a",
      peer_pubkey: identity("node_a").pub,
      replica: Scenario.replica()
    ]

    WsCarrier.connect(Keyword.merge(defaults, opts))
  end

  defp identity(realm), do: Lattice.Identity.from_seed(realm, "carrier-spike")
end
