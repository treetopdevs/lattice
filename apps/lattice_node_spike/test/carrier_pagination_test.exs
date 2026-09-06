defmodule LatticeNodeSpike.CarrierPaginationTest do
  use ExUnit.Case, async: false

  alias Lattice.Carrier.{WebSocket, Wire}
  alias Lattice.{Identity, Log, Sim, Sync}
  alias Lattice.Transport.WebSocket.Client
  alias Township.Matter

  @moduletag timeout: 120_000
  @repo_root Path.expand("../../..", __DIR__)
  @script Path.join(@repo_root, "apps/lattice_carrier_server/priv/server_node.exs")

  test "interrupted multi-page replay across a second-BEAM restart remains byte-identical to Sim" do
    tmp_dir =
      Path.join(System.tmp_dir!(), "lattice-paged-replay-#{System.unique_integer([:positive])}")

    File.mkdir_p!(tmp_dir)
    on_exit(fn -> File.rm_rf!(tmp_dir) end)

    sim = Sim.new(Matter, "replica:matter:paged-replay", ["clerk"], seed: "paged-replay")
    {sim, _genesis} = Sim.create_replica(sim, "clerk")

    sim =
      Enum.reduce(1..180, sim, fn index, sim ->
        {sim, _op} =
          Sim.command(sim, "clerk", :post, ["#{index}: #{String.duplicate("history ", 60)}"])

        sim
      end)

    oracle = Sim.log(sim, "clerk")
    source_path = Path.join(tmp_dir, "history.log")
    assert :ok = Log.dump(oracle, source_path)
    observer = Identity.from_seed("pagination-observer", "paged-replay-observer")
    server_identity = Identity.from_seed("pagination-server", "paged-replay-server")
    {process, port} = start_server(source_path, observer)
    conn = connect(port, observer, server_identity, oracle.replica)

    assert {:ok, %{"ops" => first_page, "next_cursor" => cursor}} =
             Client.request_envelope(conn.client, %{type: "pull", have: []})

    assert {:ok, first_ops} = Wire.decode_ops(first_page)
    assert length(first_ops) < Log.size(oracle)
    {retained, report} = Sync.deliver(Log.new(oracle.replica), first_ops)
    assert report.pending == []
    assert report.rejected == []
    assert :ok = WebSocket.close(conn)
    kill_server(process)

    {restarted, restarted_port} = start_server(source_path, observer)
    conn = connect(restarted_port, observer, server_identity, oracle.replica)

    # An unchanged authenticated log gives the same stateless cursor after restart.
    assert {:ok, %{"type" => "ops", "ops" => [_next | _rest]}} =
             Client.request_envelope(conn.client, %{type: "pull", have: [], cursor: cursor})

    assert {:ok, advertised, conn} = WebSocket.advertise(conn, retained)
    assert advertised == Log.op_ids(oracle)
    assert {:ok, remaining, conn} = WebSocket.pull(conn, Log.op_ids(retained))
    {replayed, report} = Sync.deliver(retained, remaining)
    assert report.pending == []
    assert report.rejected == []
    assert Log.op_ids(replayed) == Log.op_ids(oracle)

    assert state_bytes(replayed) == state_bytes(oracle)
    assert :ok = WebSocket.close(conn)
    true = Port.command(restarted, "stop\n")
    assert_receive {^restarted, {:exit_status, 0}}, 10_000
  end

  defp state_bytes(log) do
    Lattice.state(Matter, log) |> :erlang.term_to_binary([:deterministic, {:minor_version, 2}])
  end

  defp connect(port, observer, server_identity, replica) do
    assert {:ok, conn} =
             WebSocket.connect(
               hostname: "127.0.0.1",
               port: port,
               identity: observer,
               realm: observer.realm_id,
               peer_realm: server_identity.realm_id,
               peer_pubkey: server_identity.pub,
               replica: replica
             )

    conn
  end

  defp start_server(source_path, observer) do
    code_paths =
      :code.get_path()
      |> Enum.map(&List.to_string/1)
      |> Enum.filter(&String.contains?(&1, "_build"))

    args =
      Enum.flat_map(code_paths, &["-pa", &1]) ++
        [
          @script,
          "0",
          "pagination-server",
          "paged-replay-server",
          observer.realm_id,
          Base.encode64(observer.pub),
          source_path
        ]

    process =
      Port.open({:spawn_executable, elixir_bin()}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        {:line, 4_096},
        {:args, args},
        {:cd, @repo_root}
      ])

    on_exit(fn -> if Port.info(process), do: Port.close(process) end)
    {process, await_ready(process, [])}
  end

  defp elixir_bin do
    direct = Path.expand("~/.asdf/installs/elixir/1.19.5-otp-28/bin/elixir")
    if File.exists?(direct), do: direct, else: System.find_executable("elixir")
  end

  defp await_ready(process, seen) do
    receive do
      {^process, {:data, {:eol, "SERVER_READY " <> port}}} ->
        String.to_integer(String.trim(port))

      {^process, {:data, {_line, text}}} ->
        await_ready(process, [text | seen])

      {^process, {:exit_status, status}} ->
        flunk("pagination server exited #{status}: #{inspect(seen)}")
    after
      30_000 -> flunk("pagination server did not become ready: #{inspect(seen)}")
    end
  end

  defp kill_server(process) do
    {:os_pid, pid} = Port.info(process, :os_pid)
    {_output, 0} = System.cmd("kill", ["-9", Integer.to_string(pid)], stderr_to_stdout: true)
    assert_receive {^process, {:exit_status, _status}}, 10_000
  end
end
