defmodule Treehouse.CatalogResolutionWorld do
  @moduledoc """
  PR #221 evidence: the generator interpreter for `Treehouse.CatalogResolutionModel`. It turns
  a generated action script into signed artifacts over `CatalogBindingGraphFixtures.base/1`
  (disposable seeded keys only): honest admin replacements (a fresh finite root acquisition,
  then a resolution citing every current head through the public authoring coverage check),
  authority events (revoke, transfer, beacon; lease lapse follows from beacons; each may be
  concurrent by taking an older frontier as deps), a malicious-content admin replacement, and
  an adversary holding every old catalog key (the bootstrap's, every replacement's and its own
  rotations') who signs sibling catalogs differing in route, revision or any immutable entry
  field, adds Threads with varying facts, rotates bindings and withholds priors.

  Every artifact is recorded with its bytes-level facts (`bindings`, `catalogs`) for the model.
  `run/3` delivers the non-withheld items one at a time in a generated order, persisting
  `%{accepted, frozen}` through the public `CatalogBindingGraph.advance/2`, and `resolve_final/2`
  is the liveness search.
  """

  alias Lattice.{Dag, Log}
  alias Treehouse.{CatalogBindingGraph, CatalogCutoff, CatalogReplacementAuthority}
  alias Treehouse.CatalogBindingGraphFixtures, as: F

  @ext ~w(root genesis creation reference kind schema)a
  @max_combos 48
  @max_entry_choices 8

  # --- world ------------------------------------------------------------------------

  def new(base) do
    c0 = F.c0(base)
    c0_id = F.cid(c0)

    %{
      base: base,
      base_ops: Log.ops(base.log),
      ops: %{},
      frontiers: [Enum.sort(Log.frontier(base.log))],
      bindings: %{
        base.boot.id => %{
          kind: :bootstrap,
          label: "B",
          parents: [],
          generation: 0,
          key: base.catalog,
          service: {base.record.service_id, base.service.pub},
          cutoffs: [],
          honest: true,
          prior_catalogs: [],
          prior_catalog: nil,
          order: 0
        }
      },
      catalogs: %{
        c0_id => %{
          env: c0,
          binding: base.boot.id,
          revision: 0,
          previous: nil,
          label: "c0",
          adversary: false,
          withheld: false
        }
      },
      c0: c0_id,
      holders: %{
        base.admin.pub => %{
          name: "admin",
          identity: base.admin,
          delegation_id: base.delegation.id,
          expires: base.delegation.expires_epoch
        }
      },
      items: [],
      script: [],
      n: 0
    }
  end

  defp tick(w), do: {w.n + 1, %{w | n: w.n + 1}}

  def all_ops(w), do: Map.merge(w.base_ops, w.ops)
  def log(w), do: Log.from_ops(w.base.replica, all_ops(w))

  defp frontier(w, k), do: Enum.at(w.frontiers, min(k, length(w.frontiers) - 1))

  defp add_op(w, op, label, opts \\ []) do
    w = %{w | ops: Map.put(w.ops, op.id, op)}
    w = %{w | frontiers: [Enum.sort(Log.frontier(log(w))) | w.frontiers]}

    if Keyword.get(opts, :item, true),
      do: add_item(w, %{kind: :space, label: label, id: op.id, op: op, adversary: false}),
      else: w
  end

  defp add_item(w, item), do: %{w | items: w.items ++ [item]}
  defp note(w, line), do: %{w | script: w.script ++ [line]}

  defp epoch(w, deps) do
    ops = all_ops(w)

    Dag.reachable(ops, deps)
    |> Enum.flat_map(fn id ->
      case ops[id].body do
        {:beacon, e} -> [e]
        _ -> []
      end
    end)
    |> Enum.max(fn -> 0 end)
  end

  def bindings_in_order(w),
    do: w.bindings |> Enum.sort_by(fn {_id, b} -> b.order end) |> Enum.map(&elem(&1, 0))

  defp catalogs_under(w, x),
    do:
      w.catalogs
      |> Enum.filter(fn {_id, k} -> k.binding == x end)
      |> Enum.sort_by(fn {_id, k} -> k.label end)
      |> Enum.map(&elem(&1, 0))

  # --- actions -------------------------------------------------------------------------

  def apply_script(base, actions), do: Enum.reduce(actions, new(base), &act(&2, &1))

  def act(w, {:beacon, k}) do
    deps = frontier(w, k)
    e = epoch(w, deps) + 1
    {n, w} = tick(w)
    op = F.beacon(w.base, deps, e)
    w |> add_op(op, "E#{e}.#{n}") |> note("beacon #{e} on frontier -#{k} (E#{e}.#{n})")
  end

  def act(w, {:revoke, k}) do
    deps = frontier(w, k)

    case holder_at(w, deps) do
      nil ->
        note(w, "revoke skipped (no known holder on frontier -#{k})")

      h ->
        {n, w} = tick(w)
        op = F.revoke(w.base, deps, h.delegation_id)

        w
        |> add_op(op, "V#{n}")
        |> note("root revokes #{h.name}'s delegation on frontier -#{k} (V#{n})")
    end
  end

  def act(w, {:transfer, k, lease}) do
    {n, w} = tick(w)

    case transfer_from_holder(w, frontier(w, k), "holder-#{n}", lease) do
      {:ok, w, t} ->
        note(
          w,
          "#{t.from} transfers :admin to holder-#{n} (lease +#{lease}) on frontier -#{k} (T#{n})"
        )

      :none ->
        note(w, "transfer skipped (no known holder on frontier -#{k})")
    end
  end

  def act(w, {:replace, lease}) do
    {n, w} = tick(w)
    label = "R#{n}"

    case acquire(w, "admin-#{n}", lease) do
      {:ok, w, admin} ->
        case author(w, admin, label, held(w)) do
          {:ok, cand} ->
            w
            |> register_replacement(cand, label, true)
            |> note("honest admin authors #{label} citing #{cite_text(w, cand.r.claim)}")

          {:error, class, _} ->
            note(w, "honest admin could not author #{label} (#{class})")
        end

      {:dead, w, why} ->
        note(w, "no living admin for #{label} (#{inspect(why)})")
    end
  end

  def act(w, {:sloppy, lease, mode}) do
    {n, w} = tick(w)
    label = "S#{n}"

    case acquire(w, "sloppy-#{n}", lease) do
      {:ok, w, admin} -> sloppy(w, admin, label, mode, n)
      {:dead, w, why} -> note(w, "no living admin for #{label} (#{inspect(why)})")
    end
  end

  def act(w, {:adv_catalog, b, c, mutation, mode, withhold}) do
    ids = bindings_in_order(w)
    x = Enum.at(ids, rem(b, length(ids)))
    under = catalogs_under(w, x)
    {n, w} = tick(w)
    label = "a#{n}"

    {revision, previous, entries} =
      case under do
        [] ->
          {0, nil, template(w, x)}

        _ ->
          base_id = Enum.at(under, rem(c, length(under)))
          k = w.catalogs[base_id]

          case mode do
            :next -> {k.revision + 1, base_id, k.env.catalog.entries}
            :gap -> {k.revision + 2, base_id, k.env.catalog.entries}
            :zero -> {0, nil, k.env.catalog.entries}
          end
      end

    entries = entries |> retarget(w, x) |> mutate(w, mutation, n)

    # The catalog codec itself refuses some shapes (no Space entry, a Space entry whose
    # reference is not the bootstrap); such bytes cannot be signed through it, so the adversary
    # cannot deliver them as a well-formed artifact.
    env =
      try do
        F.catalog(w.base, x, revision, previous, w.bindings[x].key, entries)
      rescue
        ArgumentError -> nil
      end

    cid = env && F.cid(env)

    cond do
      env == nil ->
        note(w, "adversary catalog #{label} #{inspect(mutation)} is unencodable (skipped)")

      Map.has_key?(w.catalogs, cid) ->
        note(w, "adversary catalog #{label} duplicates an existing catalog")

      true ->
        adv_catalog(w, x, cid, env, {label, revision, previous, mutation, withhold})
    end
  end

  def act(w, {:adv_rotation, b, c, withhold_prior, gen_ok, proofs}),
    do: adv_rotation(w, b, c, withhold_prior, gen_ok, proofs)

  # Row 594: an honest-key rotation. The key holder of a current honest head (the `k`-th honest
  # one in the resolver's own head list: the bootstrap, an honest replacement or an earlier
  # honest rotation) rotates it over that head's own catalog while that catalog is a held tip,
  # with the next generation and its cutoff proofs delivered, then signs a revision-0 catalog
  # under the new key carrying the prior's entries. Nothing is withheld. With no such head or
  # tip (an adversary revision extends it) the step is skipped.
  def act(w, {:rotate, k}) do
    view = held(w)
    {heads, _} = heads(w, view)
    honest = for h <- Enum.sort(heads), match?(%{honest: true}, w.bindings[h]), do: h

    with [_ | _] <- honest,
         x = Enum.at(honest, rem(k, length(honest))),
         [prior | _] <-
           for(c <- tips(w, view, x, []), not w.catalogs[c].adversary, do: c) do
      honest_rotation(w, x, w.catalogs[prior].env)
    else
      _ -> note(w, "honest rotation skipped (no honest head with its own catalog as a tip)")
    end
  end

  defp adv_catalog(w, x, cid, env, {label, revision, previous, mutation, withhold}) do
    w = %{
      w
      | catalogs:
          Map.put(w.catalogs, cid, %{
            env: env,
            binding: x,
            revision: revision,
            previous: previous,
            label: label,
            adversary: true,
            withheld: withhold
          })
    }

    w =
      if withhold,
        do: w,
        else: add_item(w, %{kind: :catalog, label: label, id: cid, env: env, adversary: true})

    note(
      w,
      "adversary signs #{label} under #{w.bindings[x].label} rev #{revision} " <>
        "prev #{prev_label(w, previous)} #{inspect(mutation)}#{if withhold, do: " (withheld)", else: ""}"
    )
  end

  defp adv_rotation(w, b, c, withhold_prior, gen_ok, proofs) do
    ids = bindings_in_order(w)
    x = Enum.at(ids, rem(b, length(ids)))
    {n, w} = tick(w)
    label = "t#{n}"
    under = catalogs_under(w, x)

    {w, prior} =
      if under == [] or withhold_prior do
        # A fresh revision the adversary signs and never publishes (a withheld prior).
        {rev, prev, entries} =
          case under do
            [] ->
              {0, nil, template(w, x)}

            _ ->
              k = w.catalogs[Enum.at(under, rem(c, length(under)))]
              {k.revision + 1, F.cid(k.env), k.env.catalog.entries}
          end

        env = F.catalog(w.base, x, rev, prev, w.bindings[x].key, retarget(entries, w, x))

        k = %{
          env: env,
          binding: x,
          revision: rev,
          previous: prev,
          label: label <> "-prior",
          adversary: true,
          withheld: true
        }

        {%{w | catalogs: Map.put_new(w.catalogs, F.cid(env), k)}, env}
      else
        {w, w.catalogs[Enum.at(under, rem(c, length(under)))].env}
      end

    parent = w.bindings[x]
    key = F.identity("adv-key-#{n}")
    generation = if gen_ok, do: parent.generation + 1, else: parent.generation + 2

    rot =
      F.rotation(w.base, %{id: x, generation: parent.generation}, prior, parent.key, key, label,
        generation: generation
      )

    cutoffs = rot.envelope.rotation.cutoffs

    w = %{
      w
      | bindings:
          Map.put(w.bindings, rot.id, %{
            kind: :rotation,
            label: label,
            parents: [x],
            generation: generation,
            key: key,
            service: parent.service,
            cutoffs: cutoffs,
            honest: false,
            prior_catalogs: [],
            prior_catalog: F.cid(prior),
            order: map_size(w.bindings)
          })
    }

    w =
      add_item(w, %{kind: :rotation, label: label, id: rot.id, env: rot.envelope, adversary: true})

    w =
      if proofs,
        do:
          add_item(w, %{
            kind: :proof,
            label: label <> "-proofs",
            cutoffs: cutoffs,
            adversary: true
          }),
        else: w

    note(
      w,
      "adversary rotates #{parent.label} to #{label} over #{prev_label(w, F.cid(prior))}" <>
        "#{if gen_ok, do: "", else: " (generation skips)"}#{if proofs, do: "", else: " (no proofs)"}"
    )
  end

  defp honest_rotation(w, x, prior) do
    {n, w} = tick(w)
    label = "h#{n}"
    parent = w.bindings[x]
    key = F.identity("honest-key-#{n}")

    rot =
      F.rotation(w.base, %{id: x, generation: parent.generation}, prior, parent.key, key, label)

    cutoffs = rot.envelope.rotation.cutoffs

    w = %{
      w
      | bindings:
          Map.put(w.bindings, rot.id, %{
            kind: :rotation,
            label: label,
            parents: [x],
            generation: parent.generation + 1,
            key: key,
            service: parent.service,
            cutoffs: cutoffs,
            honest: true,
            prior_catalogs: [],
            prior_catalog: F.cid(prior),
            order: map_size(w.bindings)
          })
    }

    env = F.catalog(w.base, rot.id, 0, nil, key, retarget(prior.catalog.entries, w, rot.id))
    cid = F.cid(env)
    klabel = "k#{n}"

    w = %{
      w
      | catalogs:
          Map.put(w.catalogs, cid, %{
            env: env,
            binding: rot.id,
            revision: 0,
            previous: nil,
            label: klabel,
            adversary: false,
            withheld: false
          })
    }

    w
    |> add_item(%{kind: :rotation, label: label, id: rot.id, env: rot.envelope, adversary: false})
    |> add_item(%{kind: :proof, label: label <> "-proofs", cutoffs: cutoffs, adversary: false})
    |> add_item(%{kind: :catalog, label: "K-" <> label, id: cid, env: env, adversary: false})
    |> note(
      "key holder rotates #{parent.label} to #{label} over #{prev_label(w, F.cid(prior))} " <>
        "and signs #{klabel} under it"
    )
  end

  defp sloppy(w, admin, label, mode, n) do
    view = held(w)
    {heads, _} = heads(w, view)
    priors = for h <- heads, c <- tips(w, view, h, [nil]), do: %{binding: h, catalog: c}
    # One fact set per replica (a catalog lists each replica once).
    floor = w |> floor_entries(priors) |> Enum.uniq_by(& &1.replica) |> Enum.sort_by(& &1.replica)

    entries =
      case mode do
        :first_only -> floor_entries(w, Enum.take(Enum.reject(priors, &is_nil(&1.catalog)), 1))
        :drop_last -> Enum.drop(floor, -1)
        :alter -> alter_last(floor, n)
      end
      |> Enum.uniq_by(& &1.replica)
      |> Enum.sort_by(& &1.replica)

    if entries == [] or entries == floor do
      note(w, "admin sloppy #{label} skipped (#{mode} changes nothing)")
    else
      cand = build(w, admin, label, view, Enum.sort(heads), priors, entries)

      w
      |> register_replacement(cand, label, false)
      |> note(
        "admin signs #{label} (#{mode}) citing #{cite_text(w, cand.r.claim)} without the preflight"
      )
    end
  end

  # The adversary's entry template under binding `x`: the newest catalog of its lineage.
  defp template(w, x) do
    case w.bindings[x] do
      # Under a rotation, the entries its inventory commits to: its prior catalog's.
      %{kind: :rotation, prior_catalog: p} when is_map_key(w.catalogs, p) ->
        w.catalogs[p].env.catalog.entries

      _ ->
        lineage_template(w, x)
    end
  end

  defp lineage_template(w, x) do
    lineage = Treehouse.CatalogResolutionModel.ancestry(w, x)

    w.catalogs
    |> Enum.filter(fn {_id, k} -> MapSet.member?(lineage, k.binding) end)
    |> Enum.max_by(fn {_id, k} -> {k.revision, k.label} end, fn -> {nil, w.catalogs[w.c0]} end)
    |> elem(1)
    |> Map.fetch!(:env)
    |> Map.fetch!(:catalog)
    |> Map.fetch!(:entries)
  end

  defp retarget(entries, w, x) do
    {sid, skey} = w.bindings[x].service
    for e <- entries, do: %{e | service_id: sid, service_key: skey}
  end

  defp mutate(entries, _w, :same, _n), do: entries

  defp mutate(entries, _w, {:route, i}, n) do
    List.update_at(
      entries,
      rem(i, length(entries)),
      &%{&1 | route: "/r/" <> F.id("adv-route-#{n}")}
    )
  end

  # A real pool Thread (row 390: entry facts are judged against its history). Variant 0 and 1
  # are its two history-valid creations (siblings that both agree with history yet disagree);
  # variant 2 names a creation no history holds (pending forever).
  defp mutate(entries, w, {:thread, t, v}, n) do
    space = Enum.find(entries, &(&1.kind == :space)) || hd(entries)
    route = "/r/" <> F.id("adv-thread-route-#{n}")
    facts = F.pool_thread(w.base, %{space | route: route}, "gen#{t}", creation: min(v, 1))
    facts = if v == 2, do: %{facts | creation: F.id("thread-#{t}-creation-v#{v}")}, else: facts

    case Enum.find_index(entries, &(&1.replica == facts.replica)) do
      nil -> [facts | entries]
      i -> List.update_at(entries, i, &%{facts | route: &1.route})
    end
  end

  defp mutate(entries, _w, {:ext, i, key_index, v}, _n) do
    key = Enum.at(@ext, rem(key_index, length(@ext)))
    List.update_at(entries, rem(i, length(entries)), &variant(&1, key, v))
  end

  defp mutate(entries, _w, {:drop, i}, _n) do
    if length(entries) > 1, do: List.delete_at(entries, rem(i, length(entries))), else: entries
  end

  defp variant(e, :root, v), do: %{e | root: F.identity("ext-root-v#{v}").pub}

  defp variant(e, key, _v) when key in [:kind, :schema] do
    if e.kind == :space,
      do: %{e | kind: :thread, schema: :treehouse_thread_v1},
      else: %{e | kind: :space, schema: :treehouse_space_v1}
  end

  defp variant(e, key, v), do: Map.put(e, key, F.id("ext-#{key}-v#{v}"))

  defp alter_last(entries, n) do
    case entries do
      [] -> []
      _ -> List.update_at(entries, -1, &%{&1 | creation: F.id("sloppy-creation-#{n}")})
    end
  end

  # --- the honest admin ------------------------------------------------------------------

  @doc """
  A fresh finite acquisition for a new honest admin: the current `:admin` holder on the whole
  frontier transfers to it (Core: only the holder transfers). `{:dead, w, why}` when no living
  holder can (revoked, lapsed or unknown): the contract then offers only R04 continuation, which
  this generator does not model, so liveness is not owed for that history.
  """
  def acquire(w, name, lease) do
    deps = frontier(w, 0)

    case transfer_from_holder(w, deps, name, lease) do
      :none ->
        {:dead, w, :no_holder}

      {:ok, w2, t} ->
        analysis = Lattice.Authority.analyze(Treehouse.Space, log(w2))
        epoch = epoch(w2, frontier(w2, 0))

        cond do
          MapSet.member?(analysis.quarantine, t.op.id) ->
            {:dead, w, {:transfer_refused, analysis.reasons[t.op.id]}}

          analysis.holder_epochs[:admin] != %{holder: t.identity.pub, op_id: t.op.id} ->
            {:dead, w, :not_holder}

          t.expires <= epoch ->
            {:dead, w, :lapsed}

          true ->
            {:ok, w2, %{identity: t.identity, delegation: t.delegation, transfer: t.op}}
        end
    end
  end

  # The `:admin` holder Core reports at `deps`, if it is an identity this world controls.
  defp holder_at(w, deps) do
    ops = all_ops(w)
    prefix = Log.from_ops(w.base.replica, Map.take(ops, MapSet.to_list(Dag.reachable(ops, deps))))
    pub = Lattice.Authority.analyze(Treehouse.Space, prefix).holders[:admin]
    Map.get(w.holders, pub)
  end

  defp transfer_from_holder(w, deps, name, lease) do
    case holder_at(w, deps) do
      nil ->
        :none

      h ->
        to = F.identity(name)
        expires = min(h.expires, epoch(w, deps) + lease)

        t =
          F.transfer(w.base, deps, to.pub,
            issuer: h.identity,
            parent_id: h.delegation_id,
            expires: expires
          )

        w = %{
          w
          | holders:
              Map.put(w.holders, to.pub, %{
                name: name,
                identity: to,
                delegation_id: t.delegation.id,
                expires: expires
              })
        }

        w = add_op(w, t.op, "T-" <> name)

        {:ok, w,
         %{op: t.op, delegation: t.delegation, identity: to, expires: expires, from: h.name}}
    end
  end

  @doc "Everything created and not withheld, as one resolver input."
  def held(w), do: evidence(w, w.items, all_ops(w))

  def evidence(w, items, ops) do
    %{
      space: Log.from_ops(w.base.replica, ops),
      ops: ops,
      rotations: for(%{kind: :rotation, id: id, env: env} <- items, into: %{}, do: {id, env}),
      catalogs:
        Map.merge(
          %{w.c0 => w.catalogs[w.c0].env},
          for(%{kind: :catalog, id: id, env: env} <- items, into: %{}, do: {id, env})
        ),
      proven: items |> Enum.flat_map(&Map.get(&1, :cutoffs, [])) |> Enum.uniq()
    }
  end

  def input(w, ev, accepted) do
    %{
      bootstrap: w.base.boot,
      space: ev.space,
      rotations: ev.rotations,
      catalogs: ev.catalogs,
      proven_cutoffs: ev.proven,
      accepted: accepted,
      histories: F.histories(w.base)
    }
  end

  # Current heads as the honest admin's tooling reports them (the resolver's own head list,
  # after dropping reported pending ids; a head-limit refusal reports its heads).
  def heads(w, ev, tries \\ 6) do
    case CatalogBindingGraph.resolve(input(w, ev, nil)) do
      {:ok, g} ->
        {CatalogBindingGraph.heads(g), ev}

      {:error, :control_history_limit, %{ids: ids}} ->
        {ids, ev}

      {:error, :trust_pending, %{ids: ids}} when tries > 0 ->
        heads(w, drop(ev, ids), tries - 1)

      _ ->
        {[w.base.boot.id], ev}
    end
  end

  defp drop(ev, ids) do
    ops = Map.drop(ev.ops, ids)

    %{
      ev
      | ops: ops,
        space: Log.from_ops(ev.space.replica, ops),
        rotations: Map.drop(ev.rotations, ids),
        catalogs: Map.drop(ev.catalogs, ids)
    }
  end

  # Held catalogs under `h` whose id is no held catalog's `previous` under `h` (bytes).
  defp tips(w, ev, h, none) do
    under = for {cid, env} <- ev.catalogs, env.catalog.binding == h, do: cid
    prevs = MapSet.new(for cid <- under, do: ev.catalogs[cid].catalog.previous)
    tips = Enum.reject(under, &MapSet.member?(prevs, &1))
    _ = w
    if tips == [], do: none, else: Enum.sort(tips)
  end

  defp held_under(ev, h),
    do: Enum.sort(for {cid, env} <- ev.catalogs, env.catalog.binding == h, do: cid)

  @doc """
  The honest authoring search: every current head as a parent, every nonempty subset of the
  retained catalogs under each (tips first), and for each replica every fact set the cited
  priors carry, with fresh routes and the new service pair. Each candidate is built and signed
  as the admin would and checked through `resolve_for_claim/2` plus `cover_claim/3`.
  Returns the candidates passing the public preflight (lazily) and the count tried.
  """
  def candidates(w, admin, label, ev) do
    {heads, _view} = heads(w, ev)
    heads = Enum.sort(heads)

    # Row 388 question 2 reading: also try citing, as extra parents, every non-head binding that
    # holds a retained catalog, so a red L is not an artifact of a narrower parent choice.
    extras =
      for id <- bindings_in_order(w),
          id not in heads,
          Map.has_key?(w.bindings, id),
          held_under(ev, id) != [],
          do: id

    parent_sets = Enum.uniq([heads, Enum.sort(heads ++ extras)])

    combos =
      parent_sets
      |> Enum.flat_map(fn parents ->
        parents |> Enum.map(&options(w, ev, &1)) |> product() |> Enum.map(&{parents, &1})
      end)
      |> Enum.take(@max_combos)

    Stream.flat_map(Stream.with_index(combos), fn {{parents, priors}, i} ->
      priors = Enum.sort_by(List.flatten(priors), &{&1.binding, &1.catalog || ""})

      w
      |> entry_choices(priors)
      |> Enum.take(@max_entry_choices)
      |> Enum.with_index()
      |> Enum.map(fn {entries, j} ->
        build(w, admin, "#{label}-#{i}-#{j}", ev, parents, priors, entries)
      end)
    end)
  end

  # The prior-catalog citations for one parent: tips first, then every nonempty subset, then a
  # `nil` citation (lifecycle section 3 permits it only when no catalog is known; it is tried
  # last so a red L cannot come from withholding the option the verifier might expect).
  defp options(w, ev, h) do
    under = held_under(ev, h)
    tips = tips(w, ev, h, [])

    subsets =
      if under == [],
        do: [[nil]],
        else:
          (([tips] ++ subsets(tips) ++ subsets(under))
           |> Enum.uniq()
           |> Enum.reject(&(&1 == []))) ++ [[nil]]

    Enum.map(subsets, fn cs -> for c <- cs, do: %{binding: h, catalog: c} end)
  end

  def author(w, admin, label, ev) do
    results =
      candidates(w, admin, label, ev)
      |> Stream.map(&{&1, preflight(w, ev, &1)})
      |> Enum.take(@max_combos * 2)

    case Enum.find(results, fn {_c, r} -> r == :ok end) do
      {cand, :ok} ->
        {:ok, cand}

      nil ->
        {:error, :no_authorable, Enum.map(results, fn {c, r} -> {cite_text(w, c.r.claim), r} end)}
    end
  end

  def preflight(w, ev, cand) do
    case CatalogBindingGraph.resolve_for_claim(input(w, ev, nil), cand.r.claim) do
      {:ok, g} -> CatalogBindingGraph.cover_claim(g, cand.r.claim, cand.entries)
      {:error, reason, _} -> {:error, reason}
    end
  end

  defp build(w, admin, name, ev, heads, priors, floor) do
    # The fixture derives the origin host from the name; canonical origins are lowercase.
    name = String.downcase(name)
    service = F.identity("service-" <> name)
    service_id = F.id("service-id-" <> name)

    entries =
      for e <- floor,
          do: %{
            e
            | route: "/r/" <> F.id("honest-route-#{name}-#{e.replica}"),
              service_id: service_id,
              service_key: service.pub
          }

    deps = Enum.sort(Log.frontier(ev.space))
    prefix = F.prefix(w.base, ev.space, deps)
    {:ok, %{cutoff: space_cut}} = CatalogCutoff.derive(prefix)

    cutoffs =
      [
        space_cut
        | for(e <- entries, e.replica != w.base.replica, do: thread_cut(e.replica, name))
      ]
      |> Enum.uniq_by(& &1.replica)
      |> Enum.sort_by(& &1.replica)

    generation =
      case CatalogBindingGraph.next_generation(for h <- heads, do: w.bindings[h].generation) do
        {:ok, g} -> g
        :error -> 1
      end

    r =
      F.replacement(w.base, ev.space, name,
        author: admin.identity,
        cap: admin.delegation.id,
        holder_epoch: admin.transfer.id,
        deps: deps,
        parents: heads,
        prior_catalogs: priors,
        generation: generation,
        entries: entries,
        service_key: service,
        service_id: service_id,
        claim: %{cutoffs: cutoffs}
      )

    case CatalogReplacementAuthority.check(
           prefix,
           %{author: admin.identity.pub, cap: admin.delegation.id},
           r.claim,
           w.base.root.pub
         ) do
      :ok ->
        :ok

      other ->
        raise "fixture error: honest op #{name} fails its prefix authority: #{inspect(other)}"
    end

    %{r: r, k: F.first(w.base, r), entries: entries, cutoffs: cutoffs}
  end

  defp thread_cut(replica, name),
    do: %{
      replica: replica,
      frontier: [F.id("f-#{name}-#{replica}")],
      log_digest: F.id("d-#{name}-#{replica}")
    }

  defp register_replacement(w, cand, label, honest) do
    r = cand.r

    w = %{
      w
      | bindings:
          Map.put(w.bindings, r.id, %{
            kind: :replacement,
            label: label,
            parents: r.claim.parents,
            generation: r.claim.generation,
            key: r.catalog_key,
            service: {r.service_id, r.service_key.pub},
            cutoffs: cand.cutoffs,
            honest: honest,
            prior_catalogs: r.claim.prior_catalogs,
            prior_catalog: nil,
            order: map_size(w.bindings)
          }),
        catalogs:
          Map.put(w.catalogs, F.cid(cand.k), %{
            env: cand.k,
            binding: r.id,
            revision: 0,
            previous: nil,
            label: "K" <> String.trim_leading(label, "R"),
            adversary: false,
            withheld: false
          })
    }

    w
    |> add_op(r.op, label)
    |> add_item(%{
      kind: :catalog,
      label: "K-" <> label,
      id: F.cid(cand.k),
      env: cand.k,
      adversary: false
    })
    |> add_item(%{
      kind: :proof,
      label: label <> "-proofs",
      cutoffs: cand.cutoffs,
      adversary: false
    })
  end

  # Union of the cited priors' entries; a nil citation contributes its parent's floor.
  def floor_entries(w, priors) do
    priors
    |> Enum.flat_map(fn
      %{catalog: nil, binding: h} -> nil_floor(w, h)
      %{catalog: c} -> w.catalogs[c].env.catalog.entries
    end)
    |> Enum.uniq_by(&{&1.replica, Map.take(&1, @ext)})
  end

  defp nil_floor(w, h) do
    case w.bindings[h] do
      %{kind: :bootstrap} ->
        []

      %{kind: :rotation, prior_catalog: p} ->
        (w.catalogs[p] && w.catalogs[p].env.catalog.entries) || []

      %{kind: :replacement, prior_catalogs: ps} ->
        floor_entries(w, ps)
    end
  end

  # Every way of picking one fact set per replica from the cited floor.
  defp entry_choices(w, priors) do
    floor = floor_entries(w, priors)
    floor = if floor == [], do: F.base_entries(w.base), else: floor

    floor
    |> Enum.group_by(& &1.replica)
    |> Enum.sort_by(&elem(&1, 0))
    |> Enum.map(&elem(&1, 1))
    |> product()
  end

  defp product([]), do: [[]]
  defp product([xs | rest]), do: for(x <- xs, tail <- product(rest), do: [x | tail])

  defp subsets([]), do: [[]]
  defp subsets([x | rest]), do: for(s <- subsets(rest), do: [x | s]) ++ subsets(rest)

  # --- delivery ---------------------------------------------------------------------------

  @doc "Permute the deliverable items by a generated list of picks."
  def order(items, picks), do: order(items, picks, [])
  defp order([], _picks, acc), do: Enum.reverse(acc)

  defp order(items, picks, acc) do
    {p, rest} =
      case picks do
        [p | rest] -> {p, rest}
        [] -> {0, []}
      end

    {item, items} = List.pop_at(items, rem(p, length(items)))
    order(items, rest, [item | acc])
  end

  @doc """
  Deliver `items` one at a time from the start state (base log and c0 delivered and accepted),
  persisting `%{accepted, frozen}` through `advance/2`. Returns the steps.
  """
  def run(w, items, opts \\ []) do
    lose_at = Keyword.get(opts, :lose_watermark_at)
    ev0 = evidence(w, [], w.base_ops)
    {result0, next0} = deliver(w, %{accepted: nil, frozen: false}, ev0)

    start = %{
      label: "start",
      item: nil,
      delivered: ev0,
      result: result0,
      prev: %{accepted: nil, frozen: false},
      next: next0
    }

    {steps, _} =
      items
      |> Enum.with_index()
      |> Enum.map_reduce({[], persisted(next0), nil}, fn {item, i}, {delivered, state, lost} ->
        delivered = delivered ++ [item]

        # Evidence loss (C6): from step `lose_at` on, the then-accepted catalog is absent from
        # the retained union while the persisted watermark still names it.
        lost =
          if lost == nil and i == lose_at and state.accepted,
            do: state.accepted.catalog,
            else: lost

        ops =
          Map.merge(
            w.base_ops,
            for(%{kind: :space, id: id, op: op} <- delivered, into: %{}, do: {id, op})
          )

        ev = evidence(w, delivered, ops)
        ev = if lost, do: %{ev | catalogs: Map.delete(ev.catalogs, lost)}, else: ev
        {result, next} = deliver(w, state, ev)

        label =
          if lost && i == lose_at, do: item.label <> " (watermark catalog lost)", else: item.label

        step = %{
          label: label,
          item: item,
          delivered: ev,
          result: result,
          prev: state,
          next: next,
          lost: lost
        }

        {step, {delivered, persisted(next), lost}}
      end)

    [start | steps]
  end

  def deliver(w, state, ev) do
    result = CatalogBindingGraph.resolve(input(w, ev, state.accepted))
    {result, CatalogBindingGraph.advance(state, result)}
  end

  def persisted(next), do: Map.take(next, [:accepted, :frozen])

  @doc """
  The liveness search after a run: a fresh root acquisition, then every candidate that passes
  the public preflight is delivered (op, first catalog and its proofs) on top of the final
  persisted state. Returns `{:ok, outcome}` for the first accepted, cleared and served one, or
  `{:error, class, detail}` with class `:no_authorable` (nothing passes the preflight) or the
  first verifier outcome of a preflight-passing candidate.
  """
  def resolve_final(w, last_step) do
    case acquire(w, "final-admin", 30) do
      {:dead, _w, why} -> {{:discard, why}, w, nil}
      {:ok, w2, admin} -> resolve_final(w, w2, admin, last_step)
    end
  end

  defp resolve_final(w, w2, admin, last_step) do
    t_item = List.last(w2.items)
    delivered_items = Enum.filter(w.items, &(not Map.get(&1, :withheld, false)))
    ops = Map.put(last_step.delivered.ops, t_item.id, t_item.op)
    ev = evidence(w2, delivered_items, ops)
    state = persisted(last_step.next)

    results =
      candidates(w2, admin, "Rstar", ev)
      |> Stream.map(fn cand -> {cand, preflight(w2, ev, cand)} end)
      |> Stream.filter(fn {_c, r} -> r == :ok end)
      |> Stream.map(fn {cand, :ok} -> {cand, final_delivery(w2, ev, state, cand)} end)
      |> Enum.take(6)

    case Enum.find(results, fn {_c, out} -> out.verdict == :ok end) do
      {cand, out} ->
        {:ok, Map.put(out, :cand, cand)}

      nil ->
        case results do
          [] ->
            tried =
              candidates(w2, admin, "Rstar", ev)
              |> Stream.map(&{cite_text(w2, &1.r.claim), preflight(w2, ev, &1)})
              |> Enum.take(8)

            {:error, :no_authorable, tried}

          [{cand, out} | _] ->
            {:error, elem(out.verdict, 1),
             %{cite: cite_text(w2, cand.r.claim), decision: elem(out.verdict, 2)}}
        end
    end
    |> then(&{&1, w2, ev})
  end

  def final_delivery(w, ev, state, cand) do
    ops = Map.put(ev.ops, cand.r.id, cand.r.op)

    ev = %{
      ev
      | ops: ops,
        space: Log.from_ops(w.base.replica, ops),
        catalogs: Map.put(ev.catalogs, F.cid(cand.k), cand.k),
        proven: Enum.uniq(ev.proven ++ cand.cutoffs)
    }

    {result, next} = deliver(w, state, ev)
    out = %{r: cand.r, k: cand.k, next: next, result: result}
    Map.put(out, :verdict, Treehouse.CatalogResolutionModel.check_liveness(out))
  end

  # --- labels --------------------------------------------------------------------------------

  defp prev_label(_w, nil), do: "nil"
  defp prev_label(w, id), do: Treehouse.CatalogResolutionModel.label(w, id)

  def cite_text(w, claim) do
    claim.prior_catalogs
    |> Enum.map(fn %{binding: b, catalog: c} ->
      "#{Treehouse.CatalogResolutionModel.label(w, b)}:#{prev_label(w, c)}"
    end)
    |> Enum.join(",")
  end
end
