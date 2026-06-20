defmodule Lattice.Sim do
  @moduledoc """
  Deterministic, in-process multi-realm simulator (pure; no BEAM processes).

  `Sim` is the harness the property suite and the demo drive: a set of realms, each
  holding its own `Lattice.Log` copy of one Replica, connected by a `Lattice.Net`.
  Everything is an immutable value transformed by pure functions, so a scenario is
  perfectly reproducible from its seed (property c: same seed → byte-identical).

  It exercises the full authority model — genesis grants, capability delegations,
  role transfers, revocations, successions, heartbeats — and authors command ops
  that cite the delegation authorizing them. It is deliberately separate from the
  live `Lattice.Materializer` process shell: both apply ops through the *same*
  `Lattice.Log`/`Lattice.Reduce`/`Lattice.Authority` code, which is what makes "the
  log is the truth; the connection is the cache" testable (behavior 18).
  """

  alias Lattice.{Authority, Identity, Log, Net, Op, Reduce, Sync}
  alias Lattice.Authority.Delegation

  defstruct module: nil, replica: nil, realms: %{}, logs: %{}, net: %Net{}, caps: %{}

  @type t :: %__MODULE__{
          module: module(),
          replica: String.t(),
          realms: %{String.t() => Identity.t()},
          logs: %{String.t() => Log.t()},
          net: Net.t(),
          caps: %{String.t() => [Delegation.t()]}
        }

  @doc "Create realms with deterministic keypairs derived from id + seed."
  @spec new(module(), String.t(), [String.t()], keyword()) :: t()
  def new(module, replica, realm_ids, opts \\ []) do
    seed = Keyword.get(opts, :seed, "sim")
    realms = Map.new(realm_ids, fn id -> {id, Identity.from_seed(id, "#{seed}:#{id}")} end)
    logs = Map.new(realm_ids, fn id -> {id, Log.new(replica)} end)
    caps = Map.new(realm_ids, fn id -> {id, []} end)
    %__MODULE__{module: module, replica: replica, realms: realms, logs: logs, caps: caps}
  end

  @doc """
  Establish the Replica: `creator_realm` self-grants full capability + all roles via
  a genesis op, seeded into every realm's log. `:policies` maps role => `%{successor:
  realm_id, dormant_ticks: n}` and is resolved to successor pubkeys in the log.
  Returns `{sim, genesis_op}`.
  """
  @spec create_replica(t(), String.t(), keyword()) :: {t(), Op.t()}
  def create_replica(%__MODULE__{} = sim, creator_realm, opts \\ []) do
    creator = identity(sim, creator_realm)
    ops = command_names(sim.module)
    roles = roles(sim.module)

    genesis_deleg =
      Delegation.genesis(creator, sim.replica,
        ops: ops,
        roles: MapSet.to_list(roles),
        live: true
      )

    policies =
      opts
      |> Keyword.get(:policies, %{})
      |> Map.new(fn {role, %{successor: succ, dormant_ticks: n}} ->
        {role, %{successor: identity(sim, succ).pub, dormant_ticks: n}}
      end)

    op = Op.new(creator, sim.replica, [], :authority, {:genesis, genesis_deleg, policies})

    sim =
      %{
        sim
        | logs:
            Map.new(sim.logs, fn {id, _log} -> {id, Log.append!(Log.new(sim.replica), op)} end)
      }
      |> add_cap(creator_realm, genesis_deleg)

    {sim, op}
  end

  @doc "`issuer_realm` delegates capability (`:ops`, `:roles`, `:live`) to `audience_realm`."
  @spec grant(t(), String.t(), String.t(), keyword()) :: {t(), Delegation.t()}
  def grant(%__MODULE__{} = sim, issuer_realm, audience_realm, opts \\ []) do
    issuer = identity(sim, issuer_realm)
    audience = identity(sim, audience_realm)
    parent = parent_delegation(sim, issuer_realm, opts)

    deleg =
      Delegation.new(issuer, sim.replica, audience.pub,
        ops: Keyword.get(opts, :ops, []),
        roles: Keyword.get(opts, :roles, []),
        live: Keyword.get(opts, :live, false),
        parent_id: parent && parent.id
      )

    {sim, _op} = append(sim, issuer_realm, :authority, {:grant, deleg})
    {add_cap(sim, audience_realm, deleg), deleg}
  end

  @doc "Current holder `from_realm` transfers `role` to `to_realm` (with lock ops)."
  @spec transfer(t(), String.t(), String.t(), atom(), keyword()) :: {t(), Delegation.t()}
  def transfer(%__MODULE__{} = sim, from_realm, to_realm, role, opts \\ []) do
    from = identity(sim, from_realm)
    to = identity(sim, to_realm)
    parent = parent_delegation(sim, from_realm, roles: [role])
    at_tick = Keyword.get(opts, :at_tick, 0)

    deleg =
      Delegation.new(from, sim.replica, to.pub,
        ops: Keyword.get(opts, :ops, [:lock, :unlock]),
        roles: [role],
        parent_id: parent && parent.id
      )

    {sim, _op} = append(sim, from_realm, :authority, {:transfer, role, deleg, at_tick})
    {add_cap(sim, to_realm, deleg), deleg}
  end

  @doc """
  `successor_realm` claims `role` via succession (valid only if dormancy met).
  Returns `{sim, succession_op}` — the op id is what authority quarantine reports.
  """
  @spec succeed(t(), String.t(), atom(), keyword()) :: {t(), Op.t()}
  def succeed(%__MODULE__{} = sim, successor_realm, role, opts \\ []) do
    successor = identity(sim, successor_realm)
    at_tick = Keyword.get(opts, :at_tick, 0)

    deleg =
      Delegation.new(successor, sim.replica, successor.pub,
        ops: Keyword.get(opts, :ops, [:lock, :unlock]),
        roles: [role],
        parent_id: nil
      )

    {sim, op} = append(sim, successor_realm, :authority, {:succeed, role, deleg, at_tick})
    {add_cap(sim, successor_realm, deleg), op}
  end

  @doc "Revoke a delegation by id (authored by `issuer_realm`)."
  @spec revoke(t(), String.t(), String.t()) :: {t(), Op.t()}
  def revoke(%__MODULE__{} = sim, issuer_realm, delegation_id) do
    append(sim, issuer_realm, :authority, {:revoke, delegation_id})
  end

  @doc "Holder liveness heartbeat at an explicit tick."
  @spec heartbeat(t(), String.t(), atom(), non_neg_integer()) :: {t(), Op.t()}
  def heartbeat(%__MODULE__{} = sim, holder_realm, role, at_tick) do
    append(sim, holder_realm, :authority, {:heartbeat, role, at_tick})
  end

  @doc "Queue an authoritative request through the holder (behavior 6)."
  @spec request(t(), String.t(), term(), {atom(), [term()]}) :: {t(), Op.t()}
  def request(%__MODULE__{} = sim, realm, ref, {_cmd, _args} = payload) do
    append(sim, realm, :inbox, {:request, ref, payload})
  end

  @doc """
  Author a command op on `realm`, citing the delegation that authorizes it.
  `:cap` overrides the cited delegation id (use `:none` for an unauthorized op).
  """
  @spec command(t(), String.t(), atom(), [term()], keyword()) :: {t(), Op.t()}
  def command(%__MODULE__{} = sim, realm, cmd, args, opts \\ []) do
    {:ok, body} = sim.module.command_body(cmd, args)

    cap =
      case Keyword.fetch(opts, :cap) do
        {:ok, :none} -> nil
        {:ok, id} -> id
        :error -> pick_cap(sim, realm, cmd)
      end

    append(sim, realm, :command, body, cap: cap)
  end

  @doc "Author and append a raw op (any kind/body) on `realm`'s local log."
  @spec append(t(), String.t(), Op.kind(), term(), keyword()) :: {t(), Op.t()}
  def append(%__MODULE__{} = sim, realm, kind, body, opts \\ []) do
    identity = identity(sim, realm)
    log = log(sim, realm)
    op = Op.new(identity, sim.replica, Log.frontier(log), kind, body, opts)
    {%{sim | logs: Map.put(sim.logs, realm, Log.append!(log, op))}, op}
  end

  # --- Network / convergence ----------------------------------------------

  @spec partition(t(), String.t(), String.t()) :: t()
  def partition(%__MODULE__{} = sim, a, b), do: %{sim | net: Net.partition(sim.net, a, b)}

  @spec heal(t(), String.t(), String.t()) :: t()
  def heal(%__MODULE__{} = sim, a, b), do: %{sim | net: Net.heal(sim.net, a, b)}

  @spec sync(t(), String.t(), String.t()) :: t()
  def sync(%__MODULE__{} = sim, a, b) do
    if Net.connected?(sim.net, a, b) do
      {la, lb, _report} = Sync.reconcile(log(sim, a), log(sim, b))
      %{sim | logs: sim.logs |> Map.put(a, la) |> Map.put(b, lb)}
    else
      sim
    end
  end

  @spec sync_all(t()) :: t()
  def sync_all(%__MODULE__{} = sim) do
    ids = Map.keys(sim.logs)
    pairs = for a <- ids, b <- ids, a < b, do: {a, b}
    converge(sim, pairs)
  end

  defp converge(sim, pairs) do
    next = Enum.reduce(pairs, sim, fn {a, b}, acc -> sync(acc, a, b) end)
    sizes = fn s -> Map.new(s.logs, fn {id, log} -> {id, Log.size(log)} end) end
    if sizes.(next) == sizes.(sim), do: next, else: converge(next, pairs)
  end

  # --- Reads ---------------------------------------------------------------

  @spec identity(t(), String.t()) :: Identity.t()
  def identity(%__MODULE__{realms: realms}, realm_id), do: Map.fetch!(realms, realm_id)

  @spec log(t(), String.t()) :: Log.t()
  def log(%__MODULE__{logs: logs}, realm_id), do: Map.fetch!(logs, realm_id)

  @spec state(t(), String.t()) :: map()
  def state(%__MODULE__{} = sim, realm_id) do
    log = log(sim, realm_id)
    quarantine = Authority.quarantine(sim.module, log)
    Reduce.reduce(sim.module, log, quarantine: quarantine)
  end

  @spec authority(t(), String.t()) :: Authority.analysis()
  def authority(%__MODULE__{} = sim, realm_id),
    do: Authority.analyze(sim.module, log(sim, realm_id))

  @spec holder(t(), String.t(), atom()) :: Identity.pubkey() | nil
  def holder(%__MODULE__{} = sim, realm_id, role),
    do: Authority.holder(sim.module, log(sim, realm_id), role)

  @doc "True if `realm_id`'s log quarantined `op_id`, with the recorded reason."
  @spec quarantined(t(), String.t(), Op.id()) :: {true, atom()} | false
  def quarantined(%__MODULE__{} = sim, realm_id, op_id) do
    analysis = authority(sim, realm_id)

    if MapSet.member?(analysis.quarantine, op_id),
      do: {true, Map.get(analysis.reasons, op_id)},
      else: false
  end

  # --- Internals -----------------------------------------------------------

  defp add_cap(sim, realm, %Delegation{} = deleg) do
    %{sim | caps: Map.update(sim.caps, realm, [deleg], &[deleg | &1])}
  end

  defp parent_delegation(sim, realm, opts) do
    needed_roles = opts |> Keyword.get(:roles, []) |> MapSet.new()
    needed_ops = opts |> Keyword.get(:ops, []) |> MapSet.new()

    sim.caps
    |> Map.get(realm, [])
    |> Enum.find(fn d ->
      MapSet.subset?(needed_roles, d.roles) and MapSet.subset?(needed_ops, d.ops)
    end)
  end

  defp pick_cap(sim, realm, cmd) do
    role = command_role(sim.module, cmd)

    sim.caps
    |> Map.get(realm, [])
    |> Enum.find(fn d ->
      MapSet.member?(d.ops, cmd) and (is_nil(role) or MapSet.member?(d.roles, role))
    end)
    |> case do
      nil -> nil
      %Delegation{id: id} -> id
    end
  end

  defp command_role(module, cmd) do
    case module.command_body(cmd, command_arg_stub(module, cmd)) do
      {:ok, {^cmd, _}} ->
        module
        |> apply(:__apply_command__, [cmd, command_arg_stub(module, cmd)])
        |> Enum.find_value(fn {field, _m} -> module.authority_role(field) end)

      _ ->
        nil
    end
  rescue
    _ -> nil
  end

  defp command_arg_stub(module, cmd) do
    case List.keyfind(module.__lattice_commands__(), cmd, 0) do
      {^cmd, arity, _} -> List.duplicate(nil, arity)
      _ -> []
    end
  end

  defp command_names(module) do
    module.__lattice_commands__() |> Enum.map(fn {name, _arity, _args} -> name end)
  end

  defp roles(module) do
    field_roles =
      module.__lattice_fields__()
      |> Enum.map(fn {field, _spec} -> module.authority_role(field) end)
      |> Enum.reject(&is_nil/1)

    MapSet.new(field_roles ++ Map.keys(module.__lattice_succession__()))
  end
end
