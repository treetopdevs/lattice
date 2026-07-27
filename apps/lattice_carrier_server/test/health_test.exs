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
          ]
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

    {:ok, log_dir: log_dir, log_path: log_path}
  end

  @tag :tmp_dir
  test "livez answers unauthenticated while readyz is content-free", _context do
    health_port = apply(@health_mod, :port, [])
    assert is_integer(health_port)

    assert {200, _body} = get("http://127.0.0.1:#{health_port}/livez")
    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")
  end

  @tag :tmp_dir
  test "readyz fails closed while durable storage is unwritable and recovers", %{
    log_dir: log_dir
  } do
    health_port = apply(@health_mod, :port, [])

    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    File.chmod!(log_dir, 0o500)
    assert {503, ""} = get("http://127.0.0.1:#{health_port}/readyz")
    # Liveness is unaffected by readiness.
    assert {200, _body} = get("http://127.0.0.1:#{health_port}/livez")

    File.chmod!(log_dir, 0o700)
    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")
  end

  @tag :tmp_dir
  test "readyz rejects a non-numeric cache TTL instead of caching forever", %{
    log_dir: log_dir,
    log_path: log_path
  } do
    previous_ttl = Application.get_env(:lattice_carrier_server, :storage_check_ttl_ms)

    on_exit(fn ->
      Application.put_env(:lattice_carrier_server, :storage_check_ttl_ms, previous_ttl)
    end)

    Application.put_env(:lattice_carrier_server, :storage_check_ttl_ms, "5000")
    health_port = apply(@health_mod, :port, [])

    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    cache_key = {@health_mod, :storage_writable, log_path}
    stale_at = System.monotonic_time(:millisecond) - 5_001
    :persistent_term.put(cache_key, {stale_at, true})

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
    assert [{^log_path, checked_at, true}] = :ets.lookup(@storage_cache, log_path)
    assert is_integer(checked_at)
    assert :persistent_term.get(persistent_key, :missing) == :missing
  end

  @tag :tmp_dir
  test "an application restart cannot reuse a prior readiness rehearsal", %{
    log_dir: log_dir
  } do
    previous_ttl = Application.get_env(:lattice_carrier_server, :storage_check_ttl_ms)

    on_exit(fn ->
      Application.put_env(:lattice_carrier_server, :storage_check_ttl_ms, previous_ttl)
    end)

    Application.put_env(:lattice_carrier_server, :storage_check_ttl_ms, 5_000)
    health_port = apply(@health_mod, :port, [])
    assert {204, ""} = get("http://127.0.0.1:#{health_port}/readyz")

    :ok = Application.stop(:lattice_carrier_server)
    File.chmod!(log_dir, 0o500)
    {:ok, _apps} = Application.ensure_all_started(:lattice_carrier_server)

    restarted_health_port = apply(@health_mod, :port, [])
    assert {503, ""} = get("http://127.0.0.1:#{restarted_health_port}/readyz")
  end

  defp get(url) do
    request = {String.to_charlist(url), []}

    assert {:ok, {{_http, status, _reason}, _headers, body}} =
             :httpc.request(:get, request, [], body_format: :binary)

    {status, body}
  end

  defp restore_manifest_config(:missing) do
    Application.delete_env(:lattice_carrier_server, :manifest)
  end

  defp restore_manifest_config(value) do
    Application.put_env(:lattice_carrier_server, :manifest, value)
  end
end
