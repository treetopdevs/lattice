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

  alias Lattice.Authority.{CommandVerdict, Delegation, DelegationIndex, RoleTimeline}
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
      nil -> name <> @root_marker <> DelegationIndex.root_tag(root_pub)
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
    log |> delegation_index(ordered) |> Map.fetch!(:root)
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

      not DelegationIndex.root_matches?(replica_commitment(replica), genesis.audience) ->
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
    log |> delegation_index(ordered) |> DelegationIndex.active?(delegation_id)
  end

  @doc "True if a valid revoke of `delegation_id` currently exists (live-path check)."
  @spec revoked?(Log.t(), String.t()) :: boolean()
  def revoked?(%Log{} = log, delegation_id) do
    ordered = Log.topo_ops(log)
    log |> delegation_index(ordered) |> DelegationIndex.revoked?(delegation_id)
  end

  @doc "Full authority analysis for `log` interpreted by Replica `module`."
  @spec analyze(module(), Log.t()) :: analysis()
  def analyze(module, %Log{} = log) do
    ops = Log.ops(log)
    ordered = Dag.topo_sort(ops)
    ancestors = Dag.all_ancestors(ops)
    index = delegation_index(log, ordered)
    roles = RoleTimeline.roles(module)

    timelines =
      Map.new(roles, fn role ->
        {role, RoleTimeline.build(role, ordered, ancestors, index)}
      end)

    holders = Map.new(timelines, fn {role, timeline} -> {role, timeline.holder} end)

    role_quarantine =
      Enum.reduce(timelines, %{}, fn {_role, timeline}, acc ->
        Map.merge(acc, timeline.quarantine)
      end)

    role_audit = Enum.flat_map(timelines, fn {_role, timeline} -> timeline.audit end)

    {command_quarantine, command_audit, requests} =
      CommandVerdict.validate(module, ordered, ancestors, index, timelines)

    reasons =
      index.invalid_ops
      |> Map.merge(role_quarantine)
      |> Map.merge(command_quarantine)
      |> Map.merge(unauthorized_tombstones(ordered, index.root))
      |> Map.merge(index.unauthorized_revokes)

    %{
      quarantine: reasons |> Map.keys() |> MapSet.new(),
      reasons: reasons,
      holders: holders,
      audit: role_audit ++ command_audit,
      requests: requests
    }
  end

  defp delegation_index(%Log{} = log, ordered) do
    DelegationIndex.build(ordered, replica_commitment(log.replica))
  end

  defp unauthorized_tombstones(ordered, root) do
    for %Op{kind: :tombstone, id: id, author: author} <- ordered,
        author != root,
        into: %{},
        do: {id, :unauthorized_tombstone}
  end
end
