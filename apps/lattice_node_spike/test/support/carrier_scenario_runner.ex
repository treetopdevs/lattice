defmodule LatticeNodeSpike.CarrierScenarioRunner do
  @moduledoc """
  Runs a deterministic scenario through a real second-process carrier.

  The runner owns the physical peer lifecycle, authenticated connection,
  partition and heal timing, carrier reconciliation, and comparison with the
  scenario's in-process oracle. Tests receive a report containing only the
  scenario facts they still need to assert.
  """

  alias Lattice.{Authority, Carrier, Log, Sim}
  alias Lattice.Carrier.Backoff
  alias Lattice.Carrier.WebSocket, as: WsCarrier

  defmodule Report do
    @moduledoc "Structured facts from one completed real-carrier scenario."

    @enforce_keys [
      :scenario,
      :peer_realm,
      :local_realm,
      :base_sync,
      :heal_sync,
      :idempotent_sync,
      :log,
      :state_bytes,
      :op_ids,
      :frontier,
      :authority_quarantine,
      :peer_state
    ]
    defstruct @enforce_keys

    @type t :: %__MODULE__{
            scenario: module(),
            peer_realm: String.t(),
            local_realm: String.t(),
            base_sync: map(),
            heal_sync: map(),
            idempotent_sync: map(),
            log: Log.t(),
            state_bytes: binary(),
            op_ids: [String.t()],
            frontier: [String.t()],
            authority_quarantine: [[String.t()]],
            peer_state: map()
          }
  end

  @type scenario_module :: module()

  @spec run!(scenario_module(), keyword()) :: Report.t()
  def run!(scenario, opts) when is_atom(scenario) and is_list(opts) do
    peer_realm = Keyword.fetch!(opts, :peer_realm)
    local_realm = Keyword.fetch!(opts, :local_realm)
    peer = spawn_peer!(scenario, peer_realm, local_realm)

    try do
      execute!(scenario, peer, peer_realm, local_realm, opts)
    after
      stop_peer(peer)
    end
  end

  defp execute!(scenario, peer, peer_realm, local_realm, opts) do
    sim = scenario.base_sim()
    log = Sim.log(sim, local_realm)
    conn = connect!(scenario, peer.ws_port, local_realm, peer_realm)

    ensure_equal!(WsCarrier.status(conn), {:ok, "base"}, "peer did not start at base")

    {:ok, _base_log, base_sync, conn} = Carrier.sync(WsCarrier, conn, log)
    ensure_zero_transfer!(base_sync, "deterministic base prefix")
    :ok = WsCarrier.close(conn)

    log = scenario.diverge(sim, local_realm) |> Sim.log(local_realm)
    conn = reconnect_when_diverged!(scenario, peer.ws_port, local_realm, peer_realm, opts)
    {:ok, log, heal_sync, conn} = Carrier.sync(WsCarrier, conn, log)
    ensure_no_structural_quarantine!(heal_sync)

    {:ok, peer_state} = WsCarrier.state_report(conn)
    facts = verify_convergence!(scenario, log, peer_state)

    {:ok, log, idempotent_sync, conn} = Carrier.sync(WsCarrier, conn, log)
    ensure_zero_transfer!(idempotent_sync, "idempotent reconciliation")
    shutdown_peer!(peer.port, conn)

    struct!(
      Report,
      [
        scenario: scenario,
        peer_realm: peer_realm,
        local_realm: local_realm,
        base_sync: base_sync,
        heal_sync: heal_sync,
        idempotent_sync: idempotent_sync,
        log: log,
        peer_state: peer_state
      ] ++ Map.to_list(facts)
    )
  end

  defp verify_convergence!(scenario, %Log{} = log, peer_state) do
    state_bytes = scenario.state_bytes(log)
    op_ids = log |> Log.op_ids() |> Enum.sort()
    frontier = Log.frontier(log)
    quarantine = authority_quarantine(scenario, log)

    ensure_equal!(
      Base.decode64!(peer_state["state_b64"]),
      state_bytes,
      "peer reduced state differs from local state"
    )

    ensure_equal!(peer_state["op_ids"], op_ids, "peer op ids differ from local op ids")
    ensure_equal!(peer_state["frontier"], frontier, "peer frontier differs from local frontier")

    ensure_equal!(
      peer_state["authority_quarantine"],
      quarantine,
      "peer authority quarantine differs from local verdicts"
    )

    oracle = scenario.oracle_sim()

    Enum.each(scenario.realms(), fn realm ->
      oracle_log = Sim.log(oracle, realm)

      ensure!(
        MapSet.equal?(Log.op_ids(oracle_log), Log.op_ids(log)),
        "oracle op ids differ for #{inspect(realm)}"
      )

      ensure_equal!(
        scenario.state_bytes(oracle_log),
        state_bytes,
        "oracle reduced state differs for #{inspect(realm)}"
      )

      ensure_equal!(
        authority_quarantine(scenario, oracle_log),
        quarantine,
        "oracle authority quarantine differs for #{inspect(realm)}"
      )
    end)

    %{
      state_bytes: state_bytes,
      op_ids: op_ids,
      frontier: frontier,
      authority_quarantine: quarantine
    }
  end

  defp authority_quarantine(scenario, %Log{} = log) do
    scenario.replica_module()
    |> Authority.analyze(log)
    |> Map.fetch!(:reasons)
    |> Enum.map(fn {id, reason} -> [id, Atom.to_string(reason)] end)
    |> Enum.sort()
  end

  defp ensure_no_structural_quarantine!(stats) do
    ensure_equal!(stats.pushed.quarantined, [], "peer quarantined a healed op")
    ensure_equal!(stats.pulled.quarantined, [], "local node quarantined a healed op")
  end

  defp ensure_zero_transfer!(stats, phase) do
    ensure_equal!(Map.take(stats, [:sent, :received]), %{sent: 0, received: 0}, phase)
  end

  defp spawn_peer!(scenario, peer_realm, local_realm) do
    args =
      Enum.flat_map(code_paths(), &["-pa", &1]) ++
        [
          peer_script(),
          peer_realm,
          local_realm,
          Base.encode64(scenario.session_identity(local_realm).pub),
          Atom.to_string(scenario)
        ]

    port =
      Port.open({:spawn_executable, elixir_bin!()}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        {:line, 4096},
        {:args, args},
        {:cd, repo_root()}
      ])

    os_pid = port |> Port.info(:os_pid) |> elem(1)
    %{port: port, os_pid: os_pid, ws_port: await_ready!(port, [])}
  end

  defp await_ready!(port, seen) do
    receive do
      {^port, {:data, {:eol, "PEER_READY " <> ws_port}}} ->
        String.to_integer(String.trim(ws_port))

      {^port, {:data, {:eol, line}}} ->
        await_ready!(port, [line | seen])

      {^port, {:data, {:noeol, chunk}}} ->
        await_ready!(port, [chunk | seen])

      {^port, {:exit_status, status}} ->
        raise "peer OS process exited (#{status}) before READY:\n#{format_output(seen)}"
    after
      60_000 ->
        raise "peer OS process never became ready:\n#{format_output(seen)}"
    end
  end

  defp connect!(scenario, ws_port, local_realm, peer_realm) do
    opts = [
      port: ws_port,
      identity: scenario.session_identity(local_realm),
      realm: local_realm,
      peer_realm: peer_realm,
      peer_pubkey: scenario.session_identity(peer_realm).pub,
      replica: scenario.replica()
    ]

    case WsCarrier.connect(opts) do
      {:ok, conn} -> conn
      {:error, reason} -> raise "carrier connection failed: #{inspect(reason)}"
    end
  end

  defp reconnect_when_diverged!(scenario, ws_port, local_realm, peer_realm, opts) do
    attempts = Keyword.get(opts, :reconnect_attempts, 50)

    backoff =
      Keyword.get_lazy(opts, :backoff, fn ->
        Backoff.new(base_ms: 10, max_ms: 100, jitter_ms: 0, seed: peer_realm)
      end)

    conn = connect!(scenario, ws_port, local_realm, peer_realm)
    await_divergence!(conn, attempts, backoff, Backoff.reset_attempt())
  end

  defp await_divergence!(conn, attempts, backoff, attempt) do
    case WsCarrier.status(conn) do
      {:ok, "diverged"} ->
        conn

      {:ok, "base"} when attempts > 0 ->
        Process.sleep(Backoff.delay_ms(backoff, attempt))
        await_divergence!(conn, attempts - 1, backoff, attempt + 1)

      {:ok, "base"} ->
        raise "peer never entered the diverged phase"

      other ->
        raise "unexpected peer status after reconnect: #{inspect(other)}"
    end
  end

  defp shutdown_peer!(port, conn) do
    ensure_equal!(
      WsCarrier.shutdown(conn),
      {:ok, %{"type" => "shutdown_result"}},
      "peer rejected graceful shutdown"
    )

    await_exit!(port, [])
  end

  defp await_exit!(port, seen) do
    receive do
      {^port, {:exit_status, 0}} ->
        :ok

      {^port, {:exit_status, status}} ->
        raise "peer OS process exited with status #{status}:\n#{format_output(seen)}"

      {^port, {:data, {:eol, line}}} ->
        await_exit!(port, [line | seen])

      {^port, {:data, {:noeol, chunk}}} ->
        await_exit!(port, [chunk | seen])
    after
      10_000 ->
        raise "peer OS process did not exit after shutdown:\n#{format_output(seen)}"
    end
  end

  defp stop_peer(%{port: port, os_pid: os_pid}) do
    if Port.info(port) do
      _ = System.cmd("kill", ["-9", Integer.to_string(os_pid)], stderr_to_stdout: true)
    end

    :ok
  end

  defp code_paths do
    :code.get_path()
    |> Enum.map(&List.to_string/1)
    |> Enum.filter(&String.contains?(&1, "_build"))
  end

  defp elixir_bin! do
    shim = Path.expand("~/.asdf/shims/elixir")

    cond do
      File.exists?(shim) -> shim
      path = System.find_executable("elixir") -> path
      true -> raise "no elixir executable available to spawn the peer OS process"
    end
  end

  defp peer_script, do: Path.expand("../../priv/peer_node.exs", __DIR__)
  defp repo_root, do: Path.expand("../../../..", __DIR__)
  defp format_output(lines), do: lines |> Enum.reverse() |> Enum.join("\n")

  defp ensure_equal!(actual, expected, context) do
    ensure!(
      actual == expected,
      "#{context}: expected #{inspect(expected)}, got #{inspect(actual)}"
    )
  end

  defp ensure!(true, _message), do: :ok
  defp ensure!(false, message), do: raise(message)
end
