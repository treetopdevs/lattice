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
  alias LatticeCarrierServer.Operator.ReleaseGate

  @relay_call_slack_ms 750
  @read_frame_budget 64_000
  @cursor_byte_budget 512

  @type courier_snapshot_token :: %{
          owner: ReleaseGate.owner(),
          holder: pid(),
          source: {:path, Path.t()},
          replica: String.t(),
          digest: binary()
        }
  @type courier_review_token :: %{
          snapshot: courier_snapshot_token(),
          op_id: Op.id(),
          candidate_digest: binary()
        }
  @type courier_receipt :: %{
          reference_id: Op.id(),
          outcome: :delivered | :present,
          frontier: [Op.id()],
          frontier_truncated: boolean(),
          generation: non_neg_integer()
        }

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
  restore completed, because `init/1` refuses otherwise. A holder fenced after an
  ambiguous persistence effect refuses readiness until the release is restarted.
  """
  @spec ready?(GenServer.server(), timeout()) :: :ok | {:error, :persistence_ambiguous}
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

  @doc "Prove the local courier's persistence path without replacing the served log."
  @spec prove_durability(GenServer.server()) :: :ok | {:error, atom()}
  def prove_durability(holder),
    do: GenServer.call(holder, :prove_courier_durability, relay_call_timeout_ms())

  @doc "Read a bounded local snapshot for an operator's external authority review."
  @spec courier_snapshot(GenServer.server()) ::
          {:ok, %{log: Log.t(), token: courier_snapshot_token()}} | {:error, atom()}
  def courier_snapshot(holder), do: GenServer.call(holder, :courier_snapshot)

  @doc "Read the bounded served snapshot without granting courier write permission."
  @spec served_snapshot(GenServer.server()) ::
          {:ok, %{log: Log.t(), token: courier_snapshot_token()}} | {:error, atom()}
  def served_snapshot(holder), do: GenServer.call(holder, :served_snapshot)

  @doc "Build the exact candidate outside the holder; semantic authorization remains the operator's job."
  @spec prepare_courier(map(), Op.t()) :: {:ok, map()} | {:error, atom()}
  def prepare_courier(%{log: log, token: token}, %Op{} = op) do
    with true <- Op.valid?(op) and token.replica == log.replica,
         :ok <- Log.verify_authenticity(log),
         {:ok, digest} <- courier_digest(log),
         true <- digest == token.digest,
         {:ok, candidate, _report, outcome} <- courier_candidate(log, op),
         :ok <- Log.verify_authenticity(candidate),
         {:ok, candidate_digest} <- courier_digest(candidate) do
      {:ok,
       %{
         log: candidate,
         outcome: outcome,
         token: %{snapshot: token, op_id: op.id, candidate_digest: candidate_digest}
       }}
    else
      {:error, reason} when is_atom(reason) -> {:error, reason}
      _ -> {:error, :invalid_courier_review}
    end
  rescue
    _ -> {:error, :invalid_courier_review}
  end

  def prepare_courier(_, _), do: {:error, :invalid_courier_review}

  @doc "Deliver the exact externally reviewed candidate only while its snapshot still matches."
  @spec courier(GenServer.server(), Op.t(), courier_review_token()) ::
          {:ok, courier_receipt()} | {:error, term()}
  def courier(holder, op, token),
    do: GenServer.call(holder, {:courier, op, token}, relay_call_timeout_ms() + 2_000)

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

    owner = Keyword.get(opts, :release_owner)
    key = {:holder, Keyword.get(opts, :release_route)}

    with {:ok, lease} <- startup_lease(owner, key),
         {:ok, log} <- load_source(source),
         :ok <- rehearse_durability(source, relay_realms, durability),
         :ok <- startup_complete(owner, lease, key) do
      {:ok,
       %{
         release_owner: owner,
         release_key: key,
         identity: identity,
         log: log,
         source: source,
         durability: durability,
         persistence_fenced: false,
         courier_durability_proven: match?({:path, _}, source) and relay_realms != [],
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

  defp startup_lease(nil, _key), do: {:ok, nil}
  defp startup_lease(owner, key), do: ReleaseGate.acquire(owner, key)
  defp startup_complete(nil, _lease, _key), do: :ok
  defp startup_complete(owner, lease, key), do: ReleaseGate.complete(owner, lease, key, self())

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

  def handle_call(:ready?, _from, %{persistence_fenced: true} = state),
    do: {:reply, {:error, :persistence_ambiguous}, state}

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

  def handle_call({:drain_release, _owner}, _from, %{persistence_fenced: true} = state),
    do: {:reply, {:error, :persistence_ambiguous}, state}

  def handle_call(:prove_courier_durability, _from, state) do
    with :ok <- courier_open(state),
         :ok <- prove_courier_path(state) do
      {:reply, :ok, %{state | courier_durability_proven: true}}
    else
      {:error, :persistence_ambiguous} ->
        {:reply, {:error, :persistence_ambiguous}, %{state | persistence_fenced: true}}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call(:served_snapshot, _from, state) do
    with :ok <- courier_open(state), {:ok, token} <- snapshot_token(state) do
      {:reply, {:ok, %{log: state.log, token: token}}, state}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call(:courier_snapshot, _from, state) do
    with :ok <- courier_open(state),
         true <- state.courier_durability_proven,
         {:ok, token} <- snapshot_token(state) do
      {:reply, {:ok, %{log: state.log, token: token}}, state}
    else
      false -> {:reply, {:error, :durability_not_proven}, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:courier, op, token}, _from, state) do
    with :ok <- courier_open(state),
         {:ok, current} <- snapshot_token(state),
         :ok <- match_review(token, current, op),
         {:ok, candidate, report, outcome} <- courier_candidate(state.log, op),
         :ok <- courier_write_proven(state, outcome),
         {:ok, digest} <- courier_digest(candidate),
         true <- digest == token.candidate_digest do
      case persist_relay(candidate, report, state) do
        {:reply, {:ok, _}, next} ->
          receipt = Map.merge(availability(candidate), %{reference_id: op.id, outcome: outcome})
          {:reply, {:ok, receipt}, next}

        refusal ->
          refusal
      end
    else
      false -> {:reply, {:error, :invalid_courier_review}, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:drain_release, owner}, _from, state) do
    if state.release_owner == owner and not ReleaseGate.accepting?(owner),
      do:
        {:reply,
         {:ok, %{holder: self(), source: state.source, pub: state.identity.pub, log: state.log}},
         state},
      else: {:reply, {:error, :release_closed}, state}
  end

  def handle_call({:relay, peer_realm, op}, _from, %{release_owner: owner} = state)
      when owner != nil do
    if ReleaseGate.accepting?(owner),
      do: relay_owned(peer_realm, op, state),
      else: {:reply, {:error, :release_closed}, state}
  end

  def handle_call({:relay, peer_realm, op}, _from, state),
    do: relay_owned(peer_realm, op, state)

  defp courier_write_proven(_state, :present), do: :ok
  defp courier_write_proven(%{courier_durability_proven: true}, :delivered), do: :ok
  defp courier_write_proven(_state, _outcome), do: {:error, :durability_not_proven}

  defp courier_open(%{persistence_fenced: true}), do: {:error, :persistence_ambiguous}
  defp courier_open(%{release_owner: nil}), do: {:error, :unguarded_courier}
  defp courier_open(%{source: {:log, _}}), do: {:error, :unsupported_courier_source}

  defp courier_open(state) do
    if ReleaseGate.accepting?(state.release_owner), do: :ok, else: {:error, :release_closed}
  end

  defp prove_courier_path(%{courier_durability_proven: true}), do: :ok

  defp prove_courier_path(%{source: {:path, path}, durability: durability} = state) do
    result =
      bounded_persistence(
        fn -> Durability.rehearse_target_isolated(durability, path) end,
        path,
        write_context(state)
      )

    case result do
      :ok ->
        :ok

      {:error, _, :ambiguous} ->
        {:error, :persistence_ambiguous}

      {:error, reason, :unchanged}
      when reason in [:release_closed, :release_identity_changed, :persistence_ambiguous] ->
        {:error, reason}

      _ ->
        {:error, :durability_unsupported}
    end
  end

  defp snapshot_token(state) do
    with {:ok, digest} <- courier_digest(state.log) do
      {:ok,
       %{
         owner: state.release_owner,
         holder: self(),
         source: state.source,
         replica: state.log.replica,
         digest: digest
       }}
    end
  end

  defp courier_digest(log) do
    if map_size(log.ops) + length(log.quarantine) <= 4_000 and
         :erlang.external_size(log) <= 16 * 1024 * 1024 do
      bytes = :erlang.term_to_iovec(log, [:deterministic])

      if IO.iodata_length(bytes) <= 16 * 1024 * 1024,
        do: {:ok, :crypto.hash(:sha256, bytes)},
        else: {:error, :courier_history_budget}
    else
      {:error, :courier_history_budget}
    end
  end

  defp match_review(
         %{snapshot: snapshot, op_id: id, candidate_digest: digest} = token,
         current,
         %Op{} = op
       )
       when map_size(token) == 3 do
    cond do
      snapshot != current -> {:error, :stale_served_history}
      id != op.id or not Op.valid?(op) -> {:error, :invalid_courier_review}
      not is_binary(digest) or byte_size(digest) != 32 -> {:error, :invalid_courier_review}
      true -> :ok
    end
  end

  defp match_review(_, _, _), do: {:error, :invalid_courier_review}

  defp courier_candidate(log, op) do
    {candidate, report} = Sync.deliver(log, [op])

    cond do
      Map.get(log.ops, op.id) == op ->
        {:ok, log, report, :present}

      Map.get(candidate.ops, op.id) == op and report.accepted == [op.id] ->
        {:ok, candidate, report, :delivered}

      true ->
        {:error, :courier_delivery_refused}
    end
  end

  defp relay_owned(_realm, _op, %{persistence_fenced: true} = state),
    do: {:reply, {:error, :persistence_ambiguous}, state}

  defp relay_owned(peer_realm, op, state) do
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
        fill_read_page(Enum.drop(entries, offset), kind, token, offset, [], 0)
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
    {:ok, page_reply(kind, Enum.reverse(encoded), nil)}
  end

  defp fill_read_page([entry | remaining], kind, token, offset, encoded, bytes) do
    # A persisted op naming an atom outside the closed wire vocabulary is not served: no
    # peer would admit its frame. The whole read is refused rather than omitting the op,
    # which would silently strand its descendants as pending on the client.
    with {:ok, value} <- page_value(kind, entry) do
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
          {:ok, page_reply(kind, [value], next_cursor)}

        true ->
          previous_id = if kind == :pull, do: hd(encoded)["id"], else: hd(encoded)
          cursor = page_cursor(token, offset + count - 1, previous_id)
          {:ok, page_reply(kind, Enum.reverse(encoded), cursor)}
      end
    end
  end

  defp page_value(:pull, %Op{} = op), do: Wire.encode_op_checked(op)
  defp page_value(:frontier, id), do: {:ok, id}

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
    case bounded_atomic_dump(log, path, state) do
      :ok ->
        availability = availability(log)
        subscribers = notify_subscribers(state.subscribers, availability)
        state = %{state | log: log, subscribers: subscribers}
        {:reply, {:ok, report}, state}

      {:error, reason, disposition} ->
        persistence_refusal(reason, disposition, state)

      {:error, reason} ->
        persistence_refusal(reason, :ambiguous, state)
    end
  end

  defp persistence_refusal(:persistence_ambiguous, :unchanged, state),
    do: persistence_refusal(:persistence_ambiguous, :ambiguous, state)

  defp persistence_refusal(reason, :unchanged, state),
    do: {:reply, {:error, {:persistence_failed, reason}}, state}

  defp persistence_refusal(reason, _disposition, state) do
    _ = fence_write(write_context(state))
    {:reply, {:error, {:persistence_failed, reason}}, %{state | persistence_fenced: true}}
  end

  defp bounded_atomic_dump(log, path, %{durability: durability} = state) do
    bounded_persistence(
      fn ->
        with :ok <- disk_matches(path, state.log),
             {:ok, temp_path} <- Durability.secure_temp(path) do
          try do
            atomic_dump(log, path, temp_path, durability)
          after
            _ = File.rm(temp_path)
          end
        end
      end,
      path,
      write_context(state)
    )
  end

  # Compare exact deterministic dump bytes before replacement. This is linear
  # serialization/IO, not a cryptographic replay on every participant relay.
  # Read at most the expected dump length plus one byte, including corrupt files.
  defp disk_matches(path, log) do
    expected = Log.dump_bytes(log)

    with {:ok, file} <- :file.open(String.to_charlist(path), [:read, :binary, :raw]) do
      try do
        case :file.read(file, byte_size(expected) + 1) do
          {:ok, ^expected} -> :ok
          _ -> {:error, :disk_history_diverged}
        end
      after
        :file.close(file)
      end
    else
      {:error, _} -> {:error, :disk_history_diverged}
    end
  end

  defp bounded_persistence(fun, path, context) do
    caller = self()
    ref = make_ref()

    {pid, monitor} =
      spawn_monitor(fn ->
        worker = self()
        spawn(fn -> watch_persistence_owner(caller, worker) end)

        result = owned_persistence(fun, path, context)
        send(caller, {ref, result})
      end)

    receive do
      {^ref, result} ->
        Process.demonitor(monitor, [:flush])
        result

      {:DOWN, ^monitor, :process, ^pid, reason} ->
        {:error, {:persistence_worker_exit, reason}, :ambiguous}
    after
      persistence_timeout_ms() ->
        _ = fence_write(context)
        Process.exit(pid, :kill)

        receive do
          {:DOWN, ^monitor, :process, ^pid, _} -> :ok
        after
          250 -> :ok
        end

        receive do
          {^ref, _} -> :ok
        after
          0 -> :ok
        end

        _ = Durability.bounded_cleanup_orphaned_temps(path, @orphan_cleanup_timeout_ms)
        {:error, :persistence_timeout, :ambiguous}
    end
  end

  defp write_context(state),
    do: %{owner: state.release_owner, key: state.release_key, holder: self()}

  defp fence_write(%{owner: nil}), do: :ok
  defp fence_write(context), do: ReleaseGate.fence_writes(context.owner, context.key)

  defp begin_write(%{owner: nil}), do: {:ok, nil}

  defp begin_write(context),
    do: ReleaseGate.acquire(context.owner, {:holder_write, context.key, context.holder})

  defp authorize_write(context, lease) do
    cond do
      not Process.alive?(context.holder) -> {:error, :release_identity_changed}
      context.owner == nil -> :ok
      true -> ReleaseGate.authorize_write(context.owner, lease)
    end
  end

  defp finish_write(%{owner: nil}, _lease), do: :ok
  defp finish_write(context, lease), do: ReleaseGate.finish(context.owner, lease)

  defp owned_persistence(fun, path, context) do
    with {:ok, lease} <- begin_write(context) do
      result =
        try do
          result =
            Durability.with_target_lock(path, fn ->
              with :ok <- authorize_write(context, lease), do: fun.()
            end)

          case result do
            {:error, reason} -> {:error, reason, :unchanged}
            other -> other
          end
        catch
          kind, reason -> {:error, {:persistence_exception, kind, reason}, :ambiguous}
        end

      case result do
        {:error, _, :ambiguous} -> fence_write(context)
        _ -> :ok
      end

      case finish_write(context, lease) do
        :ok ->
          result

        _ ->
          _ = fence_write(context)
          {:error, :release_closed, :ambiguous}
      end
    else
      {:error, reason} -> {:error, reason, :unchanged}
    end
  end

  # The worker is unlinked so its failure cannot kill the holder. Its guardian
  # still terminates it if the holder dies during a filesystem operation.
  defp watch_persistence_owner(owner, worker) do
    owner_monitor = Process.monitor(owner)
    worker_monitor = Process.monitor(worker)

    receive do
      {:DOWN, ^owner_monitor, :process, ^owner, _} -> Process.exit(worker, :kill)
      {:DOWN, ^worker_monitor, :process, ^worker, _} -> :ok
    end
  end

  # Persist-before-ack: write, sync the file, atomically rename, then sync
  # the containing directory. Only a fully synced sequence acknowledges.
  defp atomic_dump(log, path, temp_path, durability) do
    with {:ok, %File.Stat{mode: mode}} <- File.stat(path),
         :ok <- Log.dump(log, temp_path),
         :ok <- File.chmod(temp_path, Bitwise.band(mode, 0o777)),
         :ok <- durability.sync_file(temp_path) do
      with :ok <- durability.rename(temp_path, path),
           :ok <- durability.sync_directory(Path.dirname(path)) do
        :ok
      else
        {:error, reason} -> {:error, reason, :ambiguous}
      end
    else
      {:error, reason} -> {:error, reason, :unchanged}
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
