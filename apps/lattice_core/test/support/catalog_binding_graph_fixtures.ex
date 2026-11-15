defmodule Treehouse.CatalogBindingGraphFixtures do
  @moduledoc """
  Plan 316 PR 4a fixtures for `Treehouse.CatalogBindingGraph`: a Sim bounded Space with a
  root-honored `catalog_bootstrap_v1`, witnessed-beacon and continuation pin, root beacons, a
  leased `:admin` transfer whose ceiling includes `replace_catalog_v1`, and builders for
  concurrent replacement ops, signed catalogs and rotations. Disposable seeded keys only; a
  Core-honored fixture op is an authorized signed proposal, not a route switch or trust.

  `deliver/3` is the multi-delivery harness: it persists the accepted watermark and blocked
  state between calls (the part `Treehouse.CatalogTrust` will own in 4c), so every
  intermediate call can be asserted.
  """

  alias Lattice.{Authority, Dag, Identity, Log, Op, Sim}
  alias Lattice.Authority.{ContinuationCertificate, Delegation}
  alias Treehouse.{CatalogBindingGraph, CatalogCutoff, Space, TransportCatalog}

  @realms ~w(root admin nominee w1 w2 w3 observer)
  @admin_ops [
    :create_space,
    :create_thread,
    :issue_invitation,
    :revoke_invitation,
    :admit_member,
    :remove_member,
    :replace_catalog_v1
  ]

  def id(label),
    do: :crypto.hash(:sha256, "r316-4a-" <> label) |> Base.url_encode64(padding: false)

  def identity(label), do: Identity.from_seed(label, "r316-4a-" <> label)

  # --- base history -------------------------------------------------------------

  @doc "Genesis, create_space, pin, bootstrap, beacon 0, a leased admin transfer, beacon 1."
  def base(opts \\ []) do
    expires = Keyword.get(opts, :expires, 6)
    seed_replica = "replica:treehouse:space:#{id("space")}#authority:bounded-continuation-v1"
    sim = Sim.new(Space, seed_replica, @realms, seed: "r316-4a")
    {sim, genesis} = Sim.create_replica(sim, "root", ops: ceiling(Sim.identity(sim, "root")))
    {sim, creation} = Sim.command(sim, "root", :create_space, ["Canopy"])
    sim = Sim.sync_all(sim)
    {sim, pin, profile} = pin(sim)
    {:ok, profile_id} = ContinuationCertificate.profile_id(profile)
    replica = Sim.replica(sim)
    root = Sim.identity(sim, "root")
    catalog = identity("bootstrap-catalog")
    service = identity("bootstrap-service")

    record = %{
      version: 1,
      product: :treehouse,
      space: replica,
      space_root: root.pub,
      profile_genesis: pin.id,
      profile_id: profile_id,
      replacement_rule: :bounded_space_admin_v1,
      catalog_key: catalog.pub,
      service_id: id("bootstrap-service-id"),
      service_key: service.pub,
      origin: "wss://base-relay.invalid",
      nonce: id("bootstrap-nonce")
    }

    {sim, bootstrap} = Sim.command(sim, "root", :catalog_bootstrap_v1, [record])
    {sim, beacon0} = Sim.beacon(sim, "root", 0)

    {sim, delegation} =
      Sim.transfer(sim, "root", "admin", :admin, ops: @admin_ops, expires_epoch: expires)

    {sim, beacon1} = Sim.beacon(sim, "root", 1)
    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "observer")

    transfer =
      Enum.find(Log.topo_ops(log), &match?(%Op{body: {:transfer, :admin, %Delegation{}, _}}, &1))

    %{
      sim: sim,
      replica: replica,
      log: log,
      root: root,
      admin: Sim.identity(sim, "admin"),
      nominee: Sim.identity(sim, "nominee"),
      catalog: catalog,
      service: service,
      genesis: genesis,
      creation: creation,
      pin: pin,
      profile: profile,
      record: record,
      bootstrap: bootstrap,
      boot: %{id: bootstrap.id, record: record},
      beacon0: beacon0,
      beacon1: beacon1,
      delegation: delegation,
      transfer: transfer
    }
  end

  defp ceiling(%Identity{} = root) do
    {:ok, %{pending: [%Op{body: {:genesis, %Delegation{ops: ops}, _}}, _]}} =
      Space.prepare_bounded_creation(
        root,
        "replica:treehouse:space:" <> id("ceiling-nonce"),
        "Canopy"
      )

    Enum.sort(ops)
  end

  defp pin(sim) do
    root = Sim.identity(sim, "root")
    empty = Delegation.genesis(root, sim.replica, ops: [], roles: [], live: false)

    policy = %{
      mode: :bounded_continuation,
      version: 1,
      product: :treehouse,
      kind: :space,
      role: :admin,
      nominee: Sim.identity(sim, "nominee").pub,
      witnesses: Enum.sort(Enum.map(~w(w1 w2 w3), &Sim.identity(sim, &1).pub)),
      threshold: 2,
      max_lease_epochs: 7
    }

    beacon = %{
      mode: :witnessed,
      version: 1,
      witnesses: policy.witnesses,
      threshold: 2,
      max_epoch_step: 1
    }

    {sim, op} =
      Sim.append(
        sim,
        "root",
        :authority,
        {:genesis, empty, %{__continuation__: policy, __beacon__: beacon}}
      )

    {Sim.sync_all(sim), op, policy}
  end

  # --- evidence builders --------------------------------------------------------

  @doc "The Space route entry a replacement's first catalog carries."
  def entries(base, name, service_id, service_key) do
    [
      %{
        product: :treehouse,
        replica: base.replica,
        kind: :space,
        schema: :treehouse_space_v1,
        root: base.root.pub,
        genesis: base.genesis.id,
        creation: base.creation.id,
        reference: base.boot.id,
        route: "/r/" <> id("route-" <> name),
        service_id: service_id,
        service_key: service_key
      }
    ]
  end

  @doc "Entries under the bootstrap's own service pair."
  def base_entries(base, name \\ "base"),
    do: entries(base, name, base.record.service_id, base.service.pub)

  @doc "The causal prefix log of a dep set."
  def prefix(base, log, deps) do
    ops = Log.ops(log)
    Log.from_ops(base.replica, Map.take(ops, MapSet.to_list(Dag.reachable(ops, deps))))
  end

  @doc """
  Build one signed `replace_catalog_v1` op (not appended). Options: `:parents`,
  `:prior_catalogs`, `:generation`, `:deps`, `:author` (Identity), `:cap`, `:op_cap`,
  `:holder_epoch`, `:entries`, `:claim` (field overrides), `:bad_possession`, `:service_id`,
  `:service_key` (Identity), `:catalog_key` (Identity).
  """
  def replacement(base, log, name, opts \\ []) do
    deps = Keyword.get(opts, :deps, Log.frontier(log))
    p = prefix(base, log, deps)
    {_analysis, beacons, _records} = Authority.analyze_with_records(Space, p)
    author = Keyword.get(opts, :author, base.admin)
    catalog_key = Keyword.get(opts, :catalog_key, identity("catalog-" <> name))
    service_key = Keyword.get(opts, :service_key, identity("service-" <> name))
    service_id = Keyword.get(opts, :service_id, id("service-id-" <> name))
    entries = Keyword.get(opts, :entries, entries(base, name, service_id, service_key.pub))
    parents = Keyword.get(opts, :parents, [base.boot.id])

    {epoch, basis} =
      case beacons do
        [] ->
          {0, [id("no-beacon")]}

        _ ->
          max = beacons |> Enum.map(& &1.epoch) |> Enum.max()
          {max, Enum.sort(for %{epoch: ^max, op_id: oid} <- beacons, do: oid)}
      end

    {:ok, %{cutoff: cutoff}} = CatalogCutoff.derive(p)
    cap = Keyword.get(opts, :cap, base.delegation.id)

    claim =
      %{
        version: 1,
        product: :treehouse,
        space: base.replica,
        bootstrap: base.boot.id,
        profile_genesis: base.record.profile_genesis,
        profile_id: base.record.profile_id,
        parents: parents,
        prior_catalogs:
          Keyword.get(opts, :prior_catalogs, for(x <- parents, do: %{binding: x, catalog: nil})),
        generation: Keyword.get(opts, :generation, 1),
        nonce: id("nonce-" <> name),
        new_catalog_key: catalog_key.pub,
        new_service_id: service_id,
        new_service_key: service_key.pub,
        new_origin: "wss://" <> name <> "-relay.invalid",
        inventory_digest: TransportCatalog.inventory_id(entries),
        cutoffs: [cutoff],
        author: author.pub,
        cap: cap,
        holder_epoch: Keyword.get(opts, :holder_epoch, base.transfer.id),
        deps: Enum.sort(deps),
        epoch: epoch,
        epoch_basis: basis
      }
      |> Map.merge(Keyword.get(opts, :claim, %{}))

    {cp, sp} =
      if Keyword.get(opts, :bad_possession, false) do
        {<<1::512>>, <<2::512>>}
      else
        {Identity.sign(
           catalog_key,
           TransportCatalog.replacement_possession_bytes(:catalog, claim)
         ),
         Identity.sign(
           service_key,
           TransportCatalog.replacement_possession_bytes(:service, claim)
         )}
      end

    op =
      Op.new(author, base.replica, deps, :command, {:replace_catalog_v1, [claim, cp, sp]},
        cap: Keyword.get(opts, :op_cap, cap)
      )

    %{
      op: op,
      id: op.id,
      claim: claim,
      entries: entries,
      catalog_key: catalog_key,
      service_key: service_key,
      service_id: service_id
    }
  end

  @doc "A signed catalog envelope; `entries` default to the bootstrap service pair."
  def catalog(base, binding, revision, previous, signer, entries) do
    catalog = %{
      version: 1,
      product: :treehouse,
      space: base.replica,
      bootstrap: base.boot.id,
      binding: binding,
      revision: revision,
      previous: previous,
      entries: Enum.sort_by(entries, & &1.replica)
    }

    %{catalog: catalog, signature: Identity.sign(signer, TransportCatalog.catalog_bytes(catalog))}
  end

  def cid(%{catalog: catalog}), do: TransportCatalog.catalog_id(catalog)

  @doc "A signed rotation envelope of `parent` (`%{id, generation}`) over `prior` catalog."
  def rotation(base, parent, prior, old, new, label, opts \\ []) do
    rotation = %{
      version: 1,
      product: :treehouse,
      space: base.replica,
      bootstrap: base.boot.id,
      parent: parent.id,
      prior_catalog: cid(prior),
      generation: Keyword.get(opts, :generation, parent.generation + 1),
      new_catalog_key: new.pub,
      nonce: id("rotation-" <> label),
      inventory_digest: TransportCatalog.inventory_id(prior.catalog.entries),
      cutoffs:
        for entry <- prior.catalog.entries do
          %{replica: entry.replica, frontier: [id("f-" <> label)], log_digest: id("d-" <> label)}
        end
    }

    envelope = %{
      rotation: rotation,
      old_signature: Identity.sign(old, TransportCatalog.rotation_bytes(rotation)),
      new_signature: Identity.sign(new, TransportCatalog.rotation_possession_bytes(rotation))
    }

    %{id: TransportCatalog.rotation_id(envelope), envelope: envelope}
  end

  @doc "The bootstrap's own revision-0 catalog under its own keys."
  def c0(base, name \\ "base"),
    do: catalog(base, base.boot.id, 0, nil, base.catalog, base_entries(base, name))

  @doc "The revision-0 catalog under a replacement (`replacement/4` result)."
  def first(base, r, opts \\ []) do
    entries = Keyword.get(opts, :entries, r.entries)
    catalog(base, r.id, Keyword.get(opts, :revision, 0), nil, r.catalog_key, entries)
  end

  @doc "A root-signed transfer of `:admin` to `audience` (pub) on `deps`."
  def transfer(base, deps, audience, opts \\ []) do
    issuer = Keyword.get(opts, :issuer, base.root)

    d =
      Delegation.new(issuer, base.replica, audience,
        ops: Keyword.get(opts, :ops, @admin_ops),
        roles: [:admin],
        parent_id: Keyword.get(opts, :parent_id, genesis_delegation(base).id),
        expires_epoch: Keyword.get(opts, :expires, 6)
      )

    %{op: op(issuer, base, deps, :authority, {:transfer, :admin, d, 0}), delegation: d}
  end

  def genesis_delegation(base), do: elem(base.genesis.body, 1)

  def revoke(base, deps, delegation_id),
    do: op(base.root, base, deps, :authority, {:revoke, delegation_id})

  def beacon(base, deps, epoch), do: op(base.root, base, deps, :authority, {:beacon, epoch})

  def admin_ops, do: @admin_ops

  @doc "A plain Space op on `deps` (a concurrent marker op, a revoke, a beacon, ...)."
  def op(identity, base, deps, kind, body, opts \\ []),
    do: Op.new(identity, base.replica, deps, kind, body, opts)

  @doc "Append ops to a log in the given order."
  def append(log, ops), do: Enum.reduce(ops, log, &Log.append!(&2, &1))

  # --- multi-delivery harness ---------------------------------------------------

  @empty %{accepted: nil, blocked: nil}
  def empty_state, do: @empty

  @doc """
  One delivery. `evidence` is the full retained set `%{space: Log, rotations: %{}, catalogs:
  %{}, proven: []}`; `state` is the persisted `%{accepted, blocked}`. Returns the resolver
  result and the state the caller would persist: the watermark advances on an accepted
  decision, the block is cleared only when the graph reports `clears_authority_changed`, set
  from `decision.block`, and otherwise kept (4c's `merge_security_block` owns that stickiness).
  """
  def deliver(base, state, evidence) do
    input = %{
      bootstrap: base.boot,
      space: evidence.space,
      rotations: Map.get(evidence, :rotations, %{}),
      catalogs: Map.get(evidence, :catalogs, %{}),
      proven_cutoffs: Map.get(evidence, :proven, []),
      accepted: state.accepted,
      blocked: state.blocked
    }

    result = CatalogBindingGraph.resolve(input)
    {result, persist(state, result)}
  end

  defp persist(state, {:ok, %{decision: d}}) do
    accepted =
      if d.accepted,
        do: %{binding: d.head, generation: d.generation, catalog: d.catalog, revision: d.revision},
        else: state.accepted

    blocked =
      cond do
        d.clears_authority_changed -> nil
        d.block -> d.block
        true -> state.blocked
      end

    %{accepted: accepted, blocked: blocked}
  end

  defp persist(state, _error), do: state

  @doc "Plain, sorted, JSON-friendly view of a result; the shape both runtimes compare."
  def view({:error, reason, %{ids: ids}}),
    do: %{"error" => to_string(reason), "ids" => Enum.sort(ids)}

  def view({:ok, g}) do
    d = g.decision

    %{
      "heads" => g.heads,
      "closed" => g.closed,
      "closed_out" => stringify(g.closed_out),
      "nodes" =>
        Map.new(g.nodes, fn {id, n} ->
          {id,
           %{
             "kind" => to_string(n.kind),
             "generation" => n.generation,
             "refused" => n.refused?,
             "core_reason" => n.core_reason && to_string(n.core_reason),
             "pending" => length(n.pending)
           }}
        end),
      "raw_evidence" => stringify(g.raw_evidence),
      "refusals" => Map.new(g.refusals, fn {id, r} -> {id, to_string(r.reason)} end),
      "catalog_heads" => g.catalog_heads,
      "forks" => Enum.map(g.forks, &Map.new(&1, fn {k, v} -> {to_string(k), jsonish(v)} end)),
      "decision" => %{
        "accepted" => d.accepted,
        "reason" => d.reason && to_string(d.reason),
        "block" =>
          d.block && %{"reason" => to_string(d.block.reason), "triggers" => d.block.triggers},
        "head" => d.head,
        "catalog" => d.catalog,
        "clears" => d.clears_authority_changed,
        "binding_status" => to_string(d.accepted_binding_status),
        "catalog_status" => to_string(d.accepted_catalog_status)
      }
    }
  end

  defp jsonish(v) when is_atom(v) and not is_nil(v) and not is_boolean(v), do: to_string(v)
  defp jsonish(v), do: v

  defp stringify(map), do: Map.new(map, fn {k, v} -> {k, to_string(v)} end)
end
