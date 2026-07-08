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
    * **Revocation authority**: a revoke op is honored only from the delegation
      issuer or replica root; other revoke ops are quarantined as
      `:unauthorized_revoke` and do not revoke the delegation.

  Quarantined ops stay in the log and are reported in `audit` (design invariant 4).
  """

  alias Lattice.Authority.Delegation
  alias Lattice.{Dag, Identity, Log, Op}

  # Separates a replica *name* from the root-key commitment bound into its id.
  @root_marker "#root:"

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
  Bind a replica *name* to its root public key, returning the replica id.

  Every op commits to its replica id (it is part of the signed/hashed encoding), so
  a bound id cryptographically pins *which* self-issued genesis is the legitimate
  root: a genesis forged by any other key cannot match the commitment, and `analyze`
  refuses to honor it. Idempotent — re-binding an already-bound id is a no-op.
  """
  @spec bind_replica(String.t(), Identity.pubkey()) :: String.t()
  def bind_replica(name, root_pub) when is_binary(name) and is_binary(root_pub) do
    case replica_commitment(name) do
      nil -> name <> @root_marker <> root_tag(root_pub)
      _already_bound -> name
    end
  end

  @doc "The root-key commitment carried by a bound replica id, or nil if unbound."
  @spec replica_commitment(String.t()) :: String.t() | nil
  def replica_commitment(replica) when is_binary(replica) do
    case String.split(replica, @root_marker, parts: 2) do
      [_name, tag] when byte_size(tag) > 0 -> tag
      _ -> nil
    end
  end

  @doc "The replica's bound root public key (nil until a valid root genesis is present)."
  @spec root(Log.t()) :: Identity.pubkey() | nil
  def root(%Log{} = log) do
    ordered = Log.topo_ops(log)
    {commitment, genesis_ids} = deleg_context(log, ordered)
    delegations = collect_delegations(ordered)
    deleg_valid = validate_delegations(delegations, commitment, genesis_ids)
    resolve_root(ordered, delegations, deleg_valid, commitment)
  end

  @doc """
  True if `log` carries a tombstone op authored by the replica's bound root.

  A tombstone is a privileged, irreversible kill switch, so — like every other
  authoritative op — it is honored only from the legitimate root. A tombstone
  forged by any other realm and synced in is ignored here and quarantined by
  `analyze` (`:unauthorized_tombstone`), not obeyed.
  """
  @spec tombstoned?(Log.t()) :: boolean()
  def tombstoned?(%Log{} = log) do
    case root(log) do
      nil ->
        false

      root_pub ->
        log
        |> Log.ops()
        |> Map.values()
        |> Enum.any?(&(&1.kind == :tombstone and &1.author == root_pub))
    end
  end

  # Collision-resistant commitment to a public key (full SHA-256, url-safe).
  defp root_tag(pub) when is_binary(pub) do
    :crypto.hash(:sha256, pub) |> Base.url_encode64(padding: false)
  end

  # A genesis is root-eligible when the replica is unbound (legacy) or its audience
  # matches the replica's root commitment.
  defp root_matches?(nil, _audience), do: true
  defp root_matches?(commitment, audience), do: root_tag(audience) == commitment

  # {replica root commitment, set of delegation ids introduced by :genesis ops}.
  defp deleg_context(%Log{} = log, ordered) do
    {replica_commitment(log.replica), genesis_deleg_ids(ordered)}
  end

  defp genesis_deleg_ids(ordered) do
    for op <- ordered, match?({:genesis, %Delegation{}, _}, op.body), into: MapSet.new() do
      {:genesis, %Delegation{id: id}, _} = op.body
      id
    end
  end

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

      not root_matches?(replica_commitment(replica), genesis.audience) ->
        {:error, :impostor_genesis}

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
    ordered = Log.topo_ops(log)
    {commitment, genesis_ids} = deleg_context(log, ordered)
    delegations = collect_delegations(ordered)

    case Map.fetch(delegations, delegation_id) do
      {:ok, %{deleg: %Delegation{} = d}} ->
        validate_delegation(d, delegations, commitment, genesis_ids) == :ok

      _ ->
        false
    end
  end

  @doc "True if a valid revoke of `delegation_id` currently exists (live-path check)."
  @spec revoked?(Log.t(), String.t()) :: boolean()
  def revoked?(%Log{} = log, delegation_id) do
    ordered = Log.topo_ops(log)
    {commitment, genesis_ids} = deleg_context(log, ordered)
    delegations = collect_delegations(ordered)
    deleg_valid = validate_delegations(delegations, commitment, genesis_ids)
    root = resolve_root(ordered, delegations, deleg_valid, commitment)

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

    {commitment, genesis_ids} = deleg_context(log, ordered)
    delegations = collect_delegations(ordered)
    deleg_valid = validate_delegations(delegations, commitment, genesis_ids)
    policies = collect_policies(ordered, delegations, deleg_valid)
    root = resolve_root(ordered, delegations, deleg_valid, commitment)
    revokes = collect_revokes(ordered, delegations, root)

    invalid_deleg = invalid_delegation_ops(delegations, deleg_valid)
    tombstone_q = unauthorized_tombstones(ordered, root)
    revoke_q = unauthorized_revokes(ordered, delegations, root)
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
      |> Map.merge(tombstone_q)
      |> Map.merge(revoke_q)

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
  # same grant appended by two realms). Track valid introducing op ids separately from
  # invalid same-id forgeries so an early bad signature cannot poison the genuine
  # delegation, while the forged op is still quarantined for audit.
  defp collect_delegations(ordered) do
    Enum.reduce(ordered, %{}, fn op, acc ->
      case delegation_in(op) do
        nil ->
          acc

        %Delegation{} = d ->
          collect_delegation_intro(acc, d, op.id)
      end
    end)
  end

  defp collect_delegation_intro(acc, %Delegation{} = d, op_id) do
    if Delegation.valid_sig?(d) do
      collect_valid_delegation_intro(acc, d, op_id)
    else
      collect_invalid_delegation_intro(acc, d, op_id)
    end
  end

  defp collect_valid_delegation_intro(acc, %Delegation{} = d, op_id) do
    Map.update(acc, d.id, %{deleg: d, op_ids: [op_id], invalid_ops: %{}}, fn entry ->
      %{entry | deleg: entry.deleg || d, op_ids: [op_id | entry.op_ids]}
    end)
  end

  defp collect_invalid_delegation_intro(acc, %Delegation{} = d, op_id) do
    Map.update(
      acc,
      d.id,
      %{deleg: nil, op_ids: [], invalid_ops: %{op_id => :bad_delegation_sig}},
      fn entry ->
        %{entry | invalid_ops: Map.put(entry.invalid_ops, op_id, :bad_delegation_sig)}
      end
    )
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

  # Succession policies are conferred only by a *valid* genesis — an impostor genesis
  # (one whose audience does not match the replica's root commitment) is quarantined
  # and cannot inject a successor.
  defp collect_policies(ordered, delegations, deleg_valid) do
    Enum.reduce(ordered, %{}, fn op, acc ->
      case op.body do
        {:genesis, %Delegation{id: id} = d, policies} when is_map(policies) ->
          if Map.get(deleg_valid, id) == :ok and valid_delegation_intro?(delegations, d, op.id),
            do: Map.merge(acc, policies),
            else: acc

        _ ->
          acc
      end
    end)
  end

  defp validate_delegations(delegations, commitment, genesis_ids) do
    Map.new(delegations, fn
      {id, %{deleg: %Delegation{} = d}} ->
        {id, validate_delegation(d, delegations, commitment, genesis_ids)}

      {id, %{deleg: nil}} ->
        {id, {:error, :bad_delegation_sig}}
    end)
  end

  defp validate_delegation(%Delegation{} = d, delegations, commitment, genesis_ids) do
    cond do
      not Delegation.valid_sig?(d) ->
        {:error, :bad_delegation_sig}

      is_nil(d.parent_id) ->
        cond do
          d.issuer != d.audience ->
            {:error, :nongenesis_root}

          # A self-issued delegation offered *as a genesis* (in a `:genesis` op) is the
          # replica's root claim: on a bound replica it is honored only if its audience
          # matches the committed root key, so a forged genesis confers nothing.
          MapSet.member?(genesis_ids, d.id) and not root_matches?(commitment, d.audience) ->
            {:error, :impostor_genesis}

          true ->
            :ok
        end

      true ->
        case Map.fetch(delegations, d.parent_id) do
          {:ok, %{deleg: %Delegation{} = parent}} ->
            cond do
              validate_delegation(parent, delegations, commitment, genesis_ids) != :ok ->
                {:error, :invalid_parent}

              not Delegation.attenuates?(d, parent) ->
                {:error, :not_attenuated}

              true ->
                :ok
            end

          {:ok, %{deleg: nil}} ->
            {:error, :invalid_parent}

          :error ->
            {:error, :missing_parent}
        end
    end
  end

  defp invalid_delegation_ops(delegations, deleg_valid) do
    invalid_intros =
      for {_id, %{invalid_ops: invalid_ops}} <- delegations,
          {op_id, reason} <- invalid_ops,
          into: %{} do
        {op_id, reason}
      end

    invalid_canonical =
      for {id, %{op_ids: op_ids}} <- delegations,
          deleg_valid[id] != :ok,
          op_id <- op_ids,
          into: %{} do
        {op_id, elem(deleg_valid[id], 1)}
      end

    Map.merge(invalid_canonical, invalid_intros)
  end

  # The single legitimate root: the audience of the *valid* genesis. On a bound
  # replica exactly one genesis can be valid (the one matching the commitment); on a
  # legacy unbound replica this is the first genesis in canonical order.
  defp resolve_root(ordered, delegations, deleg_valid, commitment) do
    Enum.find_value(ordered, fn op ->
      case op.body do
        {:genesis, %Delegation{id: id, audience: aud} = d, _policies} ->
          if Map.get(deleg_valid, id) == :ok and root_matches?(commitment, aud) and
               valid_delegation_intro?(delegations, d, op.id),
             do: aud

        _ ->
          nil
      end
    end)
  end

  # A tombstone is honored only from the bound root; any other author's tombstone is
  # quarantined (and therefore ignored by the lifecycle) rather than obeyed.
  defp unauthorized_tombstones(ordered, root) do
    for %Op{kind: :tombstone, id: id, author: author} <- ordered,
        author != root,
        into: %{},
        do: {id, :unauthorized_tombstone}
  end

  defp unauthorized_revokes(ordered, delegations, root) do
    for %Op{kind: :authority, id: id, body: {:revoke, deleg_id}} = op <- ordered,
        not revoke_authorized?(op, deleg_id, delegations, root),
        into: %{},
        do: {id, :unauthorized_revoke}
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
      {:ok, %{deleg: %Delegation{} = d}} -> author == d.issuer or author == root
      {:ok, %{deleg: nil}} -> false
      :error -> false
    end
  end

  defp valid_delegation_intro?(delegations, %Delegation{id: id}, op_id) do
    case Map.fetch(delegations, id) do
      {:ok, %{op_ids: op_ids}} -> op_id in op_ids
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

  defp role_event(%Op{kind: :authority, body: body} = op, role, delegations) do
    case body do
      {:genesis, %Delegation{} = d, _policies} ->
        if valid_delegation_intro?(delegations, d, op.id) and MapSet.member?(d.roles, role),
          do: {:genesis, d}

      {:transfer, ^role, %Delegation{} = d, tick} ->
        if valid_delegation_intro?(delegations, d, op.id), do: {:transfer, d, tick}

      {:succeed, ^role, %Delegation{} = d, tick} ->
        if valid_delegation_intro?(delegations, d, op.id), do: {:succeed, d, tick}

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
        | heartbeats: [%{op_id: op.id, at_tick: at_tick} | st.heartbeats],
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

      true ->
        case command_status(module, cmd, args) do
          :ok ->
            mutations = command_mutations(module, cmd, args)
            roles_needed = mutation_roles(module, mutations)

            with :ok <-
                   cap_ok(op, cmd, delegations, deleg_valid, ancestors, revokes, roles_needed),
                 :ok <- authority_ok(op, roles_needed, ancestors, timelines) do
              :ok
            end

          {:error, reason} ->
            {:error, reason}
        end
    end
  end

  defp command_status(module, cmd, args) do
    case module.command_body(cmd, args) do
      {:ok, {^cmd, _args}} -> :ok
      {:error, {:bad_arity, ^cmd, _details}} -> {:error, :bad_command_arity}
      {:error, {:unknown_command, ^cmd}} -> {:error, :unknown_command}
    end
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

      {:ok, %{deleg: %Delegation{} = d, op_ids: deleg_ops}} ->
        cond do
          deleg_valid[d.id] != :ok -> {:error, :invalid_capability}
          op.author != d.audience -> {:error, :capability_wrong_audience}
          not MapSet.member?(d.ops, cmd) -> {:error, :operation_not_granted}
          not Enum.any?(deleg_ops, &MapSet.member?(anc, &1)) -> {:error, :capability_not_visible}
          not Enum.all?(roles_needed, &MapSet.member?(d.roles, &1)) -> {:error, :role_not_granted}
          revoked_as_of?(op, d, delegations, revokes, ancestors) -> {:error, :revoked_capability}
          true -> :ok
        end

      {:ok, %{deleg: nil}} ->
        {:error, :invalid_capability}
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
      {:ok, %{deleg: %Delegation{} = parent}} ->
        [d.id | delegation_chain_ids(parent, delegations)]

      _ ->
        [d.id]
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
