defmodule Lattice.Authority do
  @moduledoc """
  In-log delegation and serialized-authority analysis.

  This is the deterministic judge that every realm runs over its log to decide,
  identically, which ops are *honored* and which are *quarantined*. It depends only
  on the op set and its causal DAG, so all realms agree (property d).

  ## Authority ops (`kind: :authority`)

    * `{:genesis, delegation, policies}` — root self-grant + succession policies
    * `{:grant, delegation}`             — capability delegation to another realm
    * `{:transfer, role, delegation, at_tick}` — current holder hands a role on
    * `{:succeed, role, delegation, at_tick}`   — designated successor claims a
      role after the holder has been dormant past the threshold
    * `{:revoke, delegation_id}`         — revoke a delegation (and citations of it)
    * `{:heartbeat, role, at_tick}`      — holder liveness signal (resets dormancy)

  ## Rules enforced

    * **Cap-gated append** (behavior 5): a `:command` op must cite (`op.cap`) a
      delegation that is valid, causally visible, conferring the command, addressed
      to the author, and not revoked-as-of the op.
    * **Serialized authority** (behaviors 6–9): an op mutating an `authority:` field
      is honored only if its author is the role holder *at the op's causal position*
      and no valid holder-change moved the role away concurrently. Concurrent
      transfers by one holder resolve by canonical order — the first wins, the rest
      are quarantined as a `:double_transfer` anomaly.
    * **Stale holder** (behaviors 8, 15): a command by a holder who has been
      superseded by a holder-change it never saw is `:stale_holder`-quarantined.
    * **Revocation** (behavior 10): ops citing a revoked delegation that are not
      causally before the revoke are quarantined.

  Quarantined ops stay in the log and are reported in `audit` (design invariant 4).
  """

  alias Lattice.{Dag, Identity, Log, Op}
  alias Lattice.Authority.Delegation

  @type analysis :: %{
          quarantine: MapSet.t(Op.id()),
          reasons: %{Op.id() => atom()},
          holders: %{atom() => Identity.pubkey() | nil},
          audit: [map()],
          requests: [map()]
        }

  @doc "Set of op ids excluded from reduction by authority rules."
  @spec quarantine(module(), Log.t()) :: MapSet.t(Op.id())
  def quarantine(module, %Log{} = log), do: analyze(module, log).quarantine

  @doc "Current holder pubkey of `role` in `log` (nil if none / never granted)."
  @spec holder(module(), Log.t(), atom()) :: Identity.pubkey() | nil
  def holder(module, %Log{} = log, role), do: Map.get(analyze(module, log).holders, role)

  @doc """
  Verify a delegation chain in isolation (no log): each link's signature, the
  genesis self-issue, and attenuation along the chain. This is the proof the live
  path checks — the same delegations whose ids are cited by log ops.
  """
  @spec verify_chain([Delegation.t()], String.t()) :: :ok | {:error, atom()}
  def verify_chain([], _replica), do: {:error, :empty_chain}

  def verify_chain([genesis | _] = chain, replica) do
    cond do
      Enum.any?(chain, &(&1.replica != replica)) ->
        {:error, :wrong_replica}

      not (is_nil(genesis.parent_id) and genesis.issuer == genesis.audience) ->
        {:error, :bad_genesis}

      not Enum.all?(chain, &Delegation.valid_sig?/1) ->
        {:error, :bad_signature}

      not links_attenuate?(chain) ->
        {:error, :not_attenuated}

      true ->
        :ok
    end
  end

  defp links_attenuate?([_only]), do: true

  defp links_attenuate?([parent, child | rest]),
    do: Delegation.attenuates?(child, parent) and links_attenuate?([child | rest])

  @doc """
  True if `delegation_id` is admitted in `log` and valid (present, signatures + chain
  attenuation hold). The live path requires this so it cannot accept a chain the
  append path would never admit — keeping the two uses of one delegation in step.
  """
  @spec delegation_active?(Log.t(), String.t()) :: boolean()
  def delegation_active?(%Log{} = log, delegation_id) do
    delegations = collect_delegations(Log.topo_ops(log))

    case Map.fetch(delegations, delegation_id) do
      {:ok, %{deleg: d}} -> validate_delegation(d, delegations) == :ok
      :error -> false
    end
  end

  @doc "True if a valid revoke of `delegation_id` currently exists (live-path check)."
  @spec revoked?(Log.t(), String.t()) :: boolean()
  def revoked?(%Log{} = log, delegation_id) do
    ordered = Log.topo_ops(log)
    delegations = collect_delegations(ordered)
    root = root_creator(ordered)

    Enum.any?(ordered, fn op ->
      match?({:revoke, ^delegation_id}, op.body) and
        revoke_authorized?(op, delegation_id, delegations, root)
    end)
  end

  @doc "Full authority analysis for `log` interpreted by Replica `module`."
  @spec analyze(module(), Log.t()) :: analysis()
  def analyze(module, %Log{} = log) do
    ops = Log.ops(log)
    ordered = Dag.topo_sort(ops)
    ancestors = Dag.all_ancestors(ops)

    delegations = collect_delegations(ordered)
    policies = collect_policies(ordered)
    deleg_valid = validate_delegations(delegations)
    root = root_creator(ordered)
    revokes = collect_revokes(ordered, delegations, root)

    invalid_deleg = invalid_delegation_ops(delegations, deleg_valid)
    roles = all_roles(module)

    timelines =
      Map.new(roles, fn role ->
        {role, build_role_timeline(role, ordered, ancestors, delegations, deleg_valid, policies)}
      end)

    holders = Map.new(timelines, fn {role, tl} -> {role, tl.holder} end)

    role_q = Enum.reduce(timelines, %{}, fn {_r, tl}, acc -> Map.merge(acc, tl.quarantine) end)
    role_audit = Enum.flat_map(timelines, fn {_r, tl} -> tl.audit end)

    {cmd_q, cmd_audit, requests} =
      validate_commands(module, ordered, ancestors, delegations, deleg_valid, revokes, timelines)

    reasons =
      invalid_deleg
      |> Map.merge(role_q)
      |> Map.merge(cmd_q)

    %{
      quarantine: reasons |> Map.keys() |> MapSet.new(),
      reasons: reasons,
      holders: holders,
      audit: role_audit ++ cmd_audit,
      requests: requests
    }
  end

  # --- Delegation collection / validation ---------------------------------

  # A delegation (content-addressed) may be introduced by more than one op (e.g. the
  # same grant appended by two realms). Track all introducing op ids so visibility is
  # "any introducing op is a causal ancestor", not just the last-seen one.
  defp collect_delegations(ordered) do
    Enum.reduce(ordered, %{}, fn op, acc ->
      case delegation_in(op) do
        nil ->
          acc

        %Delegation{} = d ->
          Map.update(acc, d.id, %{deleg: d, op_ids: [op.id]}, fn entry ->
            %{entry | op_ids: [op.id | entry.op_ids]}
          end)
      end
    end)
  end

  defp delegation_in(%Op{kind: :authority, body: body}) do
    case body do
      {:genesis, %Delegation{} = d, _policies} -> d
      {:grant, %Delegation{} = d} -> d
      {:transfer, _role, %Delegation{} = d, _tick} -> d
      {:succeed, _role, %Delegation{} = d, _tick} -> d
      _ -> nil
    end
  end

  defp delegation_in(_), do: nil

  defp collect_policies(ordered) do
    Enum.reduce(ordered, %{}, fn op, acc ->
      case op.body do
        {:genesis, _d, policies} when is_map(policies) -> Map.merge(acc, policies)
        _ -> acc
      end
    end)
  end

  defp validate_delegations(delegations) do
    Map.new(delegations, fn {id, %{deleg: d}} ->
      {id, validate_delegation(d, delegations)}
    end)
  end

  defp validate_delegation(%Delegation{} = d, delegations) do
    cond do
      not Delegation.valid_sig?(d) ->
        {:error, :bad_delegation_sig}

      is_nil(d.parent_id) ->
        if d.issuer == d.audience, do: :ok, else: {:error, :nongenesis_root}

      true ->
        case Map.fetch(delegations, d.parent_id) do
          {:ok, %{deleg: parent}} ->
            cond do
              validate_delegation(parent, delegations) != :ok -> {:error, :invalid_parent}
              not Delegation.attenuates?(d, parent) -> {:error, :not_attenuated}
              true -> :ok
            end

          :error ->
            {:error, :missing_parent}
        end
    end
  end

  defp invalid_delegation_ops(delegations, deleg_valid) do
    for {id, %{op_ids: op_ids}} <- delegations,
        deleg_valid[id] != :ok,
        op_id <- op_ids,
        into: %{} do
      {op_id, elem(deleg_valid[id], 1)}
    end
  end

  defp root_creator(ordered) do
    Enum.find_value(ordered, fn op ->
      case op.body do
        {:genesis, %Delegation{audience: aud}, _policies} -> aud
        _ -> nil
      end
    end)
  end

  defp collect_revokes(ordered, delegations, root) do
    for op <- ordered,
        match?({:revoke, _}, op.body),
        {:revoke, deleg_id} = op.body,
        revoke_authorized?(op, deleg_id, delegations, root) do
      %{op_id: op.id, deleg_id: deleg_id}
    end
  end

  defp revoke_authorized?(%Op{author: author}, deleg_id, delegations, root) do
    case Map.fetch(delegations, deleg_id) do
      {:ok, %{deleg: d}} -> author == d.issuer or author == root
      :error -> false
    end
  end

  # --- Role holder timelines ----------------------------------------------

  defp build_role_timeline(role, ordered, ancestors, delegations, deleg_valid, policies) do
    init = %{
      holder: nil,
      acquires: [],
      heartbeats: [],
      decided: %{},
      quarantine: %{},
      audit: []
    }

    Enum.reduce(ordered, init, fn op, st ->
      case role_event(op, role, delegations) do
        nil ->
          st

        {:genesis, d} ->
          if deleg_valid[d.id] == :ok and MapSet.member?(d.roles, role) do
            record_acquire(st, op, d.audience, 0)
          else
            st
          end

        {:transfer, d, at_tick} ->
          decide_transfer(st, op, role, d, at_tick, ancestors, deleg_valid)

        {:succeed, d, at_tick} ->
          decide_succeed(st, op, role, d, at_tick, ancestors, deleg_valid, policies)

        {:heartbeat, at_tick} ->
          decide_heartbeat(st, op, at_tick, ancestors)
      end
    end)
  end

  defp role_event(%Op{kind: :authority, body: body}, role, _delegations) do
    case body do
      {:genesis, %Delegation{} = d, _policies} ->
        if MapSet.member?(d.roles, role), do: {:genesis, d}

      {:transfer, ^role, %Delegation{} = d, tick} ->
        {:transfer, d, tick}

      {:succeed, ^role, %Delegation{} = d, tick} ->
        {:succeed, d, tick}

      {:heartbeat, ^role, tick} ->
        {:heartbeat, tick}

      _ ->
        nil
    end
  end

  defp role_event(_op, _role, _delegations), do: nil

  defp record_acquire(st, op, new_holder, at_tick) do
    %{
      st
      | holder: new_holder,
        acquires: st.acquires ++ [%{op_id: op.id, holder: new_holder, at_tick: at_tick}],
        decided:
          Map.put(st.decided, op.id, %{type: :acquire, holder: new_holder, at_tick: at_tick})
    }
  end

  defp decide_transfer(st, op, role, d, at_tick, ancestors, deleg_valid) do
    anc = Map.get(ancestors, op.id, MapSet.new())
    holder_at_deps = holder_from_acquires(st.acquires, anc)

    cond do
      deleg_valid[d.id] != :ok or op.author != d.issuer or not MapSet.member?(d.roles, role) ->
        reject(st, op, :invalid_transfer, role)

      holder_at_deps != op.author ->
        reject(st, op, :transfer_not_holder, role)

      st.holder != op.author ->
        # A concurrent transfer by the same holder already moved the token: anomaly.
        reject(st, op, :double_transfer, role)

      true ->
        record_acquire(st, op, d.audience, at_tick)
    end
  end

  defp decide_succeed(st, op, role, d, at_tick, ancestors, deleg_valid, policies) do
    anc = Map.get(ancestors, op.id, MapSet.new())
    last_active = last_active_from(st.acquires, st.heartbeats, anc)
    policy = Map.get(policies, role)

    cond do
      deleg_valid[d.id] != :ok or op.author != d.audience or op.author != d.issuer or
          not MapSet.member?(d.roles, role) ->
        reject(st, op, :invalid_succession, role)

      is_nil(policy) or op.author != policy.successor ->
        reject(st, op, :unauthorized_succession, role)

      at_tick < last_active + policy.dormant_ticks ->
        reject(st, op, :premature_succession, role)

      true ->
        record_acquire(st, op, d.audience, at_tick)
    end
  end

  defp decide_heartbeat(st, op, at_tick, ancestors) do
    anc = Map.get(ancestors, op.id, MapSet.new())
    holder_at_deps = holder_from_acquires(st.acquires, anc)

    if op.author == holder_at_deps do
      %{
        st
        | heartbeats: st.heartbeats ++ [%{op_id: op.id, at_tick: at_tick}],
          decided: Map.put(st.decided, op.id, %{type: :heartbeat, at_tick: at_tick})
      }
    else
      st
    end
  end

  defp reject(st, op, reason, role) do
    %{
      st
      | quarantine: Map.put(st.quarantine, op.id, reason),
        audit:
          st.audit ++ [%{event: :authority_quarantine, op: op.id, reason: reason, role: role}]
    }
  end

  # Latest activity tick (acquire or heartbeat) visible in `anc`; 0 if none.
  defp last_active_from(acquires, heartbeats, anc) do
    ticks =
      for ev <- acquires ++ heartbeats, MapSet.member?(anc, ev.op_id), do: ev.at_tick

    Enum.max([0 | ticks])
  end

  # --- Command validation -------------------------------------------------

  defp validate_commands(module, ordered, ancestors, delegations, deleg_valid, revokes, timelines) do
    Enum.reduce(ordered, {%{}, [], []}, fn op, {quarantine, audit, requests} ->
      cond do
        op.kind == :inbox and match?({:request, _ref, _payload}, op.body) ->
          {:request, ref, payload} = op.body

          {quarantine, audit,
           requests ++ [%{op: op.id, author: op.author, ref: ref, payload: payload}]}

        op.kind == :command ->
          case validate_command(
                 module,
                 op,
                 ancestors,
                 delegations,
                 deleg_valid,
                 revokes,
                 timelines
               ) do
            :ok ->
              {quarantine, audit, requests}

            {:error, reason} ->
              {Map.put(quarantine, op.id, reason),
               audit ++ [%{event: :command_quarantine, op: op.id, reason: reason}], requests}
          end

        true ->
          {quarantine, audit, requests}
      end
    end)
  end

  defp validate_command(module, op, ancestors, delegations, deleg_valid, revokes, timelines) do
    {cmd, args} =
      case op.body do
        {cmd, args} when is_list(args) -> {cmd, args}
        _ -> {nil, nil}
      end

    cond do
      is_nil(cmd) ->
        {:error, :malformed_command}

      # An op naming a command the Replica does not define is quarantined explicitly
      # rather than silently contributing no mutations (design invariant 4).
      not command_defined?(module, cmd) ->
        {:error, :unknown_command}

      true ->
        mutations = command_mutations(module, cmd, args)
        roles_needed = mutation_roles(module, mutations)

        with :ok <- cap_ok(op, cmd, delegations, deleg_valid, ancestors, revokes, roles_needed),
             :ok <- authority_ok(op, roles_needed, ancestors, timelines) do
          :ok
        end
    end
  end

  defp command_defined?(module, cmd) do
    Enum.any?(module.__lattice_commands__(), fn {name, _arity, _args} -> name == cmd end)
  end

  defp command_mutations(_module, nil, _args), do: []

  defp command_mutations(module, cmd, args) do
    module.__apply_command__(cmd, args)
  rescue
    ArgumentError -> []
  end

  defp mutation_roles(module, mutations) do
    mutations
    |> Enum.map(fn {field, _m} -> module.authority_role(field) end)
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
  end

  defp cap_ok(op, cmd, delegations, deleg_valid, ancestors, revokes, roles_needed) do
    anc = Map.get(ancestors, op.id, MapSet.new())

    case Map.fetch(delegations, op.cap) do
      :error ->
        {:error, :no_capability}

      {:ok, %{deleg: d, op_ids: deleg_ops}} ->
        cond do
          deleg_valid[d.id] != :ok -> {:error, :invalid_capability}
          op.author != d.audience -> {:error, :capability_wrong_audience}
          not MapSet.member?(d.ops, cmd) -> {:error, :operation_not_granted}
          not Enum.any?(deleg_ops, &MapSet.member?(anc, &1)) -> {:error, :capability_not_visible}
          not Enum.all?(roles_needed, &MapSet.member?(d.roles, &1)) -> {:error, :role_not_granted}
          revoked_as_of?(op, d, delegations, revokes, ancestors) -> {:error, :revoked_capability}
          true -> :ok
        end
    end
  end

  # A delegation is revoked-as-of op O if a valid revoke of it (or an ancestor in
  # its chain) exists that O is not causally before.
  defp revoked_as_of?(op, deleg, delegations, revokes, ancestors) do
    chain_ids = delegation_chain_ids(deleg, delegations)

    Enum.any?(revokes, fn %{op_id: revoke_op, deleg_id: deleg_id} ->
      deleg_id in chain_ids and
        not MapSet.member?(Map.get(ancestors, revoke_op, MapSet.new()), op.id)
    end)
  end

  defp delegation_chain_ids(%Delegation{} = d, delegations) do
    case d.parent_id && Map.fetch(delegations, d.parent_id) do
      {:ok, %{deleg: parent}} -> [d.id | delegation_chain_ids(parent, delegations)]
      _ -> [d.id]
    end
  end

  defp authority_ok(_op, [], _ancestors, _timelines), do: :ok

  defp authority_ok(op, roles_needed, ancestors, timelines) do
    anc = Map.get(ancestors, op.id, MapSet.new())

    Enum.reduce_while(roles_needed, :ok, fn role, _ ->
      tl = Map.fetch!(timelines, role)
      holder_at_deps = holder_from_acquires(tl.acquires, anc)

      cond do
        holder_at_deps != op.author ->
          {:halt, {:error, :not_holder}}

        stale_holder?(op, holder_at_deps, tl, ancestors) ->
          {:halt, {:error, :stale_holder}}

        true ->
          {:cont, :ok}
      end
    end)
  end

  # Holder = the holder set by the latest (canonical order) acquire visible in `anc`.
  defp holder_from_acquires(acquires, anc) do
    acquires
    |> Enum.filter(&MapSet.member?(anc, &1.op_id))
    |> List.last()
    |> case do
      nil -> nil
      %{holder: h} -> h
    end
  end

  # Author held the role at its causal position; is it superseded by a holder-change
  # the op never saw and that never saw the op (concurrent away-move)?
  defp stale_holder?(op, author, tl, ancestors) do
    anc = Map.get(ancestors, op.id, MapSet.new())

    acquire_index =
      tl.acquires
      |> Enum.with_index()
      |> Enum.filter(fn {a, _i} -> MapSet.member?(anc, a.op_id) and a.holder == author end)
      |> List.last()

    case acquire_index do
      nil ->
        false

      {_acquire, i} ->
        case Enum.at(tl.acquires, i + 1) do
          nil ->
            false

          %{op_id: next_op} ->
            not MapSet.member?(Map.get(ancestors, next_op, MapSet.new()), op.id)
        end
    end
  end

  defp all_roles(module) do
    field_roles =
      module.__lattice_fields__()
      |> Enum.map(fn {field, _spec} -> module.authority_role(field) end)
      |> Enum.reject(&is_nil/1)

    succession_roles = Map.keys(module.__lattice_succession__())
    MapSet.new(field_roles ++ succession_roles)
  end
end
