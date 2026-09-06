defmodule LatticeCarrierServer.Holder do
  @moduledoc """
  Owns the carrier's served log, durable relay path, and availability subscribers.

  A path-backed relay is acknowledged only after the complete durability
  sequence (`LatticeCarrierServer.Durability`): temporary dump written,
  file synced, atomically renamed over the source, and the containing
  directory synced. A relay-enabled path holder rehearses that sequence at
  startup and refuses to serve on a platform that cannot prove it. The
  supported pilot platform is Linux; macOS `F_FULLFSYNC` is not requested,
  so macOS remains a development-only substrate.
  """

  use GenServer

  alias Lattice.Carrier.Wire
  alias Lattice.{Identity, Log, Op, Sync}
  alias LatticeCarrierServer.{Durability, Secret}

  @frontier_limit 64
  @default_persistence_timeout_ms 4_000
  @orphan_cleanup_timeout_ms 250
  @relay_call_slack_ms 750
  @read_frame_budget 64_000
  @cursor_byte_budget 512

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.fetch!(opts, :name))
  end

  @spec via(term()) :: GenServer.name()
  def via(instance) do
    {:via, Registry, {LatticeCarrierServer.Registry, {:holder, instance}}}
  end

  @spec session_context(GenServer.server()) :: {Identity.t(), String.t()}
  def session_context(holder), do: GenServer.call(holder, :session_context)

  @doc """
  Readiness probe: a reply proves the identity is loaded and the source
  restore completed, because `init/1` refuses otherwise.
  """
  @spec ready?(GenServer.server(), timeout()) :: :ok
  def ready?(holder, timeout \\ 5_000), do: GenServer.call(holder, :ready?, timeout)

  @spec op_ids(GenServer.server()) :: [Lattice.Op.id()]
  def op_ids(holder), do: GenServer.call(holder, :op_ids)

  @spec missing_for(GenServer.server(), [Lattice.Op.id()]) :: [Lattice.Op.t()]
  def missing_for(holder, have_ids), do: GenServer.call(holder, {:missing_for, have_ids})

  @doc "Read one byte-budgeted page from a snapshot-bound, stateless continuation."
  @spec read_page(GenServer.server(), :frontier | :pull, [Op.id()], map() | nil) ::
          {:ok, map()} | {:error, atom()}
  def read_page(holder, kind, have_ids, cursor) when kind in [:frontier, :pull] do
    GenServer.call(holder, {:read_page, kind, have_ids, cursor})
  end

  @spec relay(GenServer.server(), String.t(), Lattice.Op.t()) ::
          {:ok, Sync.report()} | {:error, term()}
  def relay(holder, peer_realm, op) do
    GenServer.call(holder, {:relay, peer_realm, op}, relay_call_timeout_ms())
  end

  @spec state_report(GenServer.server()) :: {:ok, map()} | {:error, :read_only}
  def state_report(holder), do: GenServer.call(holder, :state_report)

  @spec subscribe(GenServer.server(), pid()) :: {:ok, map()}
  def subscribe(holder, subscriber) when is_pid(subscriber) do
    GenServer.call(holder, {:subscribe, subscriber})
  end

  @spec unsubscribe(GenServer.server(), pid()) :: :ok
  def unsubscribe(holder, subscriber) when is_pid(subscriber) do
    GenServer.call(holder, {:unsubscribe, subscriber})
  end

  @spec acknowledge(GenServer.server(), pid(), non_neg_integer()) :: {:ok, map() | nil}
  def acknowledge(holder, subscriber, generation)
      when is_pid(subscriber) and is_integer(generation) and generation >= 0 do
    GenServer.call(holder, {:acknowledge, subscriber, generation})
  end

  @impl GenServer
  def init(opts) do
    identity = opts |> Keyword.fetch!(:identity) |> unwrap_identity()
    source = Keyword.fetch!(opts, :source)
    relay_realms = Keyword.fetch!(opts, :relay_realms)
    durability = Keyword.get(opts, :durability) || Durability.Posix

    with {:ok, log} <- load_source(source),
         :ok <- rehearse_durability(source, relay_realms, durability) do
      {:ok,
       %{
         identity: identity,
         log: log,
         source: source,
         durability: durability,
         state_reporter: Keyword.get(opts, :state_reporter),
         relay_realms: MapSet.new(relay_realms),
         subscribers: %{}
       }}
    else
      {:error, {:durability_unsupported, _reason} = refusal} -> {:stop, refusal}
      {:error, :target_lock_unavailable} -> {:stop, :target_lock_unavailable}
      {:error, :orphan_cleanup_failed} -> {:stop, :orphan_cleanup_failed}
      {:error, reason} -> {:stop, {:source_error, reason}}
    end
  end

  # Crash reports and `:sys.get_status/1` must never render the private key:
  # replace the identity's priv bytes in any formatted state.
  @impl GenServer
  def format_status(status) do
    Map.new(status, fn
      {:state, %{identity: %Identity{} = identity} = state} ->
        {:state, %{state | identity: %{identity | priv: :redacted}}}

      other ->
        other
    end)
  end

  @impl GenServer
  def handle_call(:session_context, _from, state) do
    {:reply, {state.identity, state.log.replica}, state}
  end

  def handle_call(:ready?, _from, state) do
    {:reply, :ok, state}
  end

  def handle_call(:op_ids, _from, state) do
    {:reply, state.log |> Log.op_ids() |> Enum.sort(), state}
  end

  def handle_call({:missing_for, have_ids}, _from, state) do
    {:reply, Sync.missing(state.log, MapSet.new(have_ids)), state}
  end

  def handle_call({:read_page, kind, have_ids, cursor}, _from, state) do
    {:reply, build_read_page(state.log, kind, have_ids, cursor), state}
  end

  def handle_call(:state_report, _from, %{state_reporter: nil} = state) do
    {:reply, {:error, :read_only}, state}
  end

  def handle_call(:state_report, _from, %{state_reporter: reporter} = state) do
    {:reply, {:ok, reporter.report(state.log)}, state}
  end

  def handle_call({:subscribe, subscriber}, _from, state) do
    subscribers =
      Map.put_new_lazy(state.subscribers, subscriber, fn ->
        %{monitor: Process.monitor(subscriber), outstanding_generation: nil}
      end)

    {:reply, {:ok, availability(state.log)}, %{state | subscribers: subscribers}}
  end

  def handle_call({:unsubscribe, subscriber}, _from, state) do
    {entry, subscribers} = Map.pop(state.subscribers, subscriber)

    if entry do
      Process.demonitor(entry.monitor, [:flush])
    end

    {:reply, :ok, %{state | subscribers: subscribers}}
  end

  def handle_call({:acknowledge, subscriber, generation}, _from, state) do
    case Map.fetch(state.subscribers, subscriber) do
      {:ok, %{outstanding_generation: ^generation} = entry} ->
        latest = availability(state.log)
        reply = if latest.generation > generation, do: latest, else: nil
        entry = %{entry | outstanding_generation: nil}
        subscribers = Map.put(state.subscribers, subscriber, entry)
        {:reply, {:ok, reply}, %{state | subscribers: subscribers}}

      _other ->
        {:reply, {:ok, nil}, state}
    end
  end

  def handle_call({:relay, peer_realm, op}, _from, state) do
    if MapSet.member?(state.relay_realms, peer_realm) do
      {log, report} = Sync.deliver(state.log, [op])
      persist_relay(log, report, state)
    else
      {:reply, {:error, :read_only}, state}
    end
  end

  @impl GenServer
  def handle_info({:DOWN, monitor, :process, subscriber, _reason}, state) do
    subscribers =
      case Map.fetch(state.subscribers, subscriber) do
        {:ok, %{monitor: ^monitor}} -> Map.delete(state.subscribers, subscriber)
        _other -> state.subscribers
      end

    {:noreply, %{state | subscribers: subscribers}}
  end

  defp build_read_page(log, kind, have_ids, cursor) do
    if is_list(have_ids) and Enum.all?(have_ids, &is_binary/1) do
      ids = log |> Log.op_ids() |> Enum.sort()
      have = have_ids |> Enum.uniq() |> Enum.sort()
      snapshot = page_digest({:carrier_page_v1, kind, log.replica, ids})
      token = %{"version" => 1, "snapshot" => snapshot}
      token = if kind == :pull, do: Map.put(token, "have", page_digest(have)), else: token
      entries = if kind == :pull, do: Sync.missing(log, MapSet.new(have)), else: ids

      with {:ok, offset} <- page_offset(cursor, token, entries, kind) do
        {:ok, fill_read_page(Enum.drop(entries, offset), kind, token, offset, [], 0)}
      end
    else
      {:error, :malformed}
    end
  end

  defp page_offset(nil, _token, _entries, _kind), do: {:ok, 0}

  defp page_offset(cursor, token, entries, kind) when is_map(cursor) do
    offset = Map.get(cursor, "offset")
    after_id = Map.get(cursor, "after")

    cond do
      byte_size(Jason.encode!(cursor)) > @cursor_byte_budget or
          Enum.sort(Map.keys(cursor)) != Enum.sort(["offset", "after" | Map.keys(token)]) ->
        {:error, :malformed_cursor}

      cursor["version"] != 1 or not is_integer(offset) or offset <= 0 or
        not sized_binary?(after_id, 43) or not sized_binary?(cursor["snapshot"], 64) or
          (kind == :pull and not sized_binary?(cursor["have"], 64)) ->
        {:error, :malformed_cursor}

      Map.take(cursor, Map.keys(token)) != token ->
        {:error, :stale_cursor}

      offset > length(entries) or page_entry_id(Enum.at(entries, offset - 1), kind) != after_id ->
        {:error, :malformed_cursor}

      true ->
        {:ok, offset}
    end
  end

  defp page_offset(_cursor, _token, _entries, _kind), do: {:error, :malformed_cursor}

  defp sized_binary?(value, size), do: is_binary(value) and byte_size(value) == size

  defp fill_read_page([], kind, _token, _offset, encoded, _bytes) do
    page_reply(kind, Enum.reverse(encoded), nil)
  end

  defp fill_read_page([entry | remaining], kind, token, offset, encoded, bytes) do
    value = if kind == :pull, do: Wire.encode_op(entry), else: entry
    count = length(encoded) + 1
    candidate_bytes = bytes + byte_size(Jason.encode!(value))
    cursor = page_cursor(token, offset + count, page_entry_id(entry, kind))
    next_cursor = if remaining == [], do: nil, else: cursor

    size =
      byte_size(Jason.encode!(page_reply(kind, [], next_cursor))) + candidate_bytes + count - 1

    cond do
      size <= @read_frame_budget ->
        fill_read_page(remaining, kind, token, offset, [value | encoded], candidate_bytes)

      encoded == [] ->
        # A single oversized op cannot fit any page. Emit it once rather than loop
        # on an empty continuation; clients retain their explicit frame refusal.
        page_reply(kind, [value], next_cursor)

      true ->
        previous_id = if kind == :pull, do: hd(encoded)["id"], else: hd(encoded)
        cursor = page_cursor(token, offset + count - 1, previous_id)
        page_reply(kind, Enum.reverse(encoded), cursor)
    end
  end

  defp page_reply(kind, entries, cursor) do
    reply =
      if kind == :pull,
        do: %{"type" => "ops", "ops" => entries},
        else: %{"type" => "frontier_result", "ids" => entries}

    if cursor, do: Map.put(reply, "next_cursor", cursor), else: reply
  end

  defp page_cursor(token, offset, after_id) do
    Map.merge(token, %{"offset" => offset, "after" => after_id})
  end

  defp page_entry_id(%Op{id: id}, :pull), do: id
  defp page_entry_id(id, :frontier), do: id

  defp page_digest(term) do
    :crypto.hash(:sha256, :erlang.term_to_binary(term)) |> Base.encode16(case: :lower)
  end

  defp unwrap_identity(%Secret{} = secret), do: Secret.unwrap(secret)
  defp unwrap_identity(identity), do: identity

  defp load_source({:log, %Log{} = log}), do: {:ok, log}
  defp load_source({:path, path}) when is_binary(path), do: restore_path(path)
  defp load_source(_source), do: {:error, :invalid_source}

  @doc false
  @spec restore_path(Path.t()) :: {:ok, Log.t()} | {:error, term()}
  def restore_path(path) when is_binary(path) do
    with :ok <- cleanup_startup_temps(path),
         :ok <- preload_lattice_core(),
         {:ok, %Log{} = log} <- Log.restore(path),
         :ok <- validate_log(log) do
      {:ok, log}
    end
  end

  defp cleanup_startup_temps(path) do
    case Durability.with_target_lock(
           path,
           fn -> Durability.cleanup_orphaned_temps(path) end,
           retries: 3
         ) do
      {:error, {Durability, :target_lock_aborted}} -> {:error, :target_lock_unavailable}
      {:error, {:orphan_cleanup_failed, _path, _reason}} -> {:error, :orphan_cleanup_failed}
      result -> result
    end
  end

  defp persist_relay(log, report, %{log: log} = state) do
    {:reply, {:ok, report}, state}
  end

  defp persist_relay(log, report, %{source: {:path, path}} = state) do
    case bounded_atomic_dump(log, path, state.durability) do
      :ok ->
        availability = availability(log)
        subscribers = notify_subscribers(state.subscribers, availability)
        state = %{state | log: log, subscribers: subscribers}
        {:reply, {:ok, report}, state}

      {:error, reason} ->
        {:reply, {:error, {:persistence_failed, reason}}, state}
    end
  end

  defp bounded_atomic_dump(log, path, durability) do
    task =
      Task.async(fn ->
        try do
          Durability.with_target_lock(path, fn ->
            with {:ok, temp_path} <- Durability.secure_temp(path) do
              try do
                atomic_dump(log, path, temp_path, durability)
              after
                _ = File.rm(temp_path)
              end
            end
          end)
        catch
          kind, reason -> {:error, {:persistence_exception, kind, reason}}
        end
      end)

    {result, timed_out?} =
      case Task.yield(task, persistence_timeout_ms()) ||
             Task.shutdown(task, :brutal_kill) do
        {:ok, task_result} -> {task_result, false}
        _timeout_or_error -> {{:error, :persistence_timeout}, true}
      end

    if timed_out? do
      _ = Durability.bounded_cleanup_orphaned_temps(path, @orphan_cleanup_timeout_ms)
    end

    result
  catch
    kind, reason -> {:error, {:persistence_exception, kind, reason}}
  end

  # Persist-before-ack: write, sync the file, atomically rename, then sync
  # the containing directory. Only a fully synced sequence acknowledges.
  defp atomic_dump(log, path, temp_path, durability) do
    with {:ok, %File.Stat{mode: mode}} <- File.stat(path),
         :ok <- Log.dump(log, temp_path),
         :ok <- File.chmod(temp_path, Bitwise.band(mode, 0o777)),
         :ok <- durability.sync_file(temp_path),
         :ok <- durability.rename(temp_path, path),
         :ok <- durability.sync_directory(Path.dirname(path)) do
      :ok
    end
  end

  # Only relay-enabled path holders persist, so only they must prove the
  # durability sequence before serving.
  defp rehearse_durability({:path, path}, [_realm | _realms], durability) do
    case Durability.with_target_lock(
           path,
           fn -> Durability.rehearse_target(durability, path) end,
           retries: 3
         ) do
      :ok -> :ok
      {:error, {Durability, :target_lock_aborted}} -> {:error, :target_lock_unavailable}
      {:error, reason} -> {:error, {:durability_unsupported, reason}}
    end
  end

  defp rehearse_durability(_source, _relay_realms, _durability), do: :ok

  defp availability(log) do
    frontier = log |> Log.frontier() |> Enum.sort()

    %{
      generation: Log.size(log) + length(Log.quarantine(log)),
      frontier: Enum.take(frontier, @frontier_limit),
      frontier_truncated: length(frontier) > @frontier_limit
    }
  end

  defp notify_subscribers(subscribers, availability) do
    holder = self()

    Map.new(subscribers, fn
      {subscriber, %{outstanding_generation: nil} = entry} ->
        send(subscriber, {:lattice_carrier_ops_available, holder, availability})
        {subscriber, %{entry | outstanding_generation: availability.generation}}

      subscriber_entry ->
        subscriber_entry
    end)
  end

  defp preload_lattice_core do
    :lattice_core
    |> Application.spec(:modules)
    |> List.wrap()
    |> Enum.reduce_while(:ok, fn module, :ok ->
      case Code.ensure_loaded(module) do
        {:module, ^module} -> {:cont, :ok}
        {:error, reason} -> {:halt, {:error, {:module_load_failed, module, reason}}}
      end
    end)
  end

  defp persistence_timeout_ms do
    case Application.get_env(
           :lattice_carrier_server,
           :persistence_timeout_ms,
           @default_persistence_timeout_ms
         ) do
      timeout when is_integer(timeout) and timeout > 0 -> timeout
      _invalid -> @default_persistence_timeout_ms
    end
  end

  @doc false
  @spec relay_call_timeout_ms() :: pos_integer()
  def relay_call_timeout_ms do
    persistence_timeout_ms() + @orphan_cleanup_timeout_ms + @relay_call_slack_ms
  end

  @doc false
  @spec validate_log(Log.t()) :: :ok | {:error, :invalid_log_structure}
  def validate_log(%Log{
        replica: replica,
        ops: ops,
        referenced: %MapSet{} = referenced,
        quarantine: quarantine
      })
      when is_binary(replica) and byte_size(replica) > 0 and is_map(ops) and is_list(quarantine) do
    expected_referenced =
      Enum.reduce(ops, MapSet.new(), fn {_id, op}, acc ->
        MapSet.union(acc, MapSet.new(op.deps))
      end)

    valid_ops? =
      Enum.all?(ops, fn
        {id, %Op{id: op_id, replica: ^replica, deps: deps} = op} when is_binary(id) ->
          op_id == id and is_list(deps) and Enum.all?(deps, &Map.has_key?(ops, &1)) and
            Op.valid?(op)

        _invalid ->
          false
      end)

    with true <- valid_ops?,
         true <- MapSet.equal?(referenced, expected_referenced),
         {:ok, _verified} <-
           Log.verified_quarantine(%Log{
             replica: replica,
             ops: ops,
             referenced: referenced,
             quarantine: quarantine
           }) do
      :ok
    else
      _invalid -> {:error, :invalid_log_structure}
    end
  rescue
    _error -> {:error, :invalid_log_structure}
  end

  def validate_log(_invalid), do: {:error, :invalid_log_structure}
end
