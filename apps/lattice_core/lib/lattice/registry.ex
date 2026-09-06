defmodule Lattice.Registry do
  @moduledoc """
  The Replica materialization plane: the durable per-`{realm, replica}` store and
  lifecycle manager.

  It owns each pair's op-log, lifecycle (`:live | :dormant | :tombstoned`), monitors,
  and inbox processing. Materializing starts a `Lattice.Materializer` process (the
  live cache); when that process stops, the pair goes `:dormant` — the log persists.
  All state changes flow through the same `Lattice.Log`/`Lattice.Reduce`/
  `Lattice.Authority` code as sync (design invariant 1).

  Durable messaging:

    * `deliver/4` authors a `{:message, payload}` inbox op; the target's next
      materialization delivers it to monitors exactly once (an in-log
      `{:delivered, id}` ack makes re-delivery idempotent) in causal order
      (behavior 11).
    * `call/4` authors a `{:request, ref, query}` op and returns a `Lattice.Promise`;
      the target materialization answers with a `{:response, ref, result}` op;
      `await/3` reads the result from the log, surviving dormancy of either side
      (behavior 12).

  Lifecycle:

    * `monitor/3` subscribes a pid to `{:lattice_lifecycle, key, state}` and
      `{:lattice_message, key, payload}` notifications (behavior 13).
    * `tombstone/2` appends a permanent `:tombstone` op; a tombstoned pair can never
      rematerialize, on every realm (behavior 13).

  Persistence: `dump/3` / `restore/4` move a log to/from disk for the realm
  death-and-resurrection test (behavior 14).
  """

  use GenServer

  alias Lattice.{Authority, Dag, Identity, Log, Materializer, Op, Promise, Reduce, Sync}

  @name __MODULE__

  # --- Public API ----------------------------------------------------------

  def start_link(_opts \\ []), do: GenServer.start_link(__MODULE__, %{}, name: @name)

  @doc "Register a realm's copy of a replica (optionally with an existing log)."
  def host(%Identity{} = identity, module, replica, log \\ nil) do
    GenServer.call(@name, {:host, identity, module, replica, log})
  end

  @doc "Bring `{realm, replica}` live: start a materializer, reduce, process inbox."
  def materialize(realm, replica), do: GenServer.call(@name, {:materialize, {realm, replica}})

  @doc "Send `{realm, replica}` dormant (stops the live process; log persists)."
  def go_dormant(realm, replica), do: GenServer.call(@name, {:go_dormant, {realm, replica}})

  @doc "Permanently tombstone `{realm, replica}` (an op; blocks rematerialization)."
  def tombstone(realm, replica), do: GenServer.call(@name, {:tombstone, {realm, replica}})

  @doc "Current lifecycle of `{realm, replica}`."
  def lifecycle(realm, replica), do: GenServer.call(@name, {:lifecycle, {realm, replica}})

  @doc "Materialized state of `{realm, replica}` (authority quarantine applied)."
  def state(realm, replica), do: GenServer.call(@name, {:state, {realm, replica}})

  @doc "The op-log held by `{realm, replica}`."
  def log(realm, replica), do: GenServer.call(@name, {:log, {realm, replica}})

  @doc "Answer a query against the current materialized state (live fast-path)."
  def query(key, q), do: GenServer.call(@name, {:query, key, q})

  @doc "Subscribe `pid` to lifecycle + message notifications for `{realm, replica}`."
  def monitor(realm, replica, pid), do: GenServer.call(@name, {:monitor, {realm, replica}, pid})

  @doc "Durably send `payload` from one realm to another (delivered on materialize)."
  def deliver(from_realm, to_realm, replica, payload) do
    GenServer.call(@name, {:deliver, from_realm, to_realm, replica, payload})
  end

  @doc "Reconcile two realms' logs for a replica and reprocess inbox where live."
  def sync(realm_a, realm_b, replica) do
    GenServer.call(@name, {:sync, realm_a, realm_b, replica})
  end

  @doc "Issue a durable call; returns a `Lattice.Promise`."
  def call(from_realm, to_realm, replica, query) do
    GenServer.call(@name, {:call, from_realm, to_realm, replica, query})
  end

  @doc "Resolve a promise from `realm`'s log: `{:ok, result}` or `:pending`."
  def await(realm, replica, %Promise{} = promise) do
    GenServer.call(@name, {:await, {realm, replica}, promise})
  end

  @doc "Dump `{realm, replica}`'s log to disk."
  def dump(realm, replica, path), do: GenServer.call(@name, {:dump, {realm, replica}, path})

  @doc "Restore a realm's replica from a disk dump (re-hosts it, dormant)."
  def restore(%Identity{} = identity, module, replica, path) do
    GenServer.call(@name, {:restore, identity, module, replica, path})
  end

  @doc "Clear all materializations (used by `Lattice.reset!/0`)."
  def reset, do: GenServer.call(@name, :reset)

  # --- Server --------------------------------------------------------------

  @impl true
  def init(_), do: {:ok, %{entries: %{}, refs: %{}}}

  @impl true
  def handle_call({:host, identity, module, replica, log}, _from, st) do
    key = {identity.realm_id, replica}
    entry = new_entry(identity, module, log || Log.new(replica))
    {:reply, :ok, put_entry(st, key, entry)}
  end

  def handle_call({:materialize, key}, _from, st) do
    with {:ok, entry} <- fetch(st, key) do
      cond do
        # A tombstone is an op: once a *root-authored* one is in the log (here or
        # arrived via sync) the pair can never rematerialize, on every realm
        # (behavior 13). A tombstone from any other author is ignored (Authority).
        Authority.tombstoned?(entry.log) ->
          entry = %{entry | lifecycle: :tombstoned}
          {:reply, {:error, :tombstoned}, put_entry(st, key, entry)}

        # Idempotent: already live — return current state without restarting (a second
        # start_child would return {:error, {:already_started, _}}).
        entry.lifecycle == :live and is_pid(entry.mat_pid) and Process.alive?(entry.mat_pid) ->
          {:reply, {:ok, current_state(entry)}, st}

        true ->
          {entry, delivered} = process_inbox(entry)
          {pid, ref} = start_materializer(key)
          entry = %{entry | lifecycle: :live, mat_pid: pid, mat_ref: ref}
          st = st |> put_entry(key, entry) |> put_ref(ref, key)
          notify(entry, {:lattice_lifecycle, key, :live})
          deliver_messages(entry, key, delivered)
          {:reply, {:ok, current_state(entry)}, st}
      end
    else
      :error -> {:reply, {:error, :unknown}, st}
    end
  end

  def handle_call({:go_dormant, key}, _from, st) do
    case fetch(st, key) do
      {:ok, %{lifecycle: :live} = entry} ->
        st = stop_materializer(st, entry)
        entry = %{entry | lifecycle: :dormant, mat_pid: nil, mat_ref: nil}
        notify(entry, {:lattice_lifecycle, key, :dormant})
        {:reply, :ok, put_entry(st, key, entry)}

      {:ok, _entry} ->
        {:reply, :ok, st}

      :error ->
        {:reply, {:error, :unknown}, st}
    end
  end

  def handle_call({:tombstone, key}, _from, st) do
    case fetch(st, key) do
      {:ok, entry} ->
        # Tombstone is a privileged, irreversible kill switch: only the replica's
        # bound root may author one. A non-root request is refused, and even if an
        # attacker forged the op directly, `Authority.tombstoned?/1` would ignore it.
        if Authority.root(entry.log) == entry.identity.pub do
          op = author(entry, :tombstone, {:tombstone, key})
          log = Log.append!(entry.log, op)
          st = stop_materializer(st, entry)
          entry = %{entry | lifecycle: :tombstoned, mat_pid: nil, mat_ref: nil, log: log}
          notify(entry, {:lattice_lifecycle, key, :tombstoned})
          {:reply, :ok, put_entry(st, key, entry)}
        else
          {:reply, {:error, :unauthorized}, st}
        end

      :error ->
        {:reply, {:error, :unknown}, st}
    end
  end

  def handle_call({:lifecycle, key}, _from, st) do
    {:reply, with({:ok, e} <- fetch(st, key), do: e.lifecycle), st}
  end

  def handle_call({:state, key}, _from, st) do
    {:reply, with({:ok, e} <- fetch(st, key), do: current_state(e)), st}
  end

  def handle_call({:log, key}, _from, st) do
    {:reply, with({:ok, e} <- fetch(st, key), do: e.log), st}
  end

  def handle_call({:query, key, q}, _from, st) do
    {:reply, with({:ok, e} <- fetch(st, key), do: answer_query(q, current_state(e))), st}
  end

  def handle_call({:monitor, key, pid}, _from, st) do
    case fetch(st, key) do
      {:ok, entry} ->
        entry = %{entry | monitors: MapSet.put(entry.monitors, pid)}
        send(pid, {:lattice_lifecycle, key, entry.lifecycle})
        {:reply, :ok, put_entry(st, key, entry)}

      :error ->
        {:reply, {:error, :unknown}, st}
    end
  end

  def handle_call({:deliver, from_realm, to_realm, replica, payload}, _from, st) do
    from_key = {from_realm, replica}
    to_key = {to_realm, replica}

    with {:ok, from_entry} <- fetch(st, from_key) do
      # Scope the message to its destination realm so only that realm's
      # materialization delivers it (not every realm hosting the replica).
      op = author(from_entry, :inbox, {:message, to_realm, payload})
      st = put_entry(st, from_key, %{from_entry | log: Log.append!(from_entry.log, op)})
      st = do_sync(st, from_key, to_key)
      {:reply, :ok, st}
    else
      :error -> {:reply, {:error, :unknown}, st}
    end
  end

  def handle_call({:sync, realm_a, realm_b, replica}, _from, st) do
    {:reply, :ok, do_sync(st, {realm_a, replica}, {realm_b, replica})}
  end

  def handle_call({:call, from_realm, to_realm, replica, query}, _from, st) do
    from_key = {from_realm, replica}
    to_key = {to_realm, replica}

    with {:ok, from_entry} <- fetch(st, from_key) do
      ref = "ref:" <> Lattice.Cap.random_token()
      # Scope the request to its destination realm so only that realm answers it
      # (the caller must not answer its own outbound request).
      req = author(from_entry, :inbox, {:request, ref, to_realm, query})
      st = put_entry(st, from_key, %{from_entry | log: Log.append!(from_entry.log, req)})
      st = do_sync(st, from_key, to_key)
      promise = %Promise{ref: ref, replica: replica, target: to_realm, from: from_realm}
      {:reply, {:ok, promise}, st}
    else
      :error -> {:reply, {:error, :unknown}, st}
    end
  end

  def handle_call({:await, key, %Promise{ref: ref}}, _from, st) do
    result =
      with {:ok, entry} <- fetch(st, key) do
        case find_response(entry.log, ref) do
          {:ok, value} -> {:ok, value}
          :error -> :pending
        end
      end

    {:reply, result, st}
  end

  def handle_call({:dump, key, path}, _from, st) do
    {:reply, with({:ok, e} <- fetch(st, key), do: Log.dump(e.log, path)), st}
  end

  def handle_call({:restore, identity, module, replica, path}, _from, st) do
    key = {identity.realm_id, replica}

    case Log.restore_verified(path) do
      {:ok, %{log: %Log{replica: ^replica} = log}} ->
        {:reply, :ok, put_entry(st, key, new_entry(identity, module, log))}

      {:ok, _snapshot} ->
        {:reply, {:error, :wrong_replica}, st}

      {:error, errors} when is_list(errors) ->
        {:reply, {:error, :invalid_log}, st}

      {:error, _} = err ->
        {:reply, err, st}
    end
  end

  def handle_call(:reset, _from, st) do
    Enum.each(st.entries, fn {_key, entry} ->
      if entry.mat_pid,
        do: DynamicSupervisor.terminate_child(Lattice.MaterializerSupervisor, entry.mat_pid)
    end)

    {:reply, :ok, %{entries: %{}, refs: %{}}}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, st) do
    case Map.fetch(st.refs, ref) do
      {:ok, key} ->
        st = %{st | refs: Map.delete(st.refs, ref)}

        case fetch(st, key) do
          {:ok, %{lifecycle: :live} = entry} ->
            entry = %{entry | lifecycle: :dormant, mat_pid: nil}
            notify(entry, {:lattice_lifecycle, key, :dormant})
            {:noreply, put_entry(st, key, entry)}

          _ ->
            {:noreply, st}
        end

      :error ->
        {:noreply, st}
    end
  end

  def handle_info(_msg, st), do: {:noreply, st}

  # --- Internals -----------------------------------------------------------

  # `replica` is taken from the log so it carries the log's *bound* replica id (the
  # one committed by every op), keeping authored ops on the same replica as the log.
  defp new_entry(identity, module, log) do
    %{
      identity: identity,
      module: module,
      replica: log.replica,
      log: log,
      lifecycle: :dormant,
      mat_pid: nil,
      mat_ref: nil,
      monitors: MapSet.new()
    }
  end

  defp fetch(st, key), do: Map.fetch(st.entries, key)
  defp put_entry(st, key, entry), do: %{st | entries: Map.put(st.entries, key, entry)}
  defp put_ref(st, ref, key), do: %{st | refs: Map.put(st.refs, ref, key)}

  defp author(entry, kind, body, opts \\ []) do
    Op.new(entry.identity, entry.replica, Log.frontier(entry.log), kind, body, opts)
  end

  defp current_state(entry) do
    quarantine = Authority.quarantine(entry.module, entry.log)
    Reduce.reduce(entry.module, entry.log, quarantine: quarantine)
  end

  defp start_materializer(key) do
    pid =
      case DynamicSupervisor.start_child(Lattice.MaterializerSupervisor, {Materializer, key}) do
        {:ok, pid} -> pid
        {:error, {:already_started, pid}} -> pid
      end

    {pid, Process.monitor(pid)}
  end

  defp stop_materializer(st, %{mat_pid: nil}), do: st

  defp stop_materializer(st, %{mat_pid: pid, mat_ref: ref}) do
    # Demonitor (flushing any pending :DOWN) so the explicit lifecycle transition
    # isn't raced by the monitor message, then stop the live process.
    if ref, do: Process.demonitor(ref, [:flush])
    DynamicSupervisor.terminate_child(Lattice.MaterializerSupervisor, pid)
    %{st | refs: Map.delete(st.refs, ref)}
  end

  # Process unacked messages and unresponded requests, in causal order. Returns the
  # updated entry and the list of newly-delivered {op_id, payload} messages.
  defp process_inbox(entry) do
    ordered = Dag.topo_sort(Log.ops(entry.log))
    state = current_state(entry)
    realm = entry.identity.realm_id
    acked = inbox_set(ordered, :delivered)
    responded = inbox_set(ordered, :response)

    {log, delivered} =
      Enum.reduce(ordered, {entry.log, []}, fn op, {log, delivered} ->
        case op.body do
          # Only the destination realm delivers/answers; others ignore the op.
          {:message, ^realm, payload} when op.kind == :inbox ->
            if MapSet.member?(acked, op.id) do
              {log, delivered}
            else
              ack =
                Op.new(
                  entry.identity,
                  entry.replica,
                  Log.frontier(log),
                  :inbox,
                  {:delivered, op.id}
                )

              {Log.append!(log, ack), [{op.id, payload} | delivered]}
            end

          {:request, ref, ^realm, query} when op.kind == :inbox ->
            if MapSet.member?(responded, ref) do
              {log, delivered}
            else
              result = answer_query(query, state)

              resp =
                Op.new(
                  entry.identity,
                  entry.replica,
                  Log.frontier(log),
                  :inbox,
                  {:response, ref, result}
                )

              {Log.append!(log, resp), delivered}
            end

          _ ->
            {log, delivered}
        end
      end)

    {%{entry | log: log}, Enum.reverse(delivered)}
  end

  defp inbox_set(ordered, :delivered) do
    for %Op{kind: :inbox, body: {:delivered, id}} <- ordered, into: MapSet.new(), do: id
  end

  defp inbox_set(ordered, :response) do
    for %Op{kind: :inbox, body: {:response, ref, _}} <- ordered, into: MapSet.new(), do: ref
  end

  defp find_response(log, ref) do
    log
    |> Log.ops()
    |> Map.values()
    |> Enum.find_value(:error, fn
      %Op{kind: :inbox, body: {:response, ^ref, result}} -> {:ok, result}
      _ -> nil
    end)
  end

  defp answer_query({:get, field}, state) when is_map(state), do: Map.get(state, field)
  defp answer_query(:state, state), do: state
  defp answer_query(_query, state), do: state

  defp do_sync(st, key_a, key_b) do
    with {:ok, a} <- fetch(st, key_a), {:ok, b} <- fetch(st, key_b) do
      {la, lb, _report} = Sync.reconcile(a.log, b.log)
      a = maybe_reprocess(%{a | log: la})
      b = maybe_reprocess(%{b | log: lb})
      st |> put_entry(key_a, a) |> put_entry(key_b, b)
    else
      _ -> st
    end
  end

  # If a pair is live, reprocess its inbox after a sync brought new ops (so freshly
  # arrived requests/messages get answered/delivered promptly).
  defp maybe_reprocess(%{lifecycle: :live, monitors: monitors} = entry) do
    {entry, delivered} = process_inbox(entry)

    Enum.each(monitors, fn pid ->
      Enum.each(delivered, fn {_id, payload} ->
        send(pid, {:lattice_message, key_of(entry), payload})
      end)
    end)

    entry
  end

  defp maybe_reprocess(entry), do: entry

  defp key_of(entry), do: {entry.identity.realm_id, entry.replica}

  defp deliver_messages(entry, key, delivered) do
    Enum.each(entry.monitors, fn pid ->
      Enum.each(delivered, fn {_id, payload} -> send(pid, {:lattice_message, key, payload}) end)
    end)
  end

  defp notify(entry, message) do
    Enum.each(entry.monitors, &send(&1, message))
  end
end
