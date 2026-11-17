defmodule Lattice.CapStore do
  @moduledoc """
  Owns capability grants, revocations, lookup, expiry, use limits, and owner checks.

  ## Audit outages (row 313)

  Every Audit record this store writes goes through one bounded
  `Lattice.Audit.Backlog`, so an Audit restart no longer exits CapStore and
  wipes the in-memory caps. Records Audit cannot take are queued and replayed
  in order with `audit_deferred: true`, `audit_source: Lattice.CapStore` and a
  per-source `audit_seq`; records written on time are unchanged.

  Revocations and denials always commit. Authority-increasing actions (grant,
  delegate and a successful authorize) flush first and are refused with
  `{:error, :audit_unavailable}`, state unchanged, while the backlog is full,
  so a committed action always has its record written or queued. Each refusal
  is counted in the backlog's `:backlog_full` gap.

  Replay runs on the next recording call, on `flush_audit/0`, and on a retry
  timer (`:authority_audit_retry_ms`, default 1 s) while records are owed. A
  stalled Audit (call timeout) still exits CapStore, and nothing here is
  durable.
  """

  use GenServer

  alias Lattice.Audit.Backlog
  alias Lattice.{Cap, Topology}
  alias Lattice.Cap.{Attenuation, Caveat, Session}

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def grant(tab_id, target, ops, opts \\ []) do
    GenServer.call(__MODULE__, {:grant, tab_id, target, ops, opts})
  end

  def delegate(delegating_tab_id, parent_cap_or_id, to_tab_id, opts \\ [])

  def delegate(nil, parent_cap_or_id, to_tab_id, _opts) do
    with {:ok, parent_id} <- Cap.safe_token(parent_cap_or_id) do
      record_deny(%{
        reason: :delegator_required,
        op: :delegate,
        parent_id: parent_id,
        to_tab_id: to_tab_id
      })

      {:error, :delegator_required}
    else
      {:error, reason} ->
        record_deny(%{reason: reason, op: :delegate, to_tab_id: to_tab_id})
        {:error, reason}
    end
  end

  def delegate(delegating_tab_id, parent_cap_or_id, to_tab_id, opts)
      when is_binary(delegating_tab_id) do
    with {:ok, parent_id} <- Cap.safe_token(parent_cap_or_id) do
      GenServer.call(__MODULE__, {:delegate, delegating_tab_id, parent_id, to_tab_id, opts})
    else
      {:error, reason} ->
        record_deny(%{reason: reason, op: :delegate, tab_id: delegating_tab_id})
        {:error, reason}
    end
  end

  def revoke(cap_or_id, reason \\ :manual) do
    with {:ok, cap_id} <- Cap.safe_token(cap_or_id) do
      GenServer.call(__MODULE__, {:revoke, cap_id, reason})
    else
      {:error, reason} ->
        record_deny(%{reason: reason, op: :revoke})
        {:error, reason}
    end
  end

  def revoke_tab(tab_id, reason \\ :tab_closed) do
    GenServer.call(__MODULE__, {:revoke_tab, tab_id, reason})
  end

  def authorize(tab_id, cap_or_id, op, payload \\ %{}) do
    with {:ok, cap_id} <- Cap.safe_token(cap_or_id) do
      GenServer.call(__MODULE__, {:authorize, tab_id, cap_id, Cap.normalize_op(op), payload})
    else
      {:error, reason} ->
        record_deny(%{tab_id: tab_id, op: op, reason: reason})
        {:error, reason}
    end
  end

  def get(cap_or_id) do
    with {:ok, cap_id} <- Cap.safe_token(cap_or_id) do
      GenServer.call(__MODULE__, {:get, cap_id})
    end
  end

  def snapshot, do: GenServer.call(__MODULE__, :snapshot)
  def reset, do: GenServer.call(__MODULE__, :reset)

  @doc """
  Replays Audit records deferred while `Lattice.Audit` was unavailable.

  Writes at most one bounded batch (500 records, gap records included); a
  remainder continues automatically. Returns
  `{:ok, %{flushed: n, pending: m, gap: g}}`: `n` records this call wrote,
  `m` records still queued, and `g` records counted in unwritten gaps.
  """
  def flush_audit, do: GenServer.call(__MODULE__, :flush_audit)

  # Caller-side denials (a bad token, a missing delegator) share the store's
  # backlog, so they are deferred rather than exiting the caller (row 313).
  defp record_deny(metadata), do: GenServer.call(__MODULE__, {:record_deny, metadata})

  @impl true
  def init(_opts), do: {:ok, fresh_state(Backlog.new(__MODULE__))}

  @impl true
  def handle_call({:grant, tab_id, target, ops, opts}, _from, state) do
    state = prepare_audit(state)

    if Topology.tab_connected?(tab_id) do
      cap = Cap.new(tab_id, target, ops, opts)

      cond do
        Map.has_key?(state.caps, cap.id) ->
          state =
            audit(state, :deny, %{
              tab_id: tab_id,
              cap_id: cap.id,
              target: inspect_target(target),
              reason: :cap_id_collision
            })

          {:reply, {:error, :cap_id_collision}, state}

        # Refused before `Topology.register_cap/2`, so `issued_caps` is untouched.
        Backlog.full?(state.audit) ->
          state =
            audit(state, :deny, %{
              tab_id: tab_id,
              cap_id: cap.id,
              target: inspect_target(target),
              reason: :audit_unavailable
            })

          {:reply, {:error, :audit_unavailable}, state}

        true ->
          commit_grant(state, tab_id, target, cap)
      end
    else
      state =
        audit(state, :deny, %{
          tab_id: tab_id,
          reason: :grant_to_unknown_or_disconnected_tab,
          target: inspect_target(target)
        })

      {:reply, {:error, :tab_not_connected}, state}
    end
  end

  def handle_call({:delegate, delegating_tab_id, parent_id, to_tab_id, opts}, _from, state) do
    state = prepare_audit(state)

    with {:ok, parent} <- fetch_live_parent(state, parent_id),
         :ok <- delegator_owns_parent?(parent, delegating_tab_id),
         true <- Topology.tab_connected?(delegating_tab_id) || {:error, :tab_not_connected},
         true <- Topology.tab_connected?(to_tab_id) || {:error, :tab_not_connected},
         {:ok, child} <- Attenuation.derive(parent, to_tab_id, opts),
         :ok <- cap_id_available?(state, child.id),
         :ok <- audit_room(state),
         :ok <- Topology.register_cap(to_tab_id, child.id) do
      state =
        audit(state, :delegate, %{
          from_tab_id: delegating_tab_id,
          to_tab_id: to_tab_id,
          parent_id: parent.id,
          child_id: child.id,
          caveats: Enum.map(child.caveats, &Caveat.external/1)
        })

      {:reply, {:ok, child}, state |> put_in([:caps, child.id], child) |> index_child(child)}
    else
      {:error, reason} ->
        state =
          audit(state, :deny, %{
            op: :delegate,
            tab_id: delegating_tab_id,
            parent_id: parent_id,
            to_tab_id: to_tab_id,
            reason: reason
          })

        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:revoke, cap_id, reason}, _from, state) do
    state = prepare_audit(state)

    case Map.fetch(state.caps, cap_id) do
      {:ok, _cap} ->
        affected_ids = [cap_id | descendant_ids(state.children, cap_id)]
        caps = revoke_caps(state.caps, affected_ids, reason)

        state =
          Enum.reduce(affected_ids, %{state | caps: caps}, fn id, state ->
            revoked_cap = Map.fetch!(caps, id)

            audit(state, :revoke, %{
              tab_id: revoked_cap.owner_tab_id,
              cap_id: id,
              parent_id: revoked_cap.parent_id,
              root_id: revoked_cap.root_id,
              reason: inspect(reason)
            })
          end)

        {:reply, :ok, state}

      :error ->
        state = audit(state, :deny, %{cap_id: cap_id, reason: :revoke_unknown_cap})
        {:reply, {:error, :unknown_cap}, state}
    end
  end

  def handle_call({:revoke_tab, tab_id, reason}, _from, state) do
    state = prepare_audit(state)

    {caps, revoked_ids} =
      Enum.reduce(state.caps, {%{}, []}, fn
        {id, %Cap{owner_tab_id: ^tab_id} = cap}, {caps, ids} ->
          revoked = Cap.revoke(cap, reason)
          {Map.put(caps, id, revoked), [id | ids]}

        {id, cap}, {caps, ids} ->
          {Map.put(caps, id, cap), ids}
      end)

    state =
      Enum.reduce(revoked_ids, %{state | caps: caps}, fn cap_id, state ->
        audit(state, :revoke, %{tab_id: tab_id, cap_id: cap_id, reason: inspect(reason)})
      end)

    {:reply, :ok, state}
  end

  def handle_call({:authorize, tab_id, cap_id, op, payload}, _from, state) do
    state = prepare_audit(state)

    case Map.fetch(state.caps, cap_id) do
      {:ok, cap} ->
        case check_cap(cap, tab_id, op, payload, state) do
          {:ok, checked_cap, checked_ancestors} ->
            commit_use(state, tab_id, cap_id, op, checked_cap, checked_ancestors)

          {:error, reason, event_type} ->
            state =
              audit(state, event_type, %{
                tab_id: tab_id,
                owner_tab_id: cap.owner_tab_id,
                cap_id: cap_id,
                op: op,
                reason: reason
              })

            {:reply, {:error, reason}, state}
        end

      :error ->
        state =
          audit(state, :deny, %{tab_id: tab_id, cap_id: cap_id, op: op, reason: :unknown_cap})

        {:reply, {:error, :unknown_cap}, state}
    end
  end

  def handle_call({:record_deny, metadata}, _from, state) do
    state = state |> prepare_audit() |> audit(:deny, metadata)
    {:reply, :ok, state}
  end

  def handle_call(:flush_audit, _from, state) do
    {audit, %{flushed: flushed, outcome: outcome}} = Backlog.flush(state.audit)
    state = arm_audit_retry(%{state | audit: audit}, outcome)
    {:reply, {:ok, Map.put(Backlog.status(state.audit), :flushed, flushed)}, state}
  end

  def handle_call({:get, cap_id}, _from, state) do
    {:reply, Map.fetch(state.caps, cap_id), state}
  end

  def handle_call(:snapshot, _from, state) do
    active_caps =
      state.caps
      |> Enum.reject(fn {_id, cap} ->
        cap.revoked? or Cap.expired?(cap) or Cap.use_limited?(cap)
      end)
      |> Map.new()

    {:reply, %{caps: state.caps, active_caps: active_caps}, state}
  end

  # Reset is a demo and test control call: it drains what Audit will take, then
  # counts the rest in a `:reset` gap carried into the fresh state (D-241).
  def handle_call(:reset, _from, state) do
    cancel_audit_retry(state)
    audit = state.audit |> Backlog.drain() |> Backlog.discard_into_gap(:reset)
    {:reply, :ok, arm_audit_retry(fresh_state(audit), :unavailable)}
  end

  @impl true
  def handle_info(:flush_audit, state) do
    {audit, %{outcome: outcome}} = Backlog.flush(state.audit)
    {:noreply, arm_audit_retry(%{state | audit: audit, audit_retry: nil}, outcome)}
  end

  defp fresh_state(audit), do: %{caps: %{}, children: %{}, audit: audit, audit_retry: nil}

  defp commit_grant(state, tab_id, target, cap) do
    case Topology.register_cap(tab_id, cap.id) do
      :ok ->
        state =
          audit(state, :grant, %{
            tab_id: tab_id,
            cap_id: cap.id,
            target: inspect_target(target),
            ops: MapSet.to_list(cap.ops),
            caveats: Enum.map(cap.caveats, &Caveat.external/1)
          })

        {:reply, {:ok, cap}, state |> put_in([:caps, cap.id], cap) |> index_child(cap)}

      {:error, reason} ->
        state =
          audit(state, :deny, %{
            tab_id: tab_id,
            cap_id: cap.id,
            target: inspect_target(target),
            reason: reason
          })

        {:reply, {:error, reason}, state}
    end
  end

  defp commit_use(state, tab_id, cap_id, op, checked_cap, checked_ancestors) do
    if Backlog.full?(state.audit) do
      state =
        audit(state, :deny, %{
          tab_id: tab_id,
          owner_tab_id: checked_cap.owner_tab_id,
          cap_id: cap_id,
          op: op,
          reason: :audit_unavailable
        })

      {:reply, {:error, :audit_unavailable}, state}
    else
      used = %{checked_cap | uses: checked_cap.uses + 1}
      caps = store_used_caps(state.caps, used, checked_ancestors)

      state =
        audit(%{state | caps: caps}, :cap_use, %{
          tab_id: tab_id,
          cap_id: cap_id,
          op: op,
          target: inspect_target(checked_cap.target),
          session_state: checked_cap.session && checked_cap.session.state
        })

      {:reply, {:ok, used}, state}
    end
  end

  defp audit_room(state) do
    if Backlog.full?(state.audit), do: {:error, :audit_unavailable}, else: :ok
  end

  # Flushes owed records before this call writes its own, so the next
  # authority call after Audit returns replays the backlog first.
  defp prepare_audit(state) do
    if Backlog.owed?(state.audit) do
      {audit, %{outcome: outcome}} = Backlog.flush(state.audit)
      arm_audit_retry(%{state | audit: audit}, outcome)
    else
      state
    end
  end

  defp audit(state, type, metadata) do
    case Backlog.record(state.audit, type, metadata) do
      {:written, audit} -> %{state | audit: audit}
      {_deferred_or_dropped, audit} -> arm_audit_retry(%{state | audit: audit}, :unavailable)
    end
  end

  # Arms one `:flush_audit` timer while records are owed: 0 ms after a full
  # batch, the retry interval when Audit was unavailable (D-242, D-253).
  defp arm_audit_retry(state, outcome) do
    cond do
      not Backlog.owed?(state.audit) ->
        state

      outcome == :more ->
        cancel_audit_retry(state)
        %{state | audit_retry: Process.send_after(self(), :flush_audit, 0)}

      state.audit_retry == nil ->
        %{state | audit_retry: Process.send_after(self(), :flush_audit, Backlog.retry_ms())}

      true ->
        state
    end
  end

  # Clears an already-delivered timer message so a second timer is not left
  # running (D-250).
  defp cancel_audit_retry(%{audit_retry: nil}), do: :ok

  defp cancel_audit_retry(%{audit_retry: ref}) do
    if Process.cancel_timer(ref) == false do
      receive do
        :flush_audit -> :ok
      after
        0 -> :ok
      end
    end

    :ok
  end

  defp fetch_live_parent(state, parent_id) do
    case Map.fetch(state.caps, parent_id) do
      {:ok, %Cap{revoked?: true}} -> {:error, :revoked}
      {:ok, cap} -> if Cap.expired?(cap), do: {:error, :expired}, else: {:ok, cap}
      :error -> {:error, :unknown_cap}
    end
  end

  defp cap_id_available?(state, cap_id) do
    if Map.has_key?(state.caps, cap_id), do: {:error, :cap_id_collision}, else: :ok
  end

  defp check_cap(%Cap{owner_tab_id: owner}, tab_id, _op, _payload, _state) when owner != tab_id,
    do: {:error, :wrong_owner, :deny}

  defp check_cap(%Cap{revoked?: true}, _tab_id, _op, _payload, _state),
    do: {:error, :revoked, :deny}

  defp check_cap(%Cap{} = cap, _tab_id, op, payload, state) do
    with :ok <- owner_tab_connected?(cap),
         {:ok, ancestors} <- parent_chain(cap, state),
         :ok <- parent_chain_live?(ancestors),
         :ok <- base_cap_live?(cap, op),
         :ok <- enforce_parent_chain(ancestors, payload),
         :ok <- Caveat.enforce(cap, payload),
         {:ok, checked_ancestors} <- advance_parent_sessions(ancestors, payload),
         {:ok, session} <- Session.advance(cap.session, payload) do
      {:ok, %{cap | session: session}, checked_ancestors}
    else
      {:error, reason, event_type} -> {:error, reason, event_type}
      {:error, reason} -> {:error, reason, :deny}
    end
  end

  defp base_cap_live?(%Cap{} = cap, op) do
    cond do
      Cap.expired?(cap) -> {:error, :expired, :expired_cap}
      Cap.use_limited?(cap) -> {:error, :use_limit_exceeded, :use_limit_exceeded}
      MapSet.member?(cap.ops, op) -> :ok
      true -> {:error, :operation_not_allowed, :deny}
    end
  end

  defp owner_tab_connected?(%Cap{owner_tab_id: owner_tab_id}) do
    if Topology.tab_connected?(owner_tab_id), do: :ok, else: {:error, :tab_not_connected, :deny}
  end

  defp delegator_owns_parent?(%Cap{owner_tab_id: owner_tab_id}, owner_tab_id), do: :ok
  defp delegator_owns_parent?(_parent, _delegating_tab_id), do: {:error, :wrong_owner}

  defp parent_chain(%Cap{parent_id: nil}, _state), do: {:ok, []}

  defp parent_chain(%Cap{parent_id: parent_id}, state) do
    case Map.fetch(state.caps, parent_id) do
      {:ok, parent} ->
        with {:ok, ancestors} <- parent_chain(parent, state) do
          {:ok, [parent | ancestors]}
        end

      :error ->
        {:error, :parent_missing, :deny}
    end
  end

  defp parent_chain_live?(ancestors) do
    Enum.reduce_while(ancestors, :ok, fn
      %Cap{revoked?: true}, :ok ->
        {:halt, {:error, :parent_revoked, :deny}}

      %Cap{} = parent, :ok ->
        cond do
          Cap.expired?(parent) -> {:halt, {:error, :parent_expired, :expired_cap}}
          Cap.use_limited?(parent) -> {:halt, {:error, :use_limit_exceeded, :use_limit_exceeded}}
          true -> {:cont, :ok}
        end
    end)
  end

  defp enforce_parent_chain(ancestors, payload) do
    Enum.reduce_while(ancestors, :ok, fn parent, :ok ->
      case Caveat.enforce(parent, payload) do
        :ok -> {:cont, :ok}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp advance_parent_sessions(ancestors, payload) do
    ancestors
    |> Enum.reduce_while({:ok, []}, fn parent, {:ok, checked} ->
      case Session.advance(parent.session, payload) do
        {:ok, session} -> {:cont, {:ok, [%{parent | session: session} | checked]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, checked} -> {:ok, Enum.reverse(checked)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp store_used_caps(caps, used, checked_ancestors) do
    Enum.reduce(checked_ancestors, Map.put(caps, used.id, used), fn parent, caps ->
      Map.update!(caps, parent.id, fn _ -> %{parent | uses: parent.uses + 1} end)
    end)
  end

  # The children index is an optimization for descendant traversal; `caps[*].parent_id`
  # remains the source of truth. Revoked caps are marked, never deleted, so stale index
  # entries cannot resurrect a cap — `revoke_caps/3` simply re-marks them.
  defp index_child(state, %Cap{parent_id: nil}), do: state

  defp index_child(state, %Cap{parent_id: parent_id, id: id}) do
    update_in(state, [:children, parent_id], fn
      nil -> MapSet.new([id])
      set -> MapSet.put(set, id)
    end)
  end

  defp descendant_ids(children_index, cap_id) do
    case Map.get(children_index, cap_id) do
      nil ->
        []

      set ->
        kids = MapSet.to_list(set)
        kids ++ Enum.flat_map(kids, &descendant_ids(children_index, &1))
    end
  end

  defp revoke_caps(caps, ids, reason) do
    Enum.reduce(ids, caps, fn id, caps ->
      update_in(caps, [id], fn
        nil -> nil
        cap -> Cap.revoke(cap, reason)
      end)
    end)
  end

  defp inspect_target({:server_pid, pid}), do: inspect(pid)
  defp inspect_target(target), do: Cap.target_label(target)
end
