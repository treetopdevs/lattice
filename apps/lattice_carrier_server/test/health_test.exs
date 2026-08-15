defmodule LatticeCarrierServer.HealthTest do
  @moduledoc """
  Health endpoints for the pilot carrier runtime (plan 158).

  `/livez` is unauthenticated and answers 200 whenever the VM serves HTTP.
  `/readyz` is content-free: it requires identity load, complete source
  restore, listener availability, and writable durable storage across every
  manifest instance, answering 204 or 503 with an empty body either way.
  `/carrier` application authentication is unchanged and covered elsewhere.
  """

  use ExUnit.Case, async: false

  alias Lattice.{Identity, Log}

  # Referenced dynamically so this file stays RED-runnable before the
  # health listener exists.
  @health_mod LatticeCarrierServer.Health
  @storage_cache LatticeCarrierServer.Health.StorageCache

  @moduletag timeout: 120_000

  defmodule SlowDurability do
    @moduledoc false

    def sync_file(_path) do
      Process.sleep(250)
      :ok
    end

    def rename(temp_path, path), do: File.rename(temp_path, path)
    def sync_directory(_path), do: :ok
  end

  defmodule CountingDurability do
    @moduledoc false

    def sync_file(path) do
      :ets.update_counter(__MODULE__, :sync_file_calls, 1)
      [{:controller, controller}] = :ets.lookup(__MODULE__, :controller)
      send(controller, {:counting_sync_started, self()})

      receive do
        :continue_counting_sync -> :ok
      after
        5_000 -> raise "counting durability was not released"
      end

      LatticeCarrierServer.Durability.Posix.sync_file(path)
    end

    def rename(temp_path, path) do
      LatticeCarrierServer.Durability.Posix.rename(temp_path, path)
    end

    def sync_directory(path) do
      LatticeCarrierServer.Durability.Posix.sync_directory(path)
    end
  end

  setup %{tmp_dir: tmp_dir} do
    {:ok, _inets} = Application.ensure_all_started(:inets)

    replica = "replica:carrier-health:test"
    log_dir = Path.join(tmp_dir, "data")
    File.mkdir_p!(log_dir)
    log_path = Path.join(log_dir, "matter.log")
    assert :ok = replica |> Log.new() |> Log.dump(log_path)
    seed = :crypto.hash(:sha256, "carrier-health-#{Path.basename(tmp_dir)}")
    identity_path = Path.join(tmp_dir, "town-node.identity")
    File.write!(identity_path, Base.encode16(seed, case: :lower))
    File.chmod!(identity_path, 0o600)

    observer = Identity.from_seed("instrument", "carrier-health-observer")

    manifest = %{
      "version" => 1,
      "health" => %{"ip" => "127.0.0.1", "port" => 0},
      "instances" => [
        %{
          "name" => "health-pilot",
          "realm" => "town-node",
          "identity_file" => identity_path,
          "log_file" => log_path,
          "listener" => %{"ip" => "127.0.0.1", "port" => 0},
          "trusted_peers" => [
            %{"realm" => observer.realm_id, "pubkey" => Base.encode64(observer.pub)}
          ],
          "relay_realms" => [observer.realm_id]
        }
      ]
    }

    manifest_path = Path.join(tmp_dir, "manifest.json")
    File.write!(manifest_path, Jason.encode!(manifest))

    previous = Application.get_env(:lattice_carrier_server, :manifest, :missing)

    on_exit(fn ->
      File.chmod(log_dir, 0o700)
      :ok = Application.stop(:lattice_carrier_server)
      restore_manifest_config(previous)
      {:ok, _apps} = Application.ensure_all_started(:lattice_carrier_server)
    end)

    :ok = Application.stop(:lattice_carrier_server)
    Application.put_env(:lattice_carrier_server, :manifest, manifest_path)
    {:ok, _apps} = Application.ensure_all_started(:lattice_carrier_server)

    {:ok,
     identity_path: identity_path,
     log_dir: log_dir,
     log_path: log_path,
     manifest_path: manifest_path}
  end

  @tag :tmp_dir
  test "livez answers unauthenticated while readyz is content-free", _context do
    health_port = apply(@health_mod, :port, [])
    assert is_integer(health_port)

    assert {200, _body} = get("http://127.0.0.1:#{health_port}/livez")
    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")
  end

  @tag :tmp_dir
  test "read-only startup does not replace the live custody log", %{
    log_path: log_path,
    manifest_path: manifest_path
  } do
    before_start_stat = File.stat!(log_path, time: :posix)
    before_start_bytes = File.read!(log_path)
    restart_read_only(manifest_path)
    after_start = File.stat!(log_path, time: :posix)

    assert {after_start.major_device, after_start.minor_device, after_start.inode} ==
             {before_start_stat.major_device, before_start_stat.minor_device,
              before_start_stat.inode}

    assert File.read!(log_path) == before_start_bytes
  end

  @tag :tmp_dir
  test "read-only readiness does not require a writable custody directory", %{
    log_dir: log_dir,
    manifest_path: manifest_path
  } do
    restart_read_only(manifest_path)
    health_port = apply(@health_mod, :port, [])

    File.chmod!(log_dir, 0o500)
    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")
  end

  @tag :tmp_dir
  test "read-only readiness still restores and validates the custody log", %{
    log_path: log_path,
    manifest_path: manifest_path
  } do
    restart_read_only(manifest_path)
    health_port = apply(@health_mod, :port, [])
    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    File.rm!(log_path)
    :ok = apply(@health_mod, :reset_storage_cache, [[log_path]])
    assert {503, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    File.write!(log_path, "corrupt")
    :ok = apply(@health_mod, :reset_storage_cache, [[log_path]])
    assert {503, ""} = get("http://127.0.0.1:#{health_port}/readyz")
  end

  @tag :tmp_dir
  test "an uncached readyz probe does not rewrite or replace the live custody log", %{
    log_path: log_path
  } do
    File.touch!(log_path, 1)
    before = File.stat!(log_path, time: :posix)
    before_bytes = File.read!(log_path)
    :ok = apply(@health_mod, :reset_storage_cache, [[log_path]])
    assert [] = :ets.lookup(@storage_cache, log_path)
    started_at = System.monotonic_time(:millisecond)

    health_port = apply(@health_mod, :port, [])
    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")
    assert [{^log_path, checked_at, _sequence, :ok}] = :ets.lookup(@storage_cache, log_path)
    assert checked_at >= started_at

    after_probe = File.stat!(log_path, time: :posix)

    assert {after_probe.major_device, after_probe.minor_device, after_probe.inode} ==
             {before.major_device, before.minor_device, before.inode}

    assert after_probe.mtime == before.mtime
    assert File.read!(log_path) == before_bytes
  end

  @tag :tmp_dir
  test "concurrent cache misses share one storage rehearsal", %{log_path: log_path} do
    previous_impl =
      Application.get_env(:lattice_carrier_server, :health_durability_impl, :missing)

    previous_ttl = Application.get_env(:lattice_carrier_server, :storage_check_ttl_ms, :missing)

    on_exit(fn ->
      restore_env(:health_durability_impl, previous_impl)
      restore_env(:storage_check_ttl_ms, previous_ttl)
    end)

    handler_id = {__MODULE__, make_ref()}
    wait_event = [:lattice, :carrier, :storage_check_wait]

    assert :ok =
             Lattice.Carrier.Telemetry.attach(
               handler_id,
               wait_event,
               &__MODULE__.handle_storage_wait_event/4,
               self()
             )

    on_exit(fn -> Lattice.Carrier.Telemetry.detach(handler_id) end)

    :ets.new(CountingDurability, [:named_table, :public, :set])

    true =
      :ets.insert(CountingDurability, [
        {:sync_file_calls, 0},
        {:controller, self()}
      ])

    Application.put_env(:lattice_carrier_server, :health_durability_impl, CountingDurability)
    Application.put_env(:lattice_carrier_server, :storage_check_ttl_ms, 5_000)
    :ok = apply(@health_mod, :reset_storage_cache, [[log_path]])
    health_port = apply(@health_mod, :port, [])

    sockets = Enum.map(1..8, fn _index -> readyz_socket(health_port) end)
    test_pid = self()

    requests =
      Enum.map(sockets, fn socket ->
        Task.async(fn -> send_readyz_when_released(socket, test_pid) end)
      end)

    Enum.each(requests, fn request ->
      assert_receive {:readyz_socket_ready, request_pid} when request_pid == request.pid
    end)

    Enum.each(requests, &send(&1.pid, :send_readyz))

    Enum.each(requests, fn request ->
      assert_receive {:readyz_request_sent, request_pid} when request_pid == request.pid
    end)

    assert_receive {:counting_sync_started, sync_pid}, 5_000
    assert_receive {:storage_check_wait, ^wait_event, %{}, %{}}, 5_000
    send(sync_pid, :continue_counting_sync)

    responses = Enum.map(requests, &Task.await(&1, 10_000))

    assert Enum.all?(responses, &String.starts_with?(&1, "HTTP/1.1 204"))
    assert :ets.lookup(CountingDurability, :sync_file_calls) == [{:sync_file_calls, 1}]
    assert [] = :ets.lookup(@storage_cache, {:storage_rehearsal, log_path})
  end

  @tag :tmp_dir
  test "readiness failures emit only a content-free reason atom", %{log_path: log_path} do
    handler_id = {__MODULE__, make_ref()}
    event = [:lattice, :carrier, :readiness_failure]
    test_pid = self()

    assert :ok =
             Lattice.Carrier.Telemetry.attach(
               handler_id,
               event,
               &__MODULE__.handle_readiness_event/4,
               test_pid
             )

    on_exit(fn -> Lattice.Carrier.Telemetry.detach(handler_id) end)

    File.rm!(log_path)
    :ok = apply(@health_mod, :reset_storage_cache, [[log_path]])
    health_port = apply(@health_mod, :port, [])
    assert {503, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    assert_receive {:readiness_failure, ^event, %{}, metadata}
    assert metadata == %{reason: :log_restore_failed}
  end

  @tag :tmp_dir
  test "readyz fails closed while durable storage is unwritable and recovers", %{
    log_dir: log_dir,
    log_path: log_path
  } do
    health_port = apply(@health_mod, :port, [])

    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    File.chmod!(log_dir, 0o500)
    assert {503, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    assert [{^log_path, _checked_at, _sequence, {:error, :storage_rehearsal_failed}}] =
             :ets.lookup(@storage_cache, log_path)

    # Liveness is unaffected by readiness.
    assert {200, _body} = get("http://127.0.0.1:#{health_port}/livez")

    File.chmod!(log_dir, 0o700)
    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")
    assert [{^log_path, _checked_at, _sequence, :ok}] = :ets.lookup(@storage_cache, log_path)

    File.chmod!(log_dir, 0o777)
    :ok = apply(@health_mod, :reset_storage_cache, [[log_path]])
    assert {503, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    File.chmod!(log_dir, 0o700)
    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")
  end

  @tag :tmp_dir
  test "readyz rejects a non-numeric cache TTL instead of caching forever", %{
    log_dir: log_dir,
    log_path: log_path
  } do
    previous_ttl = Application.get_env(:lattice_carrier_server, :storage_check_ttl_ms, :missing)

    on_exit(fn ->
      restore_env(:storage_check_ttl_ms, previous_ttl)
    end)

    Application.put_env(:lattice_carrier_server, :storage_check_ttl_ms, "5000")
    health_port = apply(@health_mod, :port, [])

    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    stale_at = System.monotonic_time(:millisecond) - 5_001
    true = :ets.insert(@storage_cache, {log_path, stale_at, 0, :ok})

    File.chmod!(log_dir, 0o500)
    assert {503, ""} = get("http://127.0.0.1:#{health_port}/readyz")
  end

  @tag :tmp_dir
  test "readiness cache uses ETS instead of persistent_term", %{log_path: log_path} do
    persistent_key = {@health_mod, :storage_writable, log_path}
    :persistent_term.erase(persistent_key)

    health_port = apply(@health_mod, :port, [])
    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    assert :ets.whereis(@storage_cache) != :undefined
    assert [{^log_path, checked_at, _sequence, :ok}] = :ets.lookup(@storage_cache, log_path)
    assert is_integer(checked_at)
    assert :persistent_term.get(persistent_key, :missing) == :missing
  end

  @tag :tmp_dir
  test "readyz fails closed when the configured durable log disappears or is corrupt", %{
    log_path: log_path
  } do
    health_port = apply(@health_mod, :port, [])
    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    File.rm!(log_path)
    :ok = apply(@health_mod, :reset_storage_cache, [[log_path]])
    assert {503, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    File.write!(log_path, "corrupt")
    :ok = apply(@health_mod, :reset_storage_cache, [[log_path]])
    assert {503, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    invalid = %Log{replica: nil, ops: %{}, referenced: :not_a_set, quarantine: []}
    bytes = :erlang.term_to_binary({:lattice_log_dump_v1, invalid}, [:deterministic])
    File.write!(log_path, bytes)
    :ok = apply(@health_mod, :reset_storage_cache, [[log_path]])
    assert {503, ""} = get("http://127.0.0.1:#{health_port}/readyz")
  end

  @tag :tmp_dir
  test "readyz bounds a stalled durability rehearsal", %{log_path: log_path} do
    previous_impl =
      Application.get_env(:lattice_carrier_server, :health_durability_impl, :missing)

    previous_timeout =
      Application.get_env(:lattice_carrier_server, :storage_check_timeout_ms, :missing)

    previous_readiness_timeout =
      Application.get_env(:lattice_carrier_server, :readiness_timeout_ms, :missing)

    on_exit(fn ->
      restore_env(:health_durability_impl, previous_impl)
      restore_env(:storage_check_timeout_ms, previous_timeout)
      restore_env(:readiness_timeout_ms, previous_readiness_timeout)
    end)

    storage_timeout_ms = 25
    cleanup_timeout_ms = 250
    http_margin_ms = 500
    Application.put_env(:lattice_carrier_server, :health_durability_impl, SlowDurability)
    Application.put_env(:lattice_carrier_server, :storage_check_timeout_ms, storage_timeout_ms)
    Application.put_env(:lattice_carrier_server, :readiness_timeout_ms, 1)
    assert apply(@health_mod, :effective_readiness_timeout_ms, []) == 5_775
    :ok = apply(@health_mod, :reset_storage_cache, [[log_path]])

    started_at = System.monotonic_time(:millisecond)
    health_port = apply(@health_mod, :port, [])
    assert {503, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    assert System.monotonic_time(:millisecond) - started_at <
             storage_timeout_ms + cleanup_timeout_ms + http_margin_ms

    assert Path.wildcard("#{log_path}.tmp.*") == []
  end

  @tag :tmp_dir
  test "an uncached readiness rehearsal reclaims a stale sibling temp", %{log_path: log_path} do
    orphan = "#{log_path}.tmp.stale-readiness"
    File.write!(orphan, "stale full-copy residue")
    :ok = apply(@health_mod, :reset_storage_cache, [[log_path]])

    health_port = apply(@health_mod, :port, [])
    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")
    refute File.exists?(orphan)
    assert Path.wildcard("#{log_path}.tmp.*") == []
  end

  @tag :tmp_dir
  test "readyz fails closed when the durable identity disappears", %{
    identity_path: identity_path,
    log_path: log_path
  } do
    health_port = apply(@health_mod, :port, [])
    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    File.rm!(identity_path)
    :ok = apply(@health_mod, :reset_storage_cache, [[log_path]])
    assert {503, ""} = get("http://127.0.0.1:#{health_port}/readyz")
  end

  @tag :tmp_dir
  test "an application restart cannot reuse a prior readiness rehearsal", %{
    log_dir: log_dir,
    log_path: log_path
  } do
    previous_ttl = Application.get_env(:lattice_carrier_server, :storage_check_ttl_ms, :missing)

    on_exit(fn ->
      restore_env(:storage_check_ttl_ms, previous_ttl)
    end)

    Application.put_env(:lattice_carrier_server, :storage_check_ttl_ms, 5_000)
    health_port = apply(@health_mod, :port, [])
    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    :ok = Application.stop(:lattice_carrier_server)
    assert {:ok, _apps} = Application.ensure_all_started(:lattice_carrier_server)
    restarted_health_port = apply(@health_mod, :port, [])
    File.chmod!(log_dir, 0o500)
    assert {503, ""} = get("http://127.0.0.1:#{restarted_health_port}/readyz")

    File.chmod!(log_dir, 0o700)
    :ok = apply(@health_mod, :reset_storage_cache, [[log_path]])
    assert {204, ""} = get("http://127.0.0.1:#{restarted_health_port}/readyz")
  end

  defp get(url) do
    request = {String.to_charlist(url), []}

    assert {:ok, {{_http, status, _reason}, _headers, body}} =
             :httpc.request(:get, request, [], body_format: :binary)

    {status, body}
  end

  defp readyz_socket(port) do
    assert {:ok, socket} =
             :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], 2_000)

    socket
  end

  defp send_readyz_when_released(socket, test_pid) do
    send(test_pid, {:readyz_socket_ready, self()})

    receive do
      :send_readyz -> :ok
    end

    request = "GET /readyz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    :ok = :gen_tcp.send(socket, request)
    send(test_pid, {:readyz_request_sent, self()})

    try do
      receive_socket_response(socket, [])
    after
      :gen_tcp.close(socket)
    end
  end

  defp receive_socket_response(socket, chunks) do
    case :gen_tcp.recv(socket, 0, 5_000) do
      {:ok, chunk} -> receive_socket_response(socket, [chunk | chunks])
      {:error, :closed} -> chunks |> Enum.reverse() |> IO.iodata_to_binary()
    end
  end

  defp restart_read_only(manifest_path) do
    manifest = Jason.decode!(File.read!(manifest_path))

    read_only_manifest =
      update_in(manifest, ["instances"], fn instances ->
        Enum.map(instances, &Map.delete(&1, "relay_realms"))
      end)

    :ok = Application.stop(:lattice_carrier_server)
    File.write!(manifest_path, Jason.encode!(read_only_manifest))
    {:ok, _apps} = Application.ensure_all_started(:lattice_carrier_server)
    :ok
  end

  @doc false
  def handle_readiness_event(event, measurements, metadata, pid) do
    send(pid, {:readiness_failure, event, measurements, metadata})
  end

  @doc false
  def handle_storage_wait_event(event, measurements, metadata, pid) do
    send(pid, {:storage_check_wait, event, measurements, metadata})
  end

  defp restore_manifest_config(:missing) do
    Application.delete_env(:lattice_carrier_server, :manifest)
  end

  defp restore_manifest_config(value) do
    Application.put_env(:lattice_carrier_server, :manifest, value)
  end

  defp restore_env(key, :missing), do: Application.delete_env(:lattice_carrier_server, key)
  defp restore_env(key, value), do: Application.put_env(:lattice_carrier_server, key, value)
end
