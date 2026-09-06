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
    * `{:beacon, epoch}`                 — root-signed logical tick (plan 149)
    * `{:beacon, epoch, certificate}`    — bounded witness-authorized logical tick (plan 179);
      leases lapse when a valid beacon passes their `expires_epoch`

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
    * **Delegation leases** (plan 149): a delegation may carry `expires_epoch`; an
      op citing a chain with a lapsed lease — a valid beacon with a greater epoch
      exists that the op is not causally before — is quarantined `:lease_expired`.
      Root beacons and opt-in threshold-certified witness beacons are strictly
      monotonic in their causal ancestry; witness claims bind the op's actual author
      and dependencies under its ancestral root-pinned policy. Violators quarantine as
      `:unauthorized_beacon` / `:stale_beacon` and confer no lapse; witnessed epochs
      beyond the fixed portable horizon are structurally `:malformed_term`.
      Renewal is a fresh delegation with a
      later lease, never an in-place mutation.
    * **Application-policy causal context** (plan 158): after `cap_ok` and
      `authority_ok`, a command op is judged by the replica's
      `command_op_status/3`, given `visible_ids` plus a `context` of
      `visible_ops`/`verdicts` restricted to exactly the op's causal past and
      built in causal/canonical order — so the callback can require an
      honored target without ever seeing a concurrent/future op or its own
      not-yet-decided verdict. `command_op_status/2` remains a legacy
      compatibility target: the default `/3` calls it with `visible_ids`.
    * **Full-frontier command conflicts** (plan 158): once every op's
      individual verdict is final, `command_conflicts/3` runs one pass over
      the complete structurally accepted DAG and may declare deterministic
      losers among ops this analysis individually honored (e.g. two
      concurrent claims on the same key). Loser reasons apply last and can
      never resurrect an individually denied op; because analysis is
      recomputed from the current log on every call, a loser provisionally
      honored under a partial frontier is naturally reclassified once a
      canonically earlier concurrent winner syncs in.

  Quarantined ops stay in the log and are reported in `audit` (design invariant 4).
  """

  alias Lattice.Authority.{BeaconCertificate, Delegation, SuccessionCertificate}
  alias Lattice.{Dag, Identity, Log, Op}

  # Separates a replica *name* from the root-key commitment bound into its id.
  @root_marker "#root:"
  @witnessed_beacon_horizon 9_007_199_254_740_991

  @type analysis :: %{
          quarantine: MapSet.t(Op.id()),
          reasons: %{Op.id() => atom()},
          holders: %{atom() => Identity.pubkey() | nil},
          holder_epochs: %{atom() => %{holder: Identity.pubkey(), op_id: Op.id()}},
          policies: %{atom() => map()},
          audit: [map()],
          requests: [map()]
        }

  @doc "Set of op ids excluded from reduction by authority rules."
  @spec quarantine(module(), Log.t()) :: MapSet.t(Op.id())
  def quarantine(module, %Log{} = log), do: analyze(module, log).quarantine

  @doc "Current holder pubkey of `role` in `log` (nil if none / never granted)."
  @spec holder(module(), Log.t(), atom()) :: Identity.pubkey() | nil
  def holder(module, %Log{} = log, role), do: Map.get(analyze(module, log).holders, role)

  @doc "Current holder and acquisition op id for `role` (nil if none)."
  @spec holder_epoch(module(), Log.t(), atom()) ::
          %{holder: Identity.pubkey(), op_id: Op.id()} | nil
  def holder_epoch(module, %Log{} = log, role),
    do: Map.get(analyze(module, log).holder_epochs, role)

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
    {commitment, genesis_ids, succession_ids} = deleg_context(log, ordered)
    delegations = collect_delegations(ordered)

    deleg_valid =
      validate_delegations(delegations, commitment, genesis_ids, succession_ids, log.replica)

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

  # Replica root commitment plus delegation ids introduced by the two operations
  # that deliberately carry root-less self-issues.
  defp deleg_context(%Log{} = log, ordered) do
    {replica_commitment(log.replica), genesis_deleg_ids(ordered), succession_deleg_ids(ordered)}
  end

  defp genesis_deleg_ids(ordered) do
    for %Op{kind: :authority} = op <- ordered,
        match?({:genesis, %Delegation{}, _}, op.body),
        into: MapSet.new() do
      {:genesis, %Delegation{id: id}, _} = op.body
      id
    end
  end

  defp succession_deleg_ids(ordered) do
    for %Op{kind: :authority} = op <- ordered,
        match?({:succeed, _, %Delegation{}, _}, op.body),
        into: MapSet.new() do
      {:succeed, _role, %Delegation{id: id}, _proof} = op.body
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
    {commitment, genesis_ids, succession_ids} = deleg_context(log, ordered)
    delegations = collect_delegations(ordered)

    case Map.fetch(delegations, delegation_id) do
      {:ok, %{deleg: %Delegation{} = d}} ->
        validate_delegation(d, delegations, commitment, genesis_ids, succession_ids, log.replica) ==
          :ok and
          not expired?(log, delegation_id)

      _ ->
        false
    end
  end

  @doc """
  True if a valid beacon past a lease on `delegation_id`'s chain exists in
  `log` (plan 149, live-path check beside `revoked?/2`). Everything already on
  the log is "now" for the live path, so this ignores causal position — it asks
  whether the lease has lapsed at the current frontier.
  """
  @spec expired?(Log.t(), String.t()) :: boolean()
  def expired?(%Log{} = log, delegation_id) do
    ordered = Log.topo_ops(log)
    ancestors = Dag.all_ancestors(Log.ops(log))
    {commitment, genesis_ids, succession_ids} = deleg_context(log, ordered)
    delegations = collect_delegations(ordered)

    deleg_valid =
      validate_delegations(delegations, commitment, genesis_ids, succession_ids, log.replica)

    root = resolve_root(ordered, delegations, deleg_valid, commitment)
    beacon_policies = collect_beacon_policy_sources(ordered, delegations, deleg_valid)
    {beacons, _beacon_q} = collect_beacons(ordered, ancestors, root, beacon_policies)

    case Map.fetch(delegations, delegation_id) do
      {:ok, %{deleg: %Delegation{} = d}} ->
        d
        |> delegation_chain_links(delegations)
        |> Enum.any?(fn %Delegation{expires_epoch: expires} ->
          expires != nil and Enum.any?(beacons, fn %{epoch: epoch} -> epoch > expires end)
        end)

      _ ->
        false
    end
  end

  @doc "True if a valid revoke of `delegation_id` currently exists (live-path check)."
  @spec revoked?(Log.t(), String.t()) :: boolean()
  def revoked?(%Log{} = log, delegation_id) do
    ordered = Log.topo_ops(log)
    {commitment, genesis_ids, succession_ids} = deleg_context(log, ordered)
    delegations = collect_delegations(ordered)

    deleg_valid =
      validate_delegations(delegations, commitment, genesis_ids, succession_ids, log.replica)

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

    {commitment, genesis_ids, succession_ids} = deleg_context(log, ordered)
    delegations = collect_delegations(ordered)

    deleg_valid =
      validate_delegations(delegations, commitment, genesis_ids, succession_ids, log.replica)

    policies = collect_policies(ordered, delegations, deleg_valid)
    root = resolve_root(ordered, delegations, deleg_valid, commitment)
    revokes = collect_revokes(ordered, delegations, root)
    beacon_policies = collect_beacon_policy_sources(ordered, delegations, deleg_valid)
    {beacons, beacon_q} = collect_beacons(ordered, ancestors, root, beacon_policies)

    invalid_deleg = invalid_delegation_ops(ordered, delegations, deleg_valid, commitment)
    tombstone_q = unauthorized_tombstones(ordered, root)
    revoke_q = unauthorized_revokes(ordered, delegations, root)
    tick_q = malformed_tick_ops(ordered)
    roles = all_roles(module)

    timelines =
      Map.new(roles, fn role ->
        {role, build_role_timeline(role, ordered, ancestors, delegations, deleg_valid, policies)}
      end)

    holders = Map.new(timelines, fn {role, tl} -> {role, tl.holder} end)

    holder_epochs =
      Map.new(timelines, fn {role, tl} ->
        epoch =
          case List.last(tl.acquires) do
            nil -> nil
            %{holder: holder, op_id: op_id} -> %{holder: holder, op_id: op_id}
          end

        {role, epoch}
      end)

    role_q = Enum.reduce(timelines, %{}, fn {_r, tl}, acc -> Map.merge(acc, tl.quarantine) end)
    role_audit = Enum.flat_map(timelines, fn {_r, tl} -> tl.audit end)

    # Plan 158 Wave A2: every reason above is decided independently of any
    # application-policy verdict (none of them consult command_op_status), so
    # folding them first gives the per-command causal-context walk below a
    # complete, order-independent base for every prior op's verdict.
    base_reasons =
      invalid_deleg
      |> Map.merge(role_q)
      |> Map.merge(tombstone_q)
      |> Map.merge(revoke_q)
      |> Map.merge(beacon_q)
      |> Map.merge(tick_q)

    cap_evidence = %{
      delegations: delegations,
      deleg_valid: deleg_valid,
      revokes: revokes,
      beacons: beacons,
      timelines: timelines
    }

    {cmd_q, cmd_audit, requests} =
      validate_commands(module, ops, ordered, ancestors, cap_evidence, base_reasons)

    individual_reasons = Map.merge(base_reasons, cmd_q)

    # Full-frontier command-conflict phase (Plan 158 Wave A2): one
    # deterministic pass over the complete structurally accepted DAG, run
    # only after every op's individual causal verdict is final. It is the
    # one phase allowed to compare concurrent ops. A loser reason is applied
    # only to an op this analysis individually honored — filtering here
    # (rather than trusting the callback) means an individually denied op
    # can never be "resurrected" into a conflict loser instead, even by a
    # misbehaving `command_conflicts/3` implementation.
    full_verdicts =
      Map.new(ops, fn {id, _op} -> {id, Map.get(individual_reasons, id, :honored)} end)

    conflict_losers =
      module.command_conflicts(ops, full_verdicts, ancestors)
      |> Enum.filter(fn {id, _reason} -> Map.get(full_verdicts, id) == :honored end)
      |> Map.new()

    reasons = Map.merge(individual_reasons, conflict_losers)

    conflict_audit =
      for {id, reason} <- conflict_losers,
          do: %{event: :command_conflict, op: id, reason: reason}

    %{
      quarantine: reasons |> Map.keys() |> MapSet.new(),
      reasons: reasons,
      holders: holders,
      holder_epochs: holder_epochs,
      policies: policies,
      audit: role_audit ++ cmd_audit ++ conflict_audit,
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
      {:transfer, _role, %Delegation{} = d, tick} -> if valid_tick?(tick), do: d
      {:succeed, _role, %Delegation{} = d, _tick} -> d
      _ -> nil
    end
  end

  defp delegation_in(_), do: nil

  @doc """
  True when `tick` is a canonically encodable logical tick.

  A transfer carrying a malformed tick is quarantined as :malformed_term and
  must not introduce its delegation — a later command citing it then reports
  :no_capability, mirroring the TypeScript carrier's structural decode failure
  that drops the delegation evidence. A succession proof may instead be a
  non-integer witness term; malformed non-integer proofs stay on the existing
  :invalid_succession path, while integer proofs must satisfy this predicate.
  """
  @spec valid_tick?(term()) :: boolean()
  def valid_tick?(tick) do
    is_integer(tick) and tick >= 0 and tick <= Lattice.Canonical.max_integer()
  end

  # Tick shape is a structural property, not a role-timeline property: the
  # TypeScript decoder rejects a non-canonical tick before it ever consults
  # the schema, so a transfer/heartbeat naming an undeclared role must still
  # quarantine :malformed_term here or the two runtimes diverge.
  defp malformed_tick_ops(ordered) do
    for %Op{kind: :authority, body: body} = op <- ordered,
        malformed_tick_body?(body),
        into: %{},
        do: {op.id, :malformed_term}
  end

  defp malformed_tick_body?({:transfer, _role, %Delegation{}, tick}), do: not valid_tick?(tick)

  defp malformed_tick_body?({:succeed, _role, %Delegation{}, proof}) when is_integer(proof),
    do: not valid_tick?(proof)

  defp malformed_tick_body?({:heartbeat, _role, tick}), do: not valid_tick?(tick)

  defp malformed_tick_body?({:beacon, epoch, certificate}) do
    claim_epoch =
      if is_map(certificate) and is_map(Map.get(certificate, :claim)),
        do: Map.get(Map.get(certificate, :claim), :epoch)

    outside_beacon_horizon?(epoch) or outside_beacon_horizon?(claim_epoch)
  end

  defp malformed_tick_body?(_), do: false

  defp outside_beacon_horizon?(epoch),
    do: is_integer(epoch) and (epoch < 0 or epoch > @witnessed_beacon_horizon)

  # Succession policies are conferred only by a *valid* genesis — an impostor genesis
  # (one whose audience does not match the replica's root commitment) is quarantined
  # and cannot inject a successor.
  defp collect_policies(ordered, delegations, deleg_valid) do
    Enum.reduce(ordered, %{}, fn op, acc ->
      case op.body do
        {:genesis, %Delegation{id: id, audience: audience} = d, policies}
        when is_map(policies) ->
          if Map.get(deleg_valid, id) == :ok and
               is_nil(d.parent_id) and valid_delegation_intro?(delegations, d, op.id) and
               op.author == audience,
             do: Map.merge(acc, policies),
             else: acc

        _ ->
          acc
      end
    end)
  end

  defp validate_delegations(delegations, commitment, genesis_ids, succession_ids, log_replica) do
    Map.new(delegations, fn
      {id, %{deleg: %Delegation{} = d}} ->
        {id,
         validate_delegation(d, delegations, commitment, genesis_ids, succession_ids, log_replica)}

      {id, %{deleg: nil}} ->
        {id, {:error, :bad_delegation_sig}}
    end)
  end

  defp validate_delegation(
         %Delegation{} = d,
         delegations,
         commitment,
         genesis_ids,
         succession_ids,
         log_replica
       ) do
    cond do
      not Delegation.valid_sig?(d) ->
        {:error, :bad_delegation_sig}

      # A capability scoped to one replica is honored only on that replica's log.
      # Matches `cap_ok/9` and `verify_chain/2`: replica mismatch always rejects,
      # including on legacy unbound log names.
      d.replica != log_replica ->
        {:error, :wrong_replica}

      is_nil(d.parent_id) ->
        validate_rootless_delegation(d, commitment, genesis_ids, succession_ids)

      true ->
        validate_child_delegation(
          d,
          delegations,
          commitment,
          genesis_ids,
          succession_ids,
          log_replica
        )
    end
  end

  defp validate_rootless_delegation(d, commitment, genesis_ids, succession_ids) do
    cond do
      d.issuer != d.audience ->
        {:error, :nongenesis_root}

      # A self-issued delegation offered *as a genesis* (in a `:genesis` op) is the
      # replica's root claim: on a bound replica it is honored only if its audience
      # matches the committed root key, so a forged genesis confers nothing.
      MapSet.member?(genesis_ids, d.id) and root_matches?(commitment, d.audience) ->
        :ok

      # Successor self-issues are deliberately root-less. Their introducing
      # :succeed op must be honored before the delegation can confer a capability.
      MapSet.member?(succession_ids, d.id) ->
        {:candidate, d.id}

      MapSet.member?(genesis_ids, d.id) ->
        {:error, :impostor_genesis}

      true ->
        {:error, :unrooted_delegation}
    end
  end

  defp validate_child_delegation(
         d,
         delegations,
         commitment,
         genesis_ids,
         succession_ids,
         log_replica
       ) do
    case Map.fetch(delegations, d.parent_id) do
      {:ok, %{deleg: %Delegation{} = parent}} ->
        parent_validation =
          validate_delegation(
            parent,
            delegations,
            commitment,
            genesis_ids,
            succession_ids,
            log_replica
          )

        validate_attenuation(d, parent, parent_validation)

      {:ok, %{deleg: nil}} ->
        {:error, :invalid_parent}

      :error ->
        {:error, :missing_parent}
    end
  end

  defp validate_attenuation(d, parent, parent_validation) do
    cond do
      not Delegation.attenuates?(d, parent) -> {:error, :not_attenuated}
      parent_validation == :ok -> :ok
      match?({:candidate, _root_id}, parent_validation) -> parent_validation
      true -> {:error, :invalid_parent}
    end
  end

  defp invalid_delegation_ops(ordered, delegations, deleg_valid, commitment) do
    invalid_intros =
      for {_id, %{invalid_ops: invalid_ops}} <- delegations,
          {op_id, reason} <- invalid_ops,
          into: %{} do
        {op_id, reason}
      end

    invalid_canonical =
      for {id, %{op_ids: op_ids}} <- delegations,
          {:error, reason} <- [deleg_valid[id]],
          op_id <- op_ids,
          into: %{} do
        {op_id, reason}
      end

    invalid_genesis =
      for %Op{id: op_id, body: {:genesis, %Delegation{} = d, _policies}} <- ordered,
          Delegation.valid_sig?(d),
          valid_delegation_intro?(delegations, d, op_id),
          reason = invalid_genesis_reason(d, deleg_valid[d.id], commitment),
          not is_nil(reason),
          into: %{} do
        {op_id, reason}
      end

    invalid_canonical
    |> Map.merge(invalid_intros)
    |> Map.merge(invalid_genesis)
  end

  defp invalid_genesis_reason(%Delegation{parent_id: parent_id}, _validation, _commitment)
       when not is_nil(parent_id),
       do: :invalid_genesis

  defp invalid_genesis_reason(
         %Delegation{audience: audience},
         {:candidate, _succession_root_id},
         commitment
       ) do
    if root_matches?(commitment, audience), do: nil, else: :impostor_genesis
  end

  defp invalid_genesis_reason(_delegation, _validation, _commitment), do: nil

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

  # --- Epoch beacons (plan 149) -------------------------------------------

  # A beacon `{:beacon, epoch}` is a root-signed logical tick ON the log. Valid
  # iff root-authored with a non-negative integer epoch strictly greater than
  # every valid beacon epoch in the op's causal ancestry (processed in topo
  # order, so validity is itself a pure causal judgment). Violators quarantine
  # (:unauthorized_beacon / :stale_beacon) for audit and confer no lapse —
  # mirroring unauthorized_revokes and the Round-3 forged-authority handling.
  defp collect_beacon_policy_sources(ordered, delegations, deleg_valid) do
    for %Op{body: {:genesis, %Delegation{id: id, audience: audience} = d, policies}} = op <-
          ordered,
        is_map(policies),
        Map.get(deleg_valid, id) == :ok,
        is_nil(d.parent_id),
        valid_delegation_intro?(delegations, d, op.id),
        op.author == audience,
        Map.has_key?(policies, :__beacon__),
        do: {op.id, policies.__beacon__}
  end

  defp beacon_policy(sources, ancestors) do
    Enum.reduce(sources, nil, fn {id, value}, policy ->
      case {MapSet.member?(ancestors, id), BeaconCertificate.normalize_policy(value)} do
        {true, {:ok, normalized}} -> normalized
        _ -> policy
      end
    end)
  end

  defp collect_beacons(ordered, ancestors, root, policy_sources) do
    {valid, quarantine} =
      Enum.reduce(ordered, {%{}, %{}}, fn op, {valid, q} ->
        case op do
          %Op{kind: :authority, body: {:beacon, epoch}} ->
            classify_beacon(op, epoch, valid, q, ancestors, root)

          %Op{kind: :authority, body: {:beacon, epoch, certificate}} ->
            classify_witnessed_beacon(
              op,
              epoch,
              certificate,
              valid,
              q,
              ancestors,
              root,
              policy_sources
            )

          _ ->
            {valid, q}
        end
      end)

    {Enum.map(valid, fn {op_id, epoch} -> %{op_id: op_id, epoch: epoch} end), quarantine}
  end

  defp classify_beacon(op, epoch, valid, q, ancestors, root) do
    anc = Map.get(ancestors, op.id, MapSet.new())

    prior_max =
      valid
      |> Enum.filter(fn {op_id, _epoch} -> MapSet.member?(anc, op_id) end)
      |> Enum.map(&elem(&1, 1))
      |> Enum.max(fn -> -1 end)

    cond do
      op.author != root -> {valid, Map.put(q, op.id, :unauthorized_beacon)}
      not valid_epoch?(epoch, prior_max) -> {valid, Map.put(q, op.id, :stale_beacon)}
      true -> {Map.put(valid, op.id, epoch), q}
    end
  end

  defp valid_epoch?(epoch, prior_max),
    do: is_integer(epoch) and epoch >= 0 and epoch > prior_max

  defp classify_witnessed_beacon(op, epoch, certificate, valid, q, ancestors, root, sources) do
    anc = Map.get(ancestors, op.id, MapSet.new())
    policy = beacon_policy(sources, anc)

    prior_max =
      valid
      |> Enum.filter(fn {id, _} -> MapSet.member?(anc, id) end)
      |> Enum.map(&elem(&1, 1))
      |> Enum.max(fn -> -1 end)

    expected = BeaconCertificate.claim(op.replica, epoch, op.author, op.deps)

    cond do
      malformed_tick_body?(op.body) ->
        {valid, Map.put(q, op.id, :malformed_term)}

      is_nil(policy) ->
        {valid, Map.put(q, op.id, :unauthorized_beacon)}

      op.author != root and op.author not in policy.witnesses ->
        {valid, Map.put(q, op.id, :unauthorized_beacon)}

      BeaconCertificate.verify(certificate, expected, policy) != :ok ->
        {valid, Map.put(q, op.id, :unauthorized_beacon)}

      not valid_epoch?(epoch, prior_max) ->
        {valid, Map.put(q, op.id, :stale_beacon)}

      epoch > prior_max + policy.max_epoch_step ->
        {valid, Map.put(q, op.id, :unauthorized_beacon)}

      true ->
        {Map.put(valid, op.id, epoch), q}
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

        {:malformed_tick, op} ->
          reject(st, op, :malformed_term, role)

        {:genesis, d} ->
          cond do
            deleg_valid[d.id] != :ok or not MapSet.member?(d.roles, role) ->
              st

            not is_nil(d.parent_id) ->
              reject(st, op, :invalid_genesis, role)

            op.author != d.audience ->
              reject(st, op, :unauthorized_genesis, role)

            true ->
              record_acquire(st, op, d, 0)
          end

        {:transfer, d, at_tick} ->
          decide_transfer(st, op, role, d, at_tick, ancestors, deleg_valid)

        {:succeed, d, proof} ->
          decide_succeed(st, op, role, d, proof, ancestors, deleg_valid, policies)

        {:heartbeat, at_tick} ->
          decide_heartbeat(st, op, at_tick, ancestors)
      end
    end)
  end

  # Step 2b(e): a tick may enter a role timeline only as a canonical
  # non-negative integer within the wire's uint64 range. Erlang orders all
  # terms, so an unguarded non-integer tick would be recorded, win
  # `last_active_from/3`'s max, and raise ArithmeticError in every later
  # dormancy evaluation. A succession proof may instead be a non-integer
  # witness term, judged downstream by `decide_succession_proof/7`; integer
  # proofs must be portable before entering that path. The tick predicate is
  # public because `compaction_spike.ex` mirrors these decisions.
  defp role_event(%Op{kind: :authority, body: body} = op, role, delegations) do
    case body do
      {:genesis, %Delegation{} = d, _policies} ->
        if valid_delegation_intro?(delegations, d, op.id) and MapSet.member?(d.roles, role),
          do: {:genesis, d}

      {:transfer, ^role, %Delegation{} = d, tick} ->
        # Plan 162 step 2b(e) routes a malformed tick to explicit quarantine
        # rather than dropping it silently, so the reason is attributable and
        # the TypeScript decoder's :malformed_term verdict stays mirrored.
        cond do
          not valid_tick?(tick) -> {:malformed_tick, op}
          not valid_delegation_intro?(delegations, d, op.id) -> nil
          true -> {:transfer, d, tick}
        end

      {:succeed, ^role, %Delegation{} = d, proof} ->
        cond do
          is_integer(proof) and not valid_tick?(proof) -> {:malformed_tick, op}
          not valid_delegation_intro?(delegations, d, op.id) -> nil
          true -> {:succeed, d, proof}
        end

      {:heartbeat, ^role, tick} ->
        if valid_tick?(tick), do: {:heartbeat, tick}, else: {:malformed_tick, op}

      _ ->
        nil
    end
  end

  defp role_event(_op, _role, _delegations), do: nil

  defp record_acquire(st, op, %Delegation{} = delegation, at_tick) do
    %{
      st
      | holder: delegation.audience,
        acquires:
          st.acquires ++
            [
              %{
                op_id: op.id,
                holder: delegation.audience,
                delegation_id: delegation.id,
                at_tick: at_tick
              }
            ],
        decided:
          Map.put(st.decided, op.id, %{
            type: :acquire,
            holder: delegation.audience,
            at_tick: at_tick
          })
    }
  end

  defp decide_transfer(st, op, role, d, at_tick, ancestors, deleg_valid) do
    anc = Map.get(ancestors, op.id, MapSet.new())
    holder_at_deps = holder_from_acquires(st.acquires, anc)

    cond do
      not delegation_valid_at?(deleg_valid[d.id], st.acquires, anc) or
        op.author != d.issuer or not MapSet.member?(d.roles, role) ->
        reject(st, op, :invalid_transfer, role)

      holder_at_deps != op.author ->
        reject(st, op, :transfer_not_holder, role)

      st.holder != op.author ->
        # A concurrent transfer by the same holder already moved the token: anomaly.
        reject(st, op, :double_transfer, role)

      true ->
        record_acquire(st, op, d, at_tick)
    end
  end

  defp decide_succeed(st, op, role, d, proof, ancestors, deleg_valid, policies) do
    anc = Map.get(ancestors, op.id, MapSet.new())
    policy = Map.get(policies, role)

    cond do
      not succession_delegation?(deleg_valid[d.id], d.id) or
        op.author != d.audience or op.author != d.issuer or
          not MapSet.member?(d.roles, role) ->
        reject(st, op, :invalid_succession, role)

      is_nil(policy) or op.author != policy.successor ->
        reject(st, op, :unauthorized_succession, role)

      Map.has_key?(policy, :recovery) and Map.has_key?(policy, :dormant_ticks) ->
        reject(st, op, :invalid_recovery_policy, role)

      true ->
        decide_succession_proof(st, op, role, d, proof, anc, policy)
    end
  end

  defp decide_succession_proof(st, op, role, d, at_tick, anc, %{dormant_ticks: dormant_ticks})
       when is_integer(at_tick) do
    last_active = last_active_from(st.acquires, st.heartbeats, anc)

    if at_tick < last_active + dormant_ticks,
      do: reject(st, op, :premature_succession, role),
      else: record_acquire(st, op, d, at_tick)
  end

  defp decide_succession_proof(st, op, role, _d, at_tick, _anc, %{recovery: recovery})
       when is_integer(at_tick) do
    case SuccessionCertificate.normalize_policy(recovery) do
      {:ok, _normalized} -> reject(st, op, :recovery_certificate_required, role)
      {:error, reason} -> reject(st, op, reason, role)
    end
  end

  defp decide_succession_proof(
         st,
         op,
         role,
         d,
         {:witnessed, certificate},
         anc,
         %{recovery: recovery}
       ) do
    with %{holder: holder, op_id: holder_epoch} <- holder_acquire_from(st.acquires, anc),
         true <- st.holder == holder,
         {:ok, expected_claim} <-
           SuccessionCertificate.claim(
             op.replica,
             role,
             holder,
             holder_epoch,
             op.author,
             recovery
           ),
         :ok <- SuccessionCertificate.verify(certificate, expected_claim, recovery) do
      record_acquire(st, op, d, 0)
    else
      {:error, reason} -> reject(st, op, reason, role)
      _ -> reject(st, op, :recovery_claim_mismatch, role)
    end
  end

  defp decide_succession_proof(st, op, role, _d, {:witnessed, _certificate}, _anc, _policy),
    do: reject(st, op, :witnessed_recovery_not_configured, role)

  defp decide_succession_proof(st, op, role, _d, _proof, _anc, _policy),
    do: reject(st, op, :invalid_succession, role)

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

  defp validate_commands(module, ops, ordered, ancestors, cap_evidence, base_reasons) do
    Enum.reduce(ordered, {%{}, [], []}, fn op, {quarantine, audit, requests} ->
      cond do
        op.kind == :inbox and match?({:request, _ref, _payload}, op.body) ->
          {:request, ref, payload} = op.body

          {quarantine, audit,
           requests ++ [%{op: op.id, author: op.author, ref: ref, payload: payload}]}

        op.kind == :command ->
          context = causal_context(op, ops, ancestors, base_reasons, quarantine)

          case validate_command(module, op, ancestors, cap_evidence, context) do
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

  # Plan 158 Wave A2: the causal context handed to `command_op_status/3` —
  # `visible_ops` and `verdicts` restricted to exactly `op`'s causal past
  # (never `op` itself, never a concurrent or future op). Topo order
  # guarantees every ancestor was already folded into `quarantine_so_far`
  # (if it was itself a command op) or is independently decided in
  # `base_reasons` (every other reason never depends on command_op_status),
  # so every id's verdict here is final by the time `op` consults it.
  defp causal_context(op, ops, ancestors, base_reasons, quarantine_so_far) do
    anc = Map.get(ancestors, op.id, MapSet.new())
    visible_ops = Map.take(ops, MapSet.to_list(anc))

    verdicts =
      Map.new(anc, fn id ->
        reason = Map.get(base_reasons, id) || Map.get(quarantine_so_far, id)
        {id, reason || :honored}
      end)

    %{visible_ops: visible_ops, verdicts: verdicts}
  end

  defp validate_command(module, op, ancestors, cap_evidence, context) do
    %{
      delegations: delegations,
      deleg_valid: deleg_valid,
      revokes: revokes,
      beacons: beacons,
      timelines: timelines
    } = cap_evidence

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
                   cap_ok(
                     op,
                     cmd,
                     delegations,
                     deleg_valid,
                     ancestors,
                     revokes,
                     beacons,
                     timelines,
                     roles_needed
                   ),
                 :ok <- authority_ok(op, roles_needed, ancestors, timelines) do
              # ADR 0007 / Plan 158 Wave A2: the replica's op-aware validity
              # conjunct (e.g. the co-signed consent check, or a causal-context
              # policy), judged over the op, its causal-past id set, and the
              # causal context (visible ops + their deterministic verdicts).
              module.command_op_status(op, Map.get(ancestors, op.id, MapSet.new()), context)
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

  # Clause order is pinned (replica → validity → audience → grant scope →
  # visibility → roles → revoked → expired) so an op that is both revoked and
  # lease-expired reports :revoked_capability on every realm — reason
  # precedence must not flap across replicas.
  defp cap_ok(
         op,
         cmd,
         delegations,
         deleg_valid,
         ancestors,
         revokes,
         beacons,
         timelines,
         roles_needed
       ) do
    anc = Map.get(ancestors, op.id, MapSet.new())

    case Map.fetch(delegations, op.cap) do
      :error ->
        {:error, :no_capability}

      {:ok, %{deleg: %Delegation{} = d, op_ids: deleg_ops}} ->
        cond do
          d.replica != op.replica ->
            {:error, :wrong_replica}

          not capability_delegation_valid?(
            deleg_valid[d.id],
            d,
            deleg_ops,
            anc,
            timelines
          ) ->
            {:error, :invalid_capability}

          op.author != d.audience ->
            {:error, :capability_wrong_audience}

          not MapSet.member?(d.ops, cmd) ->
            {:error, :operation_not_granted}

          not Enum.any?(deleg_ops, &MapSet.member?(anc, &1)) ->
            {:error, :capability_not_visible}

          not Enum.all?(roles_needed, &MapSet.member?(d.roles, &1)) ->
            {:error, :role_not_granted}

          revoked_as_of?(op, d, delegations, revokes, ancestors) ->
            {:error, :revoked_capability}

          expired_as_of?(op, d, delegations, beacons, ancestors) ->
            {:error, :lease_expired}

          true ->
            :ok
        end

      {:ok, %{deleg: nil}} ->
        {:error, :invalid_capability}
    end
  end

  defp capability_delegation_valid?(:ok, _delegation, _intro_ops, _ancestors, _timelines),
    do: true

  defp capability_delegation_valid?(
         {:candidate, root_id},
         %Delegation{},
         _intro_ops,
         ancestors,
         timelines
       ) do
    timelines
    |> Enum.flat_map(fn {_role, timeline} -> timeline.acquires end)
    |> delegation_candidate_activated?(root_id, ancestors)
  end

  defp capability_delegation_valid?(
         _validation,
         _delegation,
         _intro_ops,
         _ancestors,
         _timelines
       ),
       do: false

  defp succession_delegation?(:ok, _delegation_id), do: true
  defp succession_delegation?({:candidate, delegation_id}, delegation_id), do: true
  defp succession_delegation?(_validation, _delegation_id), do: false

  defp delegation_valid_at?(:ok, _acquires, _ancestors), do: true

  defp delegation_valid_at?({:candidate, root_id}, acquires, ancestors),
    do: delegation_candidate_activated?(acquires, root_id, ancestors)

  defp delegation_valid_at?(_validation, _acquires, _ancestors), do: false

  defp delegation_candidate_activated?(acquires, root_id, ancestors) do
    Enum.any?(acquires, fn acquire ->
      acquire.delegation_id == root_id and MapSet.member?(ancestors, acquire.op_id)
    end)
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

  # A delegation is lease-expired-as-of op O (plan 149) if some link of its
  # chain carries expires_epoch E and a valid beacon with epoch > E exists that
  # O is not causally before — character-for-character the revoked_as_of? shape,
  # so the convergence and replay-stability arguments are the ones already
  # proven for revocation.
  defp expired_as_of?(op, deleg, delegations, beacons, ancestors) do
    deleg
    |> delegation_chain_links(delegations)
    |> Enum.any?(fn %Delegation{expires_epoch: expires} ->
      expires != nil and
        Enum.any?(beacons, fn %{epoch: epoch, op_id: beacon_op} ->
          epoch > expires and
            not MapSet.member?(Map.get(ancestors, beacon_op, MapSet.new()), op.id)
        end)
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

  defp delegation_chain_links(%Delegation{} = d, delegations) do
    case d.parent_id && Map.fetch(delegations, d.parent_id) do
      {:ok, %{deleg: %Delegation{} = parent}} ->
        [d | delegation_chain_links(parent, delegations)]

      _ ->
        [d]
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
    case holder_acquire_from(acquires, anc) do
      nil -> nil
      %{holder: h} -> h
    end
  end

  defp holder_acquire_from(acquires, anc) do
    acquires
    |> Enum.filter(&MapSet.member?(anc, &1.op_id))
    |> List.last()
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
