defmodule Treehouse.CatalogBindingGraphGeneratedDifferentialTest do
  @moduledoc """
  PR #221 evidence, row 389 property (F): a GENERATED differential of
  `Treehouse.CatalogBindingGraph` against the production `Treehouse.CatalogTrust.evaluate/1`
  (called read-only) on replacement-free histories over `CatalogTrustVectors.fixture(1)`.

  StreamData draws a sequence of pages: same-route and moved-route revisions of any held
  catalog (siblings arise whenever the base is not the tip), old-key rotations of any binding
  over any held catalog (rotation forks, rotations from ancestor catalogs, rotations of
  rotations), rotations over a withheld (never published) prior, generation-skipping
  rotations, first catalogs under a rotation (same or moved routes), and the cutoff proof page
  at any point. Each page goes to both: CatalogTrust persists its `next`, the graph persists
  `%{accepted, frozen}` through `advance/2`. Per step the accepted `{binding, catalog}` and the
  served catalogs must agree.

  Mapping rows (as the deterministic differential): `catalog_fork` and `recovery_incomplete`
  to graph blocks of the same reason; CatalogTrust's "no ready catalog" `trust_pending` to a
  graph decision with no promotion and the same served answer; a CatalogTrust page-level
  refusal of any reason (it keeps the installed trust and routes) to the graph's outcome
  served through `advance` (a `trust_pending` error, or a refusal inside the graph); a CatalogTrust `control_history_limit`
  refusal to the graph's `{:error, :control_history_limit, _}` (neither serves). Exclusions
  (D-610): entry-fact refusals (no generated entry changes a fact), cross-branch route reuse
  (every moved route is fresh), `security_block` and persisted-block retention.
  """
  use ExUnit.Case, async: false
  use ExUnitProperties

  alias Lattice.Identity
  alias Treehouse.{CatalogBindingGraph, CatalogTrust, CatalogTrustVectors, TransportCatalog}

  @moduletag timeout: :infinity
  @expected %{trust_revision: 0, history_generation: 0}

  setup_all do
    f = CatalogTrustVectors.fixture(1)
    {:catalog_bootstrap_v1, [record]} = f.space.bootstrap.body
    %{f: f, record: record}
  end

  defp runs, do: String.to_integer(System.get_env("R389_RUNS") || "100")

  # --- the two runtimes (as the deterministic differential) ------------------------------

  defp installed(f) do
    %{kind: :propose, next: prepared} =
      CatalogTrust.prepare_installation(%{
        review: f.review,
        history: hd(f.histories),
        store: %{kind: :verified_fresh, expected: @expected}
      })

    %{kind: :propose, next: installed} =
      trust(prepared, %{catalogs: [f.catalog_json], histories: f.histories})

    installed
  end

  defp trust(state, page) do
    CatalogTrust.evaluate(%{
      installed: state,
      expected: @expected,
      incoming: Map.merge(%{catalogs: [], rotations: [], histories: [], cutoff_proofs: []}, page)
    })
  end

  defp trust_step(state, page) do
    d = trust(state, page)
    next = if d.kind in [:propose, :unchanged, :retain_blocked], do: d.next, else: state

    # A page CatalogTrust refuses whole keeps the installed trust and its routes (lifecycle
    # section 4: "retain existing trust; refuse the candidate"; C8 for trust_pending).
    served =
      if d.kind == :reject,
        do: List.wrap(state.accepted && state.accepted.catalog),
        else: d |> Map.get(:routes, []) |> Enum.map(& &1.catalog) |> Enum.uniq()

    {d, next, served}
  end

  defp graph_step(f, record, state, union) do
    result =
      CatalogBindingGraph.resolve(%{
        bootstrap: %{id: f.space.bootstrap.id, record: record},
        space: f.space_log,
        rotations: Map.new(union.rotations, &{TransportCatalog.rotation_id(&1), &1}),
        catalogs: Map.new(union.catalogs, &{TransportCatalog.catalog_id(&1.catalog), &1}),
        proven_cutoffs:
          Enum.map(union.proofs, &Map.take(&1.cutoff, [:replica, :frontier, :log_digest])),
        accepted: state.accepted
      })

    {result, CatalogBindingGraph.advance(state, result)}
  end

  defp pair(nil), do: nil
  defp pair(a), do: {a.binding, a.catalog}

  # --- generated pages --------------------------------------------------------------------

  defp action do
    one_of([
      map({integer(0..9), boolean()}, fn {i, m} -> {:rev, i, m} end),
      map(
        {integer(0..9), frequency([{3, constant(false)}, {1, constant(true)}]),
         frequency([{4, constant(true)}, {1, constant(false)}])},
        fn {i, wp, g} -> {:rot, i, wp, g} end
      ),
      map({integer(0..9), boolean()}, fn {i, m} -> {:first, i, m} end),
      constant(:proofs)
    ])
  end

  # World: catalogs (envelopes in creation order), bindings (id => %{key, generation}).
  defp world(f) do
    %{
      catalogs: [f.catalog_envelope],
      bindings: %{f.space.bootstrap.id => %{key: f.space.catalog, generation: 0, label: "B"}},
      rotations: [],
      labels: %{TransportCatalog.catalog_id(f.catalog) => "c0", f.space.bootstrap.id => "B"},
      n: 0
    }
  end

  defp id(env), do: TransportCatalog.catalog_id(env.catalog)

  defp moved(entries, label),
    do: Enum.map(entries, &%{&1 | route: "/r/" <> CatalogTrustVectors.id(label <> &1.replica)})

  defp signed(f, binding, revision, previous, entries, key) do
    CatalogTrustVectors.sign_catalog(
      %{f.catalog | binding: binding, revision: revision, previous: previous, entries: entries},
      key
    )
  end

  # Interpret one action into {world, page, description}.
  defp page(f, w, {:rev, i, m}) do
    base = Enum.at(w.catalogs, rem(i, length(w.catalogs)))
    b = base.catalog.binding
    n = w.n + 1
    entries = if m, do: moved(base.catalog.entries, "g#{n}"), else: base.catalog.entries
    c = signed(f, b, base.catalog.revision + 1, id(base), entries, w.bindings[b].key)
    w = %{w | n: n, catalogs: w.catalogs ++ [c], labels: Map.put(w.labels, id(c), "k#{n}")}

    {w, %{catalogs: [c], rotations: [], proofs: []},
     "k#{n}: revision #{c.catalog.revision} of #{w.labels[id(base)]}#{if m, do: " (moved)", else: ""}"}
  end

  defp page(f, w, {:rot, i, withhold, gen_ok}) do
    base = Enum.at(w.catalogs, rem(i, length(w.catalogs)))
    b = base.catalog.binding
    parent = w.bindings[b]
    n = w.n + 1

    prior =
      if withhold,
        do: signed(f, b, base.catalog.revision + 1, id(base), base.catalog.entries, parent.key),
        else: base

    next = Identity.from_seed("gen-catalog-#{n}", "r389-gen-diff-#{n}")
    generation = if gen_ok, do: parent.generation + 1, else: parent.generation + 2

    rotation = %{
      f.rotation
      | parent: b,
        prior_catalog: id(prior),
        generation: generation,
        nonce: CatalogTrustVectors.id("gen-rotation-#{n}"),
        new_catalog_key: next.pub,
        inventory_digest: TransportCatalog.inventory_id(prior.catalog.entries)
    }

    env = CatalogTrustVectors.sign_rotation(rotation, parent.key, next)
    rid = TransportCatalog.rotation_id(env)

    w = %{
      w
      | n: n,
        rotations: w.rotations ++ [{rid, env, prior}],
        bindings: Map.put(w.bindings, rid, %{key: next, generation: generation, label: "t#{n}"}),
        labels: Map.put(w.labels, rid, "t#{n}")
    }

    {w, %{catalogs: [], rotations: [env], proofs: []},
     "t#{n}: rotation of #{parent.label} over #{if withhold, do: "a withheld revision", else: w.labels[id(base)]}" <>
       "#{if gen_ok, do: "", else: " (generation skips)"}"}
  end

  defp page(f, w, {:first, i, m}) do
    case w.rotations do
      [] ->
        {w, %{catalogs: [], rotations: [], proofs: []}, "first: no rotation yet (empty page)"}

      rots ->
        {rid, _env, prior} = Enum.at(rots, rem(i, length(rots)))
        n = w.n + 1
        entries = if m, do: moved(prior.catalog.entries, "g#{n}"), else: prior.catalog.entries
        c = signed(f, rid, 0, nil, entries, w.bindings[rid].key)
        w = %{w | n: n, catalogs: w.catalogs ++ [c], labels: Map.put(w.labels, id(c), "k#{n}")}

        {w, %{catalogs: [c], rotations: [], proofs: []},
         "k#{n}: first catalog under #{w.labels[rid]}#{if m, do: " (moved)", else: ""}"}
    end
  end

  defp page(f, w, :proofs),
    do: {w, %{catalogs: [], rotations: [], proofs: f.cutoff_proofs}, "cutoff proofs"}

  property "F: the graph agrees with CatalogTrust.evaluate/1 on generated replacement-free histories",
           %{f: f, record: record} do
    check all(actions <- list_of(action(), min_length: 1, max_length: 8), max_runs: runs()) do
      differential(f, record, actions, :mirror)
    end
  end

  # The same differential, but the graph keeps every delivered page in its union even when
  # CatalogTrust refuses that page whole (CatalogTrust writes nothing for it and forgets it).
  # Fails on the PR #221 head: see the report.
  @tag :pr221_open
  property "F-retained: as F, with the graph retaining pages CatalogTrust refuses whole",
           %{f: f, record: record} do
    check all(actions <- list_of(action(), min_length: 1, max_length: 8), max_runs: runs()) do
      differential(f, record, actions, :retain)
    end
  end

  # Mapping row (mirror): a page CatalogTrust refuses whole (`kind: :reject`) is judged by the
  # graph with the page included for that step, then dropped from the graph's union, as
  # CatalogTrust retains nothing from it.
  defp differential(f, record, actions, mode) do
    start_graph = %{
      accepted: %{
        binding: f.space.bootstrap.id,
        generation: 0,
        catalog: TransportCatalog.catalog_id(f.catalog),
        revision: 0,
        routes: Map.new(f.catalog.entries, &{&1.route, &1.replica})
      },
      frozen: false
    }

    union0 = %{catalogs: [f.catalog_envelope], rotations: [], proofs: []}

    Enum.reduce(actions, {world(f), installed(f), start_graph, union0, []}, fn action,
                                                                               {w, ts, gs, union,
                                                                                log} ->
      {w, page, text} = page(f, w, action)

      json = %{
        catalogs: Enum.map(page.catalogs, &CatalogTrustVectors.artifact_json/1),
        rotations: Enum.map(page.rotations, &CatalogTrustVectors.artifact_json/1),
        cutoff_proofs: page.proofs
      }

      {d, ts2, served} = trust_step(ts, json)

      with_page = %{
        catalogs: union.catalogs ++ page.catalogs,
        rotations: union.rotations ++ page.rotations,
        proofs: Enum.uniq(union.proofs ++ page.proofs)
      }

      {result, next} = graph_step(f, record, gs, with_page)
      union = if mode == :mirror and d.kind == :reject, do: union, else: with_page
      lbl = &(w.labels[&1] || &1)

      log =
        log ++
          ["#{text}: CatalogTrust #{d.kind} #{inspect(d.reason)}; graph #{graph_outcome(result)}"]

      trace = Enum.join(log, "\n  ")

      assert pair(ts2.accepted) == pair(next.accepted),
             "accepted differs: CatalogTrust #{inspect(ts2.accepted && Enum.map(Tuple.to_list(pair(ts2.accepted)), lbl))}, " <>
               "graph #{inspect(next.accepted && Enum.map(Tuple.to_list(pair(next.accepted)), lbl))}\n  #{trace}"

      assert Enum.map(served, lbl) == Enum.map(List.wrap(next.serving), lbl),
             "served differs: CatalogTrust #{inspect(Enum.map(served, lbl))}, graph " <>
               "#{inspect(Enum.map(List.wrap(next.serving), lbl))}\n  #{trace}"

      {w, ts2, Map.take(next, [:accepted, :frozen]), union, log}
    end)
  end

  defp graph_outcome({:ok, g}) do
    d = g.decision
    "accepted=#{d.accepted} reason=#{inspect(d.reason)}"
  end

  defp graph_outcome({:error, reason, _}), do: "error #{reason}"
end
