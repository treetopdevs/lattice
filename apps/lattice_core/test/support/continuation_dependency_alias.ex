defmodule Treehouse.ContinuationDependencyAlias do
  @moduledoc "Fresh product histories for canonical dependency alias reciprocity."
  alias Lattice.{Authority, Log, Op, Sim}
  alias Lattice.Authority.{ContinuationCertificate, Delegation}
  alias Lattice.Carrier.Wire
  alias Treehouse.CatalogCutoff

  @spec fixture(:space | :thread) :: map()
  def fixture(kind) do
    {module, role, command} =
      if kind == :space,
        do: {Treehouse.Space, :admin, :create_space},
        else: {Treehouse.Thread, :moderator, :create_thread}

    Code.ensure_loaded!(module)

    nonce =
      :crypto.hash(:sha256, "canonical-dependency-alias:#{kind}")
      |> Base.url_encode64(padding: false)

    sim =
      Sim.new(
        module,
        "replica:treehouse:#{kind}:#{nonce}#authority:bounded-continuation-v1",
        ["founder", "nominee", "w1", "w2", "w3"],
        seed: "dependency-alias"
      )

    {sim, genesis} = Sim.create_replica(sim, "founder")
    {sim, _created} = Sim.command(sim, "founder", command, ["Canonical dependency aliases"])
    root = Sim.identity(sim, "founder")
    witnesses = Enum.map(["w1", "w2", "w3"], &Sim.identity(sim, &1)) |> Enum.sort_by(& &1.pub)

    profile = %{
      mode: :bounded_continuation,
      version: 1,
      product: :treehouse,
      kind: kind,
      role: role,
      nominee: Sim.identity(sim, "nominee").pub,
      witnesses: Enum.map(witnesses, & &1.pub),
      threshold: 2,
      max_lease_epochs: 7
    }

    empty = Delegation.genesis(root, sim.replica, ops: [], roles: [], live: false)

    {sim, pin} =
      Sim.append(sim, "founder", :authority, {:genesis, empty, %{__continuation__: profile}})

    {sim, _beacon} = Sim.beacon(sim, "founder", 0)
    heartbeat = Op.new(root, sim.replica, [pin.id], :authority, {:heartbeat, role, 0})
    prior = Sim.log(sim, "founder") |> Log.append!(heartbeat)
    nominee = Sim.identity(sim, "nominee")

    delegation =
      Delegation.new(nominee, sim.replica, nominee.pub,
        ops: [if(kind == :space, do: :create_thread, else: :post)],
        roles: [role],
        live: false,
        expires_epoch: 6
      )

    {:ok, review} =
      Authority.continuation_review(
        module,
        prior,
        role,
        nominee.pub,
        Log.frontier(prior),
        delegation
      )

    cert = ContinuationCertificate.new(review.claim, Enum.take(witnesses, 2))

    op =
      Op.new(
        nominee,
        sim.replica,
        Log.frontier(prior),
        :authority,
        {:succeed, role, delegation, {:continuation_v1, cert}}
      )

    %{
      kind: kind,
      module: module,
      role: role,
      prior: Log.topo_ops(prior),
      op: op,
      nominee: nominee,
      witnesses: witnesses,
      genesis: genesis
    }
  end

  @spec aliases(Op.t()) :: [Op.t()]
  def aliases(op) do
    [a, b] = op.deps
    [op, %{op | deps: [b, a]}, %{op | deps: [a, a, b]}, %{op | deps: [b, a, b, a]}]
  end

  @spec judge(module(), atom(), String.t(), [Op.t()]) :: map()
  def judge(module, role, replica, ops) do
    true = Enum.all?(ops, &Op.valid?/1)
    log = Log.from_ops(replica, Map.new(ops, &{&1.id, &1}))
    :ok = Log.verify_authenticity(log)
    analysis = Authority.analyze(module, log)
    {:ok, cutoff} = CatalogCutoff.derive(log)
    holder = analysis.holder_epochs[role]

    %{
      epoch: holder && holder.op_id,
      holder: holder && Base.encode64(holder.holder),
      reasons: analysis.reasons,
      cutoff: %{
        replica: replica,
        frontier: Enum.sort(cutoff.cutoff.frontier),
        logDigest: cutoff.cutoff.log_digest
      },
      cutoffBytes: Base.encode64(cutoff.canonical_bytes)
    }
  end

  @spec negatives(map()) :: [{Op.t(), atom()}]
  def negatives(f) do
    {:succeed, role, delegation, {:continuation_v1, cert}} = f.op.body
    resigned = Op.new(f.nominee, f.op.replica, [f.genesis.id | f.op.deps], :authority, f.op.body)
    claim = %{cert.claim | deps: List.insert_at(cert.claim.deps, 1, hd(cert.claim.deps))}

    malformed =
      Op.new(
        f.nominee,
        f.op.replica,
        f.op.deps,
        :authority,
        {:succeed, role, delegation,
         {:continuation_v1, ContinuationCertificate.new(claim, Enum.take(f.witnesses, 2))}}
      )

    [{resigned, :invalid_continuation_certificate}, {malformed, :malformed_term}]
  end

  @spec vector(map()) :: map()
  def vector(f) do
    %{
      kind: f.kind,
      replica: f.op.replica,
      prior: Enum.map(f.prior, &Wire.encode_op/1),
      frame: Wire.encode_op(f.op),
      expected: judge(f.module, f.role, f.op.replica, f.prior ++ [f.op]),
      negatives:
        Enum.map(negatives(f), fn {op, reason} -> %{frame: Wire.encode_op(op), reason: reason} end)
    }
  end
end
