defmodule LatticeCarrierServer.Health do
  @moduledoc """
  Loopback health listener for the pilot carrier runtime (plan 158).

  `/livez` is unauthenticated liveness: 200 whenever the VM answers HTTP.
  `/readyz` is content-free readiness: 204 only when every manifest instance
  has its identity loaded and source restore complete (the holder answers),
  its carrier listener bound, and writable durable storage proven by a full
  durability-sequence rehearsal in the log's directory; otherwise 503. Both
  responses carry an empty body — readiness detail never leaks content.
  `/carrier` application authentication is a separate listener and is
  unchanged.

  The durability rehearsal (fsync, subprocess spawn, file churn in the live
  log directory) is not repeated on every single `/readyz` poll: its result
  is cached per instance for a configurable TTL
  (`:lattice_carrier_server, :storage_check_ttl_ms`, default 5000ms; tests
  set it to 0 for determinism). The first check after boot is always
  authoritative (no cached value exists yet), and any unexpected raise
  inside the rehearsal is caught and treated as not writable, so a poll can
  never fail open.
  """

  alias Lattice.Log
  alias LatticeCarrierServer.{Durability, Holder, Listener, Manifest, Runtime, SocketOpts}

  @listener_ref {__MODULE__, :listener}
  @storage_cache __MODULE__.StorageCache
  @default_storage_check_ttl_ms 5_000
  @default_storage_check_timeout_ms 4_000

  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(health_opts) do
    ip = Keyword.fetch!(health_opts, :ip)
    port = Keyword.fetch!(health_opts, :port)

    dispatch =
      :cowboy_router.compile([
        {:_,
         [
           {"/livez", __MODULE__, :livez},
           {"/readyz", __MODULE__, :readyz}
         ]}
      ])

    transport_opts = %{socket_opts: SocketOpts.build(ip, port)}

    protocol_opts = %{
      env: %{dispatch: dispatch},
      max_header_name_length: 64,
      max_header_value_length: 4_096,
      max_headers: 64,
      max_request_line_length: 2_048,
      request_timeout: 5_000
    }

    :ranch.child_spec(@listener_ref, :ranch_tcp, transport_opts, :cowboy_clear, protocol_opts)
  end

  @doc "Bound health port, or nil when no health listener is running."
  @spec port() :: :inet.port_number() | nil
  def port do
    :ranch.get_port(@listener_ref)
  catch
    _kind, _reason -> nil
  end

  @doc false
  @spec reset_storage_cache([Path.t()]) :: :ok
  def reset_storage_cache(log_files) do
    if :ets.whereis(@storage_cache) != :undefined do
      Enum.each(log_files, &:ets.delete(@storage_cache, &1))
    end

    :ok
  end

  @doc false
  def init(req, :livez) do
    {:ok, :cowboy_req.reply(200, %{}, "", req), :livez}
  end

  def init(req, :readyz) do
    status = if ready?(), do: 204, else: 503
    {:ok, :cowboy_req.reply(status, %{}, "", req), :readyz}
  end

  @doc """
  True only when every manifest instance is ready: holder answering
  (identity loaded, source restored), listener bound, and durable storage
  writable through the full rehearsal sequence.
  """
  @spec ready?() :: boolean()
  def ready? do
    case Runtime.deployment() do
      nil -> false
      %{instances: instances} -> Enum.all?(instances, &instance_ready?/1)
    end
  end

  defp instance_ready?(%{
         name: name,
         realm: realm,
         identity_file: identity_file,
         pub: pub,
         log_file: log_file
       }) do
    identity_ready?(identity_file, realm, pub) and holder_ready?(name) and listener_bound?(name) and
      storage_writable?(log_file)
  end

  defp identity_ready?(identity_file, realm, pub) do
    Manifest.verify_identity(identity_file, realm, pub) == :ok
  catch
    _kind, _reason -> false
  end

  defp holder_ready?(name) do
    Holder.ready?(Holder.via(name)) == :ok
  catch
    _kind, _reason -> false
  end

  defp listener_bound?(name) do
    name |> Listener.ref() |> :ranch.get_port() |> is_integer()
  catch
    _kind, _reason -> false
  end

  # TTL-cached: the first read after boot (or after the cache goes stale)
  # runs the real rehearsal and is authoritative; reads within the TTL reuse
  # that result instead of re-running fsync/subprocess/file-churn work on
  # every poll. Any raise is caught and cached as "not writable", so a
  # transient failure fails closed rather than crashing the request.
  defp storage_writable?(log_file) do
    if :ets.whereis(@storage_cache) == :undefined do
      false
    else
      cached_storage_writable?(log_file)
    end
  end

  defp cached_storage_writable?(log_file) do
    now = System.monotonic_time(:millisecond)
    ttl_ms = storage_check_ttl_ms()

    case :ets.lookup(@storage_cache, log_file) do
      [{^log_file, checked_at, result}]
      when now - checked_at < ttl_ms ->
        result

      _stale_or_absent ->
        result = rehearse_storage(log_file)
        true = :ets.insert(@storage_cache, {log_file, now, result})
        result
    end
  end

  defp storage_check_ttl_ms do
    case Application.get_env(
           :lattice_carrier_server,
           :storage_check_ttl_ms,
           @default_storage_check_ttl_ms
         ) do
      ttl_ms when is_integer(ttl_ms) and ttl_ms >= 0 -> ttl_ms
      _invalid -> @default_storage_check_ttl_ms
    end
  end

  defp rehearse_storage(log_file) do
    parent = self()
    rehearsal_ref = make_ref()

    task =
      Task.async(fn ->
        try do
          with {:ok, %Log{} = log} <- Log.restore(log_file),
               :ok <- Holder.validate_log(log),
               :ok <-
                 Durability.with_target_lock(log_file, fn ->
                   Durability.rehearse_target(health_durability_impl(), log_file,
                     allocated: fn path ->
                       send(parent, {:durability_rehearsal_allocated, rehearsal_ref, path})
                     end
                   )
                 end) do
            true
          else
            _error -> false
          end
        catch
          _kind, _reason -> false
        end
      end)

    result =
      case Task.yield(task, storage_check_timeout_ms()) ||
             Task.shutdown(task, :brutal_kill) do
        {:ok, true} -> true
        _timeout_or_error -> false
      end

    cleanup_allocated_rehearsal(rehearsal_ref)
    result
  catch
    _kind, _reason -> false
  end

  defp cleanup_allocated_rehearsal(rehearsal_ref) do
    receive do
      {:durability_rehearsal_allocated, ^rehearsal_ref, path} ->
        _ = File.rm(path)
        :ok
    after
      0 -> :ok
    end
  end

  defp health_durability_impl do
    case Application.get_env(:lattice_carrier_server, :health_durability_impl) do
      module when is_atom(module) and not is_nil(module) -> module
      _invalid_or_missing -> Durability.Posix
    end
  end

  defp storage_check_timeout_ms do
    case Application.get_env(
           :lattice_carrier_server,
           :storage_check_timeout_ms,
           @default_storage_check_timeout_ms
         ) do
      timeout when is_integer(timeout) and timeout > 0 -> timeout
      _invalid -> @default_storage_check_timeout_ms
    end
  end
end

defmodule LatticeCarrierServer.Health.StorageCache do
  @moduledoc false

  use GenServer

  @impl GenServer
  def init(_opts) do
    __MODULE__ =
      :ets.new(__MODULE__, [
        :named_table,
        :set,
        :public,
        read_concurrency: true,
        write_concurrency: true
      ])

    {:ok, nil}
  end

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)
end
