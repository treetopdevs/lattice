defmodule LatticeCarrierServer.Health do
  @moduledoc """
  Loopback health listener for the pilot carrier runtime (plan 158).

  `/livez` is unauthenticated liveness: 200 whenever the VM answers HTTP.
  `/readyz` is content-free readiness: 204 only when every manifest instance
  has its identity loaded and source restore complete (the holder answers)
  and its carrier listener bound. Relay-enabled instances additionally require
  writable durable storage proven by a full, isolated durability-sequence
  rehearsal in the log's directory; read-only instances do not claim or
  require write custody, but still restore and validate the on-disk log.
  Otherwise readiness answers 503. Both responses carry an empty body —
  readiness detail never leaks content.
  `/carrier` application authentication is a separate listener and is
  unchanged.

  For each uncached relay-enabled check, the identity gate first reads and
  derives the identity and invokes `id -u`. The durability rehearsal then
  restores and structurally validates the custody log, including content
  hashing and Ed25519 verification for every operation. It performs a second
  full read, then two secure sibling allocations (each invoking `id -u` before
  `mktemp`), a full-size sibling write and file sync, a replacement rename, and
  a directory `sync` subprocess in the live log directory: six subprocesses in
  total. This cost grows with both log bytes and operation count; operators with
  large logs may need to raise `:storage_check_timeout_ms`. It transiently needs room for a full second
  copy of the custody log in the same directory and holds another full byte
  copy in the BEAM heap. Concurrent cache misses for one log share a
  single-flight rehearsal; different logs may still rehearse concurrently. The
  rehearsal never rewrites the custody log. Its result is cached per instance
  for a configurable TTL
  (`:lattice_carrier_server, :storage_check_ttl_ms`, default 5000ms; tests
  set it to 0 for determinism). The first check after boot is always
  authoritative (no cached value exists yet), and any unexpected raise
  inside the rehearsal is caught and treated as not writable, so a poll can
  never fail open. Startup separately proves replacement of relay-enabled real
  targets; the recurring isolated rehearsal cannot detect a target-specific
  immutable file attribute added after boot.

  The rehearsal holds the same node-local target lock as relay persistence.
  A slow uncached probe can therefore consume a concurrent relay's bounded
  persistence deadline and make that relay refuse acknowledgement with
  `:persistence_timeout`. Operators must size the storage-check interval and
  timeout together with the persistence deadline for their largest custody log.

  The loopback listener is unauthenticated, explicitly uses a 5-second request
  timeout, and does not override Ranch's default 1024-connection cap or
  Cowboy's 60-second idle timeout. A request may therefore spend up to 5
  seconds being read, 9.75 seconds in readiness by default, and then retain an
  idle keepalive connection. Operators must restrict access to the configured
  loopback interface. Holder, listener, and identity gates run before
  the uncached full-log rehearsal, avoiding its I/O and
  signature-verification work when an instance is already definitionally
  unavailable; the holder gate itself can still wait up to 5 seconds.

  `:readiness_timeout_ms` has an availability-preserving floor: it cannot be
  configured below the storage deadline plus the holder-call deadline, bounded
  orphan cleanup, and identity/scheduler slack. Lower configured values are
  raised to that effective floor rather than guaranteeing false 503 responses.
  """

  alias Lattice.Carrier.Telemetry
  alias Lattice.Log
  alias LatticeCarrierServer.{Durability, Holder, Listener, Manifest, Runtime, SocketOpts}

  @listener_ref {__MODULE__, :listener}
  @storage_cache __MODULE__.StorageCache
  @default_storage_check_ttl_ms 5_000
  @default_storage_check_timeout_ms 4_000
  @holder_readiness_timeout_ms 5_000
  @orphan_cleanup_timeout_ms 250
  @storage_rehearsal_poll_ms 10
  @storage_rehearsal_wait_slack_ms 100
  @identity_and_scheduler_slack_ms 500
  @readiness_fixed_budget_ms @holder_readiness_timeout_ms + @orphan_cleanup_timeout_ms +
                               @identity_and_scheduler_slack_ms
  @default_readiness_timeout_ms @default_storage_check_timeout_ms + @readiness_fixed_budget_ms

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
      Enum.each(log_files, fn log_file ->
        :ets.delete(@storage_cache, log_file)
        :ets.delete(@storage_cache, {:storage_rehearsal, log_file})
      end)
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
  (identity loaded, source restored), listener bound, and, for relay-enabled
  instances, durable storage writable through the full rehearsal sequence.
  """
  @spec ready?() :: boolean()
  def ready? do
    case Runtime.deployment() do
      nil -> false
      %{instances: instances} -> instances_ready?(instances)
    end
  end

  defp instances_ready?(instances) do
    instances
    |> Task.async_stream(&instance_ready?/1,
      max_concurrency: max(length(instances), 1),
      ordered: false,
      timeout: effective_readiness_timeout_ms(),
      on_timeout: :kill_task
    )
    |> Enum.all?(&match?({:ok, true}, &1))
  end

  defp instance_ready?(%{
         name: name,
         realm: realm,
         identity_file: identity_file,
         pub: pub,
         log_file: log_file,
         relay_enabled?: relay_enabled?
       }) do
    result =
      with :ok <- holder_ready(name),
           :ok <- listener_ready(name),
           :ok <- identity_ready(identity_file, realm, pub),
           :ok <- storage_ready(relay_enabled?, log_file) do
        :ok
      end

    case result do
      :ok ->
        true

      {:error, reason} ->
        emit_readiness_failure(reason)
        false
    end
  catch
    _kind, _reason ->
      emit_readiness_failure(:readiness_exception)
      false
  end

  defp identity_ready(identity_file, realm, pub) do
    case Manifest.verify_identity(identity_file, realm, pub) do
      :ok -> :ok
      _error -> {:error, :identity_invalid}
    end
  catch
    _kind, _reason -> {:error, :identity_unavailable}
  end

  defp holder_ready(name) do
    case Holder.ready?(Holder.via(name), @holder_readiness_timeout_ms) do
      :ok -> :ok
      _error -> {:error, :holder_unavailable}
    end
  catch
    _kind, _reason -> {:error, :holder_unavailable}
  end

  defp listener_ready(name) do
    if name |> Listener.ref() |> :ranch.get_port() |> is_integer() do
      :ok
    else
      {:error, :listener_unavailable}
    end
  catch
    _kind, _reason -> {:error, :listener_unavailable}
  end

  defp emit_readiness_failure(reason) do
    Telemetry.execute([:lattice, :carrier, :readiness_failure], %{}, %{reason: reason})
  catch
    _kind, _reason -> :ok
  end

  # TTL-cached: the first read after boot (or after the cache goes stale)
  # runs the applicable integrity check and is authoritative; reads within
  # the TTL reuse that result. Relay-enabled instances add the isolated
  # write/fsync/rename rehearsal after restore and validation. Any raise is
  # caught and cached as a failure rather than crashing the request.
  defp storage_ready(relay_enabled?, log_file) do
    if :ets.whereis(@storage_cache) == :undefined do
      {:error, :storage_cache_unavailable}
    else
      cached_storage_result(log_file, relay_enabled?)
    end
  end

  defp cached_storage_result(log_file, relay_enabled?) do
    now = System.monotonic_time(:millisecond)
    ttl_ms = storage_check_ttl_ms()

    case :ets.lookup(@storage_cache, log_file) do
      [{^log_file, checked_at, _sequence, result}]
      when now - checked_at < ttl_ms ->
        result

      _stale_or_absent ->
        deadline =
          now + storage_check_timeout_ms() + @orphan_cleanup_timeout_ms +
            @storage_rehearsal_wait_slack_ms

        single_flight_storage_result(log_file, relay_enabled?, deadline)
    end
  end

  defp single_flight_storage_result(log_file, relay_enabled?, deadline) do
    claim_key = {:storage_rehearsal, log_file}
    claim_sequence = System.unique_integer([:monotonic, :positive])
    claim = {claim_key, self(), claim_sequence}

    if :ets.insert_new(@storage_cache, claim) do
      run_claimed_storage_check(log_file, relay_enabled?, claim)
    else
      await_storage_rehearsal(
        log_file,
        relay_enabled?,
        claim_key,
        claim_sequence,
        deadline
      )
    end
  end

  defp run_claimed_storage_check(log_file, relay_enabled?, claim) do
    result = check_storage(log_file, relay_enabled?)
    completed_at = System.monotonic_time(:millisecond)
    completion_sequence = System.unique_integer([:monotonic, :positive])
    cache_storage_result(log_file, completed_at, completion_sequence, result)
    result
  after
    :ets.delete_object(@storage_cache, claim)
  end

  defp await_storage_rehearsal(
         log_file,
         relay_enabled?,
         claim_key,
         attempted_sequence,
         deadline
       ) do
    case :ets.lookup(@storage_cache, claim_key) do
      [{^claim_key, owner, claim_sequence}] ->
        emit_storage_check_wait()

        await_storage_claim(
          log_file,
          relay_enabled?,
          claim_key,
          owner,
          claim_sequence,
          deadline
        )

      [] ->
        retry_storage_check(log_file, relay_enabled?, attempted_sequence, deadline)
    end
  end

  defp await_storage_claim(
         log_file,
         relay_enabled?,
         claim_key,
         owner,
         claim_sequence,
         deadline
       ) do
    cond do
      not Process.alive?(owner) ->
        :ets.delete_object(@storage_cache, {claim_key, owner, claim_sequence})
        retry_storage_check(log_file, relay_enabled?, claim_sequence, deadline)

      System.monotonic_time(:millisecond) >= deadline ->
        {:error, :storage_rehearsal_wait_timeout}

      true ->
        Process.sleep(@storage_rehearsal_poll_ms)

        storage_result_after_claim(
          log_file,
          relay_enabled?,
          claim_key,
          claim_sequence,
          deadline
        )
    end
  end

  defp storage_result_after_claim(
         log_file,
         relay_enabled?,
         claim_key,
         claim_sequence,
         deadline
       ) do
    case :ets.lookup(@storage_cache, claim_key) do
      [{^claim_key, owner, ^claim_sequence}] ->
        await_storage_claim(
          log_file,
          relay_enabled?,
          claim_key,
          owner,
          claim_sequence,
          deadline
        )

      _finished_or_replaced ->
        case :ets.lookup(@storage_cache, log_file) do
          [{^log_file, _checked_at, sequence, result}] when sequence > claim_sequence ->
            result

          _absent_or_older ->
            retry_storage_check(log_file, relay_enabled?, claim_sequence, deadline)
        end
    end
  end

  defp retry_storage_check(log_file, relay_enabled?, observed_sequence, deadline) do
    case :ets.lookup(@storage_cache, log_file) do
      [{^log_file, _checked_at, sequence, result}] when sequence > observed_sequence ->
        result

      _absent_or_older ->
        if System.monotonic_time(:millisecond) < deadline do
          single_flight_storage_result(log_file, relay_enabled?, deadline)
        else
          {:error, :storage_rehearsal_wait_timeout}
        end
    end
  end

  defp emit_storage_check_wait do
    Telemetry.execute([:lattice, :carrier, :storage_check_wait], %{}, %{})
  catch
    _kind, _reason -> :ok
  end

  defp cache_storage_result(log_file, checked_at, sequence, result) do
    record = {log_file, checked_at, sequence, result}

    unless :ets.insert_new(@storage_cache, record) do
      :ets.select_replace(@storage_cache, [
        {
          {log_file, :"$1", :"$2", :"$3"},
          [{:"=<", :"$2", sequence}],
          [{:const, record}]
        }
      ])
    end

    :ok
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

  defp check_storage(log_file, relay_enabled?) do
    task = Task.async(fn -> run_storage_check(log_file, relay_enabled?) end)

    case Task.yield(task, storage_check_timeout_ms()) || Task.shutdown(task, :brutal_kill) do
      {:ok, result} ->
        result

      _timeout_or_error ->
        maybe_cleanup_rehearsal_temps(log_file, relay_enabled?)
        {:error, :storage_rehearsal_timeout}
    end
  catch
    _kind, _reason -> {:error, :storage_rehearsal_exception}
  end

  defp run_storage_check(log_file, relay_enabled?) do
    case restore_and_validate_storage(log_file) do
      {:ok, _log} when not relay_enabled? -> :ok
      {:ok, _log} -> classify_storage_rehearsal(locked_storage_rehearsal(log_file))
      {:error, _reason} = error -> error
    end
  catch
    _kind, _reason -> {:error, :storage_rehearsal_exception}
  end

  defp restore_and_validate_storage(log_file) do
    case Log.restore(log_file) do
      {:ok, %Log{} = log} ->
        case Holder.validate_log(log) do
          :ok -> {:ok, log}
          _error -> {:error, :log_validation_failed}
        end

      _error ->
        {:error, :log_restore_failed}
    end
  end

  defp maybe_cleanup_rehearsal_temps(_log_file, false), do: :ok

  defp maybe_cleanup_rehearsal_temps(log_file, true) do
    _ = Durability.bounded_cleanup_orphaned_temps(log_file, @orphan_cleanup_timeout_ms)
    :ok
  end

  defp classify_storage_rehearsal(:ok), do: :ok

  defp classify_storage_rehearsal({:error, {Durability, :target_lock_aborted}}),
    do: {:error, :storage_lock_unavailable}

  defp classify_storage_rehearsal({:error, {:orphan_cleanup_failed, _path, _reason}}),
    do: {:error, :orphan_cleanup_failed}

  defp classify_storage_rehearsal({:error, _reason}),
    do: {:error, :storage_rehearsal_failed}

  defp locked_storage_rehearsal(log_file) do
    Durability.with_target_lock(log_file, fn ->
      with :ok <- Durability.cleanup_orphaned_temps(log_file) do
        Durability.rehearse_target_isolated(health_durability_impl(), log_file)
      end
    end)
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

  @doc false
  @spec effective_readiness_timeout_ms() :: pos_integer()
  def effective_readiness_timeout_ms do
    configured =
      case Application.get_env(
             :lattice_carrier_server,
             :readiness_timeout_ms,
             @default_readiness_timeout_ms
           ) do
        timeout when is_integer(timeout) and timeout > 0 -> timeout
        _invalid -> @default_readiness_timeout_ms
      end

    max(configured, storage_check_timeout_ms() + @readiness_fixed_budget_ms)
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
