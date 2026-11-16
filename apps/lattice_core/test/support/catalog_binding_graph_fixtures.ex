defmodule Treehouse.CatalogBindingGraphFixtures do
  @moduledoc """
  Plan 316 PR 4a fixtures for `Treehouse.CatalogBindingGraph`: a Sim bounded Space with a
  root-honored `catalog_bootstrap_v1`, witnessed-beacon and continuation pin, root beacons, a
  leased `:admin` transfer whose ceiling includes `replace_catalog_v1`, and builders for
  concurrent replacement ops, signed catalogs and rotations. Disposable seeded keys only; a
  Core-honored fixture op is an authorized signed proposal, not a route switch or trust.

  `deliver/3` is the multi-delivery harness: it persists the accepted watermark (with its
  cumulative routes) and the `frozen` bit between calls through `CatalogBindingGraph.advance/2`
  (the part `Treehouse.CatalogTrust` will own in 4c), so every intermediate call can be
  asserted.
  """

  alias Lattice.{Authority, Dag, Identity, Log, Op, Sim}
  alias Lattice.Authority.{ContinuationCertificate, Delegation}
  alias Treehouse.{CatalogBindingGraph, CatalogCutoff, Space, TransportCatalog}

  @realms ~w(root admin nominee w1 w2 w3 observer)
  @thread_pool ~w(thread thread2 squat new s17a s17b s17b-t gen0 gen1)
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

    # Row 390: real bounded Threads the scenarios and the generator list (entry facts are judged
    # against their histories), each with a root `create_thread` reference in the Space.
    {sim, threads} =
      Enum.reduce(@thread_pool, {sim, %{}}, fn name, {sim, acc} ->
        t = thread_log(name)
        {sim, ref} = Sim.command(sim, "root", :create_thread, [t.replica, "Thread " <> name])
        {sim, Map.put(acc, name, Map.put(t, :reference, ref))}
      end)

    beacons? = Keyword.get(opts, :beacons, true)
    {sim, beacon0} = if beacons?, do: Sim.beacon(sim, "root", 0), else: {sim, nil}

    {sim, delegation} =
      if Keyword.get(opts, :transfer, true) do
        Sim.transfer(sim, "root", "admin", :admin,
          ops: Keyword.get(opts, :ops, @admin_ops),
          expires_epoch: expires
        )
      else
        {sim, nil}
      end

    {sim, beacon1} = if beacons?, do: Sim.beacon(sim, "root", 1), else: {sim, nil}
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
      threads: threads,
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

  @doc """
  A real bounded Thread (row 390: entry facts are judged against history): its own genesis and
  two `create_thread` creations (so two history-valid creation facts exist), and the root's
  Space `create_thread` reference op on `deps` (not appended).
  """
  def thread(base, name, deps) do
    t = thread_log(name)

    reference =
      op(base.root, base, deps, :command, {:create_thread, [t.replica, "Thread " <> name]},
        cap: genesis_delegation(base).id
      )

    Map.put(t, :reference, reference)
  end

  defp thread_log(name) do
    root = identity("thread-root-" <> name)

    replica =
      Authority.bind_replica(
        "replica:treehouse:thread:" <>
          id("thread-" <> name) <> "#authority:bounded-continuation-v1",
        root.pub
      )

    d =
      Delegation.genesis(root, replica,
        ops: [:create_thread, :post, :archive_thread],
        roles: [:moderator]
      )

    genesis = Op.new(root, replica, [], :authority, {:genesis, d, %{}})

    creations =
      for i <- 0..1 do
        Op.new(root, replica, [genesis.id], :command, {:create_thread, ["Thread #{name} #{i}"]},
          cap: d.id
        )
      end

    %{
      name: name,
      root: root,
      replica: replica,
      genesis: genesis,
      creation: hd(creations),
      creations: creations,
      log: append(Log.new(replica), [genesis | creations])
    }
  end

  @doc """
  A Thread entry with the facts of the base pool Thread `name` (its replica, root, genesis,
  first creation and Space reference), keeping `entry`'s route and service pair.
  """
  def pool_thread(base, entry, name, opts \\ []) do
    t = Map.fetch!(base.threads, name)

    %{
      entry
      | replica: t.replica,
        kind: :thread,
        schema: :treehouse_thread_v1,
        root: t.root.pub,
        genesis: t.genesis.id,
        creation: Enum.at(t.creations, Keyword.get(opts, :creation, 0)).id,
        reference: t.reference.id
    }
  end

  @doc "Every pool Thread history, in the `replica => %Log{}` shape the resolver takes."
  def histories(base), do: Map.new(base.threads, fn {_name, t} -> {t.replica, t.log} end)

  @doc "The catalog entry of a `thread/4` Thread under a service pair and route."
  def thread_entry(thread, service_id, service_key, route, opts \\ []) do
    %{
      product: :treehouse,
      replica: thread.replica,
      kind: :thread,
      schema: :treehouse_thread_v1,
      root: thread.root.pub,
      genesis: thread.genesis.id,
      creation: Keyword.get(opts, :creation, thread.creation).id,
      reference: Keyword.get(opts, :reference, thread.reference).id,
      route: route,
      service_id: service_id,
      service_key: service_key
    }
  end

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

    entries =
      opts
      |> Keyword.get(:entries, entries(base, name, service_id, service_key.pub))
      |> Enum.sort_by(& &1.replica)

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
    cap = Keyword.get_lazy(opts, :cap, fn -> base.delegation.id end)

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
        holder_epoch: Keyword.get_lazy(opts, :holder_epoch, fn -> base.transfer.id end),
        deps: Enum.sort(deps),
        epoch: epoch,
        epoch_basis: basis
      }
      |> Map.merge(Keyword.get(opts, :claim, %{}))

    bad = Keyword.get(opts, :bad_possession, false)

    cp =
      if bad in [true, :catalog],
        do: <<1::512>>,
        else:
          Identity.sign(
            catalog_key,
            TransportCatalog.replacement_possession_bytes(:catalog, claim)
          )

    sp =
      if bad in [true, :service],
        do: <<2::512>>,
        else:
          Identity.sign(
            service_key,
            TransportCatalog.replacement_possession_bytes(:service, claim)
          )

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
        live: Keyword.get(opts, :live, false),
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

  @empty %{accepted: nil, frozen: false}
  def empty_state, do: @empty

  @doc """
  One delivery. `evidence` is the full retained set `%{space: Log, rotations: %{}, catalogs:
  %{}, proven: []}`; `state` is the persisted `%{accepted, frozen}` (the accepted watermark
  carries its cumulative `routes`). Returns the resolver result and
  `CatalogBindingGraph.advance/2` of it: `%{accepted, frozen, serving}`, the state the caller
  would persist plus the routes it would serve (the merge 4c's CatalogTrust will own).
  """
  def deliver(base, state, evidence) do
    input = %{
      bootstrap: base.boot,
      space: evidence.space,
      rotations: Map.get(evidence, :rotations, %{}),
      catalogs: Map.get(evidence, :catalogs, %{}),
      proven_cutoffs: Map.get(evidence, :proven, []),
      accepted: state.accepted,
      histories: Map.get(evidence, :histories, histories(base))
    }

    result = CatalogBindingGraph.resolve(input)
    {result, CatalogBindingGraph.advance(state, result)}
  end

  @doc "The persisted part of `advance/2`'s result."
  def persisted(next), do: Map.take(next, [:accepted, :frozen])

  @doc "Plain, sorted, JSON-friendly view of a result; the shape both runtimes compare."
  def view(result, next), do: Map.put(view(result), "after", after_json(next))

  def view({:error, :trust_pending, %{ids: ids, freeze: freeze, serving: serving}}),
    do: %{
      "error" => "trust_pending",
      "ids" => Enum.sort(ids),
      "freeze" => freeze,
      "serving" => serving
    }

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
          d.block &&
            %{
              "reason" => to_string(d.block.reason),
              "ids" => d.block.ids,
              "freeze" => d.block.freeze
            },
        "head" => d.head,
        "catalog" => d.catalog,
        "clears" => d.clears_authority_changed,
        "serving" => d.serving,
        "binding_status" => to_string(d.accepted_binding_status),
        "catalog_status" => to_string(d.accepted_catalog_status)
      }
    }
  end

  @doc "JSON view of a persisted state (accepted watermark with routes, frozen)."
  def state_json(%{accepted: a, frozen: frozen}) do
    %{
      "accepted" =>
        a &&
          %{
            "binding" => a.binding,
            "generation" => a.generation,
            "catalog" => a.catalog,
            "revision" => a.revision,
            "routes" => Map.get(a, :routes, %{})
          },
      "frozen" => frozen
    }
  end

  defp after_json(next),
    do:
      next
      |> persisted()
      |> state_json()
      |> Map.put("serving", next.serving)

  defp jsonish(v) when is_atom(v) and not is_nil(v) and not is_boolean(v), do: to_string(v)
  defp jsonish(v), do: v

  defp stringify(map), do: Map.new(map, fn {k, v} -> {k, to_string(v)} end)
end
