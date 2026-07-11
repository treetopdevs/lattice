defmodule LatticeCarrierServer.TownshipProjectionTest do
  use ExUnit.Case, async: false

  alias Lattice.{Identity, Log}
  alias Township.AuditBundle
  alias TownshipWeb.CarrierProjection

  @moduletag timeout: 120_000
  @script Path.expand("../priv/server_node.exs", __DIR__)
  @source_dir Path.expand("../../../artifacts/township", __DIR__)
  @source_path Path.join(@source_dir, "matter.log")

  test "a second-BEAM server restart moves one projection from fresh to stale to fresh" do
    {:ok, _apps} = Application.ensure_all_started(:township_web)
    assert :ok = AuditBundle.verify(@source_dir)
    {:ok, source_log} = Log.restore(@source_path)
    observer = Identity.from_seed("instrument", "stable-server-projection")
    server_identity = Identity.from_seed("town-node", "stable-carrier-server")
    fixed_port = free_port()
    server = spawn_server(fixed_port, observer)
    assert elem(server, 1) == fixed_port

    topic = "township:stable-server:#{System.unique_integer([:positive])}"

    projection =
      start_supervised!(
        {CarrierProjection,
         connect_opts: connect_opts(fixed_port, observer, server_identity, source_log.replica),
         replica: source_log.replica,
         peer_realm: server_identity.realm_id,
         pubsub: TownshipWeb.PubSub,
         topic: topic,
         schedule: :manual}
      )

    assert {:ok, :connecting} = CarrierProjection.subscribe(projection)
    assert {:ok, {:fresh, fresh_payload}} = CarrierProjection.refresh(projection)
    assert payload_ids(fresh_payload) == source_log |> Log.op_ids() |> Enum.sort()

    stop_server(server)

    assert {:ok, {:stale, stale_payload}} = CarrierProjection.refresh(projection)
    assert payload_ids(stale_payload) == payload_ids(fresh_payload)
    assert stale_payload.provenance.freshness == :stale
    assert stale_payload.provenance.last_error

    restarted_server = spawn_server(fixed_port, observer)
    assert elem(restarted_server, 1) == fixed_port

    assert {:ok, {:fresh, recovered_payload}} = CarrierProjection.refresh(projection)
    assert payload_ids(recovered_payload) == payload_ids(fresh_payload)
    assert recovered_payload.provenance.freshness == :fresh
    assert recovered_payload.provenance.last_error == nil

    stop_server(restarted_server)
  end

  defp payload_ids(payload) do
    payload.causal_replay["nodes"] |> Enum.map(& &1["id"]) |> Enum.sort()
  end

  defp connect_opts(port, observer, server_identity, replica) do
    [
      hostname: "127.0.0.1",
      port: port,
      identity: observer,
      realm: observer.realm_id,
      peer_realm: server_identity.realm_id,
      peer_pubkey: server_identity.pub,
      replica: replica
    ]
  end

  defp spawn_server(port_number, observer) do
    args =
      Enum.flat_map(code_paths(), &["-pa", &1]) ++
        [
          @script,
          Integer.to_string(port_number),
          "town-node",
          "stable-carrier-server",
          observer.realm_id,
          Base.encode64(observer.pub),
          @source_path
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

  defp stop_server({port, _ws_port}) do
    true = Port.command(port, "stop\n")
    assert_receive {^port, {:exit_status, 0}}, 10_000
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
    |> Enum.map(&List.to_string/1)
    |> Enum.filter(&String.contains?(&1, "_build"))
  end

  defp elixir_bin do
    shim = Path.expand("~/.asdf/shims/elixir")

    cond do
      File.exists?(shim) -> shim
      path = System.find_executable("elixir") -> path
      true -> flunk("no elixir executable available to spawn the server")
    end
  end

  defp free_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true])
    {:ok, {_ip, port}} = :inet.sockname(socket)
    :ok = :gen_tcp.close(socket)
    port
  end

  defp repo_root, do: Path.expand("../../..", __DIR__)
  defp format_output(lines), do: lines |> Enum.reverse() |> Enum.join("\n")
end
