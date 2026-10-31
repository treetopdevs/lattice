defmodule Lattice.Verdict do
  @moduledoc """
  A portable record of why one op is honored or quarantined (plan 287).

  `explain/3` answers "why was this request honored or refused?" for a single op, and
  `delegation_status/3` answers "may this delegate still act?" for a delegation. Both
  are pure functions of one log: no process, no cache, no custody. A consumer that
  only holds a log copy can call them without signing anything.

  ## Derivation rules

  * The verdict and `reason` come only from `Lattice.Authority.analyze/2`. This module
    never judges an op itself, so it cannot disagree with the judge.
  * Evidence is tied to the reason. `revoked_by` is set only when the reason is
    `:revoked_capability`: the first effective `{:revoke, id}` authority op (authored
    by that link's issuer or the replica root, the judge's predicate), in topological
    order, whose `id` is a link of the cited delegation's chain and which the op is not
    causally before. `lapsed_by_beacon` is set only when the reason is
    `:lease_expired`: the smallest epoch among the beacons the judge accepted
    (`Authority.analyze_with_beacon_evidence/2`) that is greater than the chain's
    tightest `expires_epoch` and that the op is not causally before. Both are `nil` on
    every honored op, even when the log also holds the revoke or beacon.
  * `cited_delegation_id` is the op's `cap`, or, for an authority op that carries a
    delegation (grant, transfer, succession), that delegation's parent: the authority
    the author exercised.
  * `expires_epoch` is the tightest lease on the cited delegation's chain (`nil` when
    no link is leased or the delegation is not on the log).
  * `frontier` is the sorted frontier of the log the verdict was taken from. A verdict
    is true as of that frontier only: a consumer that has not pulled since a revoke or
    beacon will still see the delegate as honored.

  ## Delegation status

  `delegation_status/3` judges a delegation as of the whole log, the way the live path
  does (everything on the log is "now"). Precedence matches the judge's: `:revoked`
  before `:lapsed`. A delegation the log has never carried is `:unknown`, never
  `:active`. A delegation that is on the log but not revoked, not lapsed and not valid
  (a bad chain, or an unactivated succession candidate) is `:invalid`. Only `:active`
  permits action; every other status is a refusal.

  The status also names the delegation's `audience` (hex public key) and granted `ops`,
  so a consumer can check that the delegation is addressed to the actor it is judging
  and confers the action it is about to allow, without reading authority internals.
  """

  alias Jason.OrderedObject
  alias Lattice.{Authority, Dag, Log, Op}
  alias Lattice.Authority.Delegation

  @schema "lattice-verdict-v1"
  @status_schema "lattice-delegation-status-v1"

  @type record :: %{
          schema: String.t(),
          replica: String.t(),
          op_id: Op.id(),
          author: String.t(),
          kind: Op.kind(),
          verdict: :honored | :quarantined,
          reason: atom() | nil,
          cited_delegation_id: String.t() | nil,
          evidence: %{revoked_by: Op.id() | nil, lapsed_by_beacon: non_neg_integer() | nil},
          expires_epoch: non_neg_integer() | nil,
          frontier: [Op.id()]
        }

  @type status :: %{
          schema: String.t(),
          delegation_id: String.t(),
          status: :active | :revoked | :lapsed | :invalid | :unknown,
          audience: String.t() | nil,
          ops: [atom()],
          revoked_by: Op.id() | nil,
          expires_epoch: non_neg_integer() | nil,
          latest_beacon_epoch: non_neg_integer() | nil,
          frontier: [Op.id()]
        }

  @doc "Explain the judge's verdict on `op_id` in `log`, interpreted by Replica `module`."
  @spec explain(module(), Log.t(), Op.id()) ::
          {:honored, record()} | {:quarantined, record()} | {:unknown_op, Op.id()}
  def explain(module, %Log{} = log, op_id) do
    case Log.fetch(log, op_id) do
      :error -> {:unknown_op, op_id}
      {:ok, %Op{} = op} -> explain_op(module, log, op)
    end
  end

  defp explain_op(module, log, op) do
    {analysis, beacons} = Authority.analyze_with_beacon_evidence(module, log)
    ordered = Log.topo_ops(log)
    delegations = delegations(ordered)
    reason = Map.get(analysis.reasons, op.id)
    cited = cited_delegation_id(op)
    chain = chain(cited, delegations)
    expires = tightest_lease(chain)
    after_op? = &not_causally_before?(log, op.id, &1)

    evidence = %{
      revoked_by:
        if(reason == :revoked_capability,
          do: first_revoke(ordered, chain, Authority.root(log), after_op?)
        ),
      lapsed_by_beacon:
        if(reason == :lease_expired, do: lapsing_epoch(beacons, expires, after_op?))
    }

    verdict = if MapSet.member?(analysis.quarantine, op.id), do: :quarantined, else: :honored

    record = %{
      schema: @schema,
      replica: log.replica,
      op_id: op.id,
      author: Base.encode16(op.author, case: :lower),
      kind: op.kind,
      verdict: verdict,
      reason: reason,
      cited_delegation_id: cited,
      evidence: evidence,
      expires_epoch: expires,
      frontier: frontier(log)
    }

    {verdict, record}
  end

  @doc """
  The status of `delegation_id` as of the whole of `log`, interpreted by `module`.

  `module` is needed because the accepted beacons come from the judge's own pass
  (`Authority.analyze_with_beacon_evidence/2`).
  """
  @spec delegation_status(module(), Log.t(), String.t()) :: status()
  def delegation_status(module, %Log{} = log, delegation_id) when is_binary(delegation_id) do
    {_analysis, beacons} = Authority.analyze_with_beacon_evidence(module, log)
    ordered = Log.topo_ops(log)
    delegations = delegations(ordered)
    chain = chain(delegation_id, delegations)
    expires = tightest_lease(chain)
    revoked_by = first_revoke(ordered, chain, Authority.root(log), fn _revoke -> true end)
    latest = beacons |> Enum.map(& &1.epoch) |> Enum.max(fn -> nil end)

    status =
      cond do
        chain == [] -> :unknown
        revoked_by != nil -> :revoked
        expires != nil and latest != nil and latest > expires -> :lapsed
        Authority.delegation_active?(log, delegation_id) -> :active
        true -> :invalid
      end

    {audience, ops} =
      case chain do
        [%Delegation{} = d | _] -> {Base.encode16(d.audience, case: :lower), Enum.sort(d.ops)}
        [] -> {nil, []}
      end

    %{
      schema: @status_schema,
      delegation_id: delegation_id,
      status: status,
      audience: audience,
      ops: ops,
      revoked_by: revoked_by,
      expires_epoch: expires,
      latest_beacon_epoch: latest,
      frontier: frontier(log)
    }
  end

  @doc """
  Deterministic JSON for a verdict record or a delegation status: fixed key order via
  `Jason.OrderedObject`, pretty-printed with a trailing newline, as
  `Township.AuditBundle` writes its artifacts.
  """
  @spec to_json(record() | status()) :: binary()
  def to_json(%{schema: @schema} = record) do
    OrderedObject.new([
      {"schema", record.schema},
      {"replica", record.replica},
      {"op_id", record.op_id},
      {"author", record.author},
      {"kind", Atom.to_string(record.kind)},
      {"verdict", Atom.to_string(record.verdict)},
      {"reason", atom_or_nil(record.reason)},
      {"cited_delegation_id", record.cited_delegation_id},
      {"evidence",
       OrderedObject.new([
         {"revoked_by", record.evidence.revoked_by},
         {"lapsed_by_beacon", record.evidence.lapsed_by_beacon}
       ])},
      {"expires_epoch", record.expires_epoch},
      {"frontier", record.frontier}
    ])
    |> encode()
  end

  def to_json(%{schema: @status_schema} = status) do
    OrderedObject.new([
      {"schema", status.schema},
      {"delegation_id", status.delegation_id},
      {"status", Atom.to_string(status.status)},
      {"audience", status.audience},
      {"ops", Enum.map(status.ops, &Atom.to_string/1)},
      {"revoked_by", status.revoked_by},
      {"expires_epoch", status.expires_epoch},
      {"latest_beacon_epoch", status.latest_beacon_epoch},
      {"frontier", status.frontier}
    ])
    |> encode()
  end

  defp encode(object), do: Jason.encode!(object, pretty: true) <> "\n"

  defp atom_or_nil(nil), do: nil
  defp atom_or_nil(atom) when is_atom(atom), do: Atom.to_string(atom)

  defp frontier(log), do: log |> Log.frontier() |> Enum.sort()

  # --- Delegation chain ------------------------------------------------------

  defp cited_delegation_id(%Op{cap: cap}) when is_binary(cap), do: cap

  defp cited_delegation_id(%Op{kind: :authority, body: body}) do
    case carried_delegation(body) do
      %Delegation{parent_id: parent} -> parent
      nil -> nil
    end
  end

  defp cited_delegation_id(_op), do: nil

  # The delegation shapes the judge introduces from authority bodies.
  defp carried_delegation({:genesis, %Delegation{} = d, _policies}), do: d
  defp carried_delegation({:grant, %Delegation{} = d}), do: d

  defp carried_delegation({:transfer, _role, %Delegation{} = d, tick}),
    do: if(Authority.valid_tick?(tick), do: d)

  defp carried_delegation({:succeed, _role, %Delegation{} = d, _tick}), do: d
  defp carried_delegation(_body), do: nil

  # First correctly signed introduction of each id, in topological order.
  defp delegations(ordered) do
    Enum.reduce(ordered, %{}, fn
      %Op{kind: :authority, body: body}, acc ->
        case carried_delegation(body) do
          %Delegation{} = d ->
            if Delegation.valid_sig?(d), do: Map.put_new(acc, d.id, d), else: acc

          nil ->
            acc
        end

      _op, acc ->
        acc
    end)
  end

  # The cited delegation and its ancestors, nearest first; `[]` when it is not on the log.
  defp chain(nil, _delegations), do: []
  defp chain(id, delegations), do: chain(id, delegations, MapSet.new())

  defp chain(id, delegations, seen) do
    with false <- MapSet.member?(seen, id),
         %Delegation{} = d <- Map.get(delegations, id) do
      [d | chain(d.parent_id, delegations, MapSet.put(seen, id))]
    else
      _ -> []
    end
  end

  defp tightest_lease(chain) do
    chain |> Enum.map(& &1.expires_epoch) |> Enum.reject(&is_nil/1) |> Enum.min(fn -> nil end)
  end

  # --- Evidence --------------------------------------------------------------

  # A revoke takes effect when its author is the revoked link's issuer or the replica
  # root: the judge's own predicate, whatever reason the revoke op itself carries.
  defp first_revoke(ordered, chain, root, eligible?) do
    links = Map.new(chain, &{&1.id, &1})

    Enum.find_value(ordered, fn
      %Op{kind: :authority, body: {:revoke, target}} = op ->
        case Map.fetch(links, target) do
          {:ok, %Delegation{issuer: issuer}} ->
            if (op.author == issuer or op.author == root) and eligible?.(op.id), do: op.id

          :error ->
            nil
        end

      _op ->
        nil
    end)
  end

  defp lapsing_epoch(_beacons, nil, _eligible?), do: nil

  defp lapsing_epoch(beacons, expires, eligible?) do
    beacons
    |> Enum.filter(&(&1.epoch > expires and eligible?.(&1.op_id)))
    |> Enum.map(& &1.epoch)
    |> Enum.min(fn -> nil end)
  end

  # True unless `op_id` is a causal ancestor of `other_id`.
  defp not_causally_before?(log, op_id, other_id),
    do: not MapSet.member?(Dag.ancestors(Log.ops(log), other_id), op_id)
end
