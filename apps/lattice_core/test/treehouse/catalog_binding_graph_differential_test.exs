defmodule Treehouse.CatalogBindingGraphDifferentialTest do
  @moduledoc """
  Plan 316 PR 4a, row 389 property (f), deterministic part: `Treehouse.CatalogBindingGraph`
  against the production `Treehouse.CatalogTrust.evaluate/1` (called read-only) on
  replacement-free histories over `CatalogTrustVectors.fixture(1)`. Each sequence delivers
  pages to both: CatalogTrust persists its `next` snapshot, the graph persists `%{accepted,
  frozen}` through `advance/2`. Per step the accepted `{binding, catalog}` is equal and the
  served catalog agrees.

  Mapping rows (recorded before coding): `catalog_fork` to a graph `catalog_fork` block;
  `recovery_incomplete` to a graph `recovery_incomplete` block; CatalogTrust's "no ready
  catalog" `trust_pending` decision to a graph decision with no promotion and the same served
  answer; a CatalogTrust page-level `trust_pending` throw (C8) to the graph's `{:error,
  :trust_pending, detail}`, with the installed catalog served on the CatalogTrust side and
  `detail.serving` after `advance` on the graph side. Replacement-free histories cannot
  exercise a freeze. Exclusions (D-610): entry-fact refusals, cross-branch route reuse,
  `security_block` and persisted-block retention. The StreamData generator over these actions
  is the Row 389 remainder.
  """
  use ExUnit.Case, async: true

  alias Lattice.Identity
  alias Treehouse.{CatalogBindingGraph, CatalogTrust, CatalogTrustVectors, TransportCatalog}

  @expected %{trust_revision: 0, history_generation: 0}

  setup_all do
    f = CatalogTrustVectors.fixture(1)
    {:catalog_bootstrap_v1, [record]} = f.space.bootstrap.body
    %{f: f, record: record}
  end

  # --- the two runtimes ---------------------------------------------------------

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

  # One page through CatalogTrust: the persisted snapshot and the served catalog.
  defp trust_step(state, page) do
    d = trust(state, page)

    next = if d.kind in [:propose, :unchanged, :retain_blocked], do: d.next, else: state

    # C8: a page-level trust_pending refusal keeps the installed routes.
    served =
      if d.kind == :reject and d.reason == :trust_pending,
        do: List.wrap(state.accepted && state.accepted.catalog),
        else: d |> Map.get(:routes, []) |> Enum.map(& &1.catalog) |> Enum.uniq()

    {d, next, served}
  end

  # One cumulative union through the graph and `advance/2`.
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

  defp accepted_pair(nil), do: nil
  defp accepted_pair(a), do: {a.binding, a.catalog}

  # Deliver `pages` (each `%{catalogs: [envelope], rotations: [envelope], proofs: [proof]}`) to
  # both runtimes and compare per step; returns the per-step outcomes for row-specific checks.
  defp run(f, record, pages) do
    start_trust = installed(f)

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

    pages
    |> Enum.with_index(1)
    |> Enum.map_reduce({start_trust, start_graph, union0}, fn {page, i}, {ts, gs, union} ->
      json = %{
        catalogs: Enum.map(page.catalogs, &CatalogTrustVectors.artifact_json/1),
        rotations: Enum.map(page.rotations, &CatalogTrustVectors.artifact_json/1),
        cutoff_proofs: page.proofs
      }

      {d, ts2, served} = trust_step(ts, json)

      union = %{
        catalogs: union.catalogs ++ page.catalogs,
        rotations: union.rotations ++ page.rotations,
        proofs: union.proofs ++ page.proofs
      }

      {result, next} = graph_step(f, record, gs, union)

      assert accepted_pair(ts2.accepted) == accepted_pair(next.accepted),
             "step #{i}: CatalogTrust accepted #{inspect(accepted_pair(ts2.accepted))} " <>
               "(#{d.kind} #{inspect(d.reason)}), graph #{inspect(accepted_pair(next.accepted))} " <>
               "(#{inspect(elem(result, 0))})"

      assert served == List.wrap(next.serving),
             "step #{i}: CatalogTrust served #{inspect(served)} (#{d.kind} #{inspect(d.reason)}), " <>
               "graph #{inspect(next.serving)}"

      {%{trust: d, graph: result, next: next}, {ts2, Map.take(next, [:accepted, :frozen]), union}}
    end)
    |> elem(0)
  end

  # --- builders -------------------------------------------------------------------

  defp revision(f, previous, revision, signer, entries \\ nil) do
    CatalogTrustVectors.sign_catalog(
      %{
        f.catalog
        | revision: revision,
          previous: TransportCatalog.catalog_id(previous.catalog),
          entries: entries || previous.catalog.entries
      },
      signer
    )
  end

  defp rotation(f, prior, label) do
    next = Identity.from_seed("catalog-" <> label, "r316-4a-diff-" <> label)

    rotation = %{
      f.rotation
      | prior_catalog: TransportCatalog.catalog_id(prior.catalog),
        nonce: CatalogTrustVectors.id("diff-rotation-" <> label),
        new_catalog_key: next.pub
    }

    {CatalogTrustVectors.sign_rotation(rotation, f.space.catalog, next), next}
  end

  defp first_under(f, rotation, signer, entries) do
    CatalogTrustVectors.sign_catalog(
      %{
        f.catalog
        | binding: TransportCatalog.rotation_id(rotation),
          revision: 0,
          previous: nil,
          entries: entries
      },
      signer
    )
  end

  defp moved(entries, label),
    do:
      entries
      |> Enum.map(&%{&1 | route: "/r/" <> CatalogTrustVectors.id(label <> &1.replica)})

  defp page(opts),
    do: %{
      catalogs: Keyword.get(opts, :catalogs, []),
      rotations: Keyword.get(opts, :rotations, []),
      proofs: Keyword.get(opts, :proofs, [])
    }

  # --- sequences ---------------------------------------------------------------------

  test "same-route revision, a planned rotation and its first catalog agree", %{f: f, record: r} do
    c1 = revision(f, f.catalog_envelope, 1, f.space.catalog)
    {t, key} = rotation(f, c1, "planned")
    ct = first_under(f, t, key, c1.catalog.entries)

    steps =
      run(f, r, [
        page(catalogs: [c1]),
        page(rotations: [t], proofs: f.cutoff_proofs),
        page(catalogs: [ct])
      ])

    assert [%{trust: %{reason: nil}}, %{trust: %{reason: :trust_pending}}, _] = steps
    assert match?({:ok, %{decision: %{accepted: false, block: nil}}}, Enum.at(steps, 1).graph)
  end

  test "a rotation whose recovery cutoffs are withheld is recovery_incomplete", %{f: f, record: r} do
    {t, key} = rotation(f, f.catalog_envelope, "withheld")
    ct = first_under(f, t, key, f.catalog.entries)
    steps = run(f, r, [page(rotations: [t], catalogs: [ct]), page(proofs: f.cutoff_proofs)])

    assert %{trust: %{reason: :recovery_incomplete}} = hd(steps)

    assert {:ok, %{decision: %{block: %{reason: :recovery_incomplete}}}} = hd(steps).graph
  end

  test "a sibling revision with moved routes forks in both", %{f: f, record: r} do
    c1 = revision(f, f.catalog_envelope, 1, f.space.catalog)
    c1b = revision(f, f.catalog_envelope, 1, f.space.catalog, moved(f.catalog.entries, "sib"))
    steps = run(f, r, [page(catalogs: [c1]), page(catalogs: [c1b])])
    assert %{trust: %{reason: :catalog_fork}} = List.last(steps)
    assert {:ok, %{decision: %{reason: :catalog_fork}}} = List.last(steps).graph
  end

  test "a rotation from an ancestor catalog forks in both (C1)", %{f: f, record: r} do
    c1 = revision(f, f.catalog_envelope, 1, f.space.catalog)
    {t, key} = rotation(f, f.catalog_envelope, "ancestor")
    ct = first_under(f, t, key, f.catalog.entries)

    steps =
      run(f, r, [
        page(catalogs: [c1]),
        page(rotations: [t], catalogs: [ct], proofs: f.cutoff_proofs)
      ])

    assert %{trust: %{reason: :catalog_fork}} = List.last(steps)
    assert {:ok, %{decision: %{reason: :catalog_fork}}} = List.last(steps).graph
  end

  # C8: CatalogTrust throws a page-level trust_pending for a rotation whose prior catalog is
  # withheld and keeps the installed routes; the graph's trust_pending detail serves the same
  # catalog after `advance` (freeze false, watermark unchanged and open).
  test "a withheld rotation prior is trust_pending in both and keeps serving", %{f: f, record: r} do
    c1 = revision(f, f.catalog_envelope, 1, f.space.catalog)
    {t, _key} = rotation(f, c1, "prior-withheld")
    [step] = run(f, r, [page(rotations: [t], proofs: f.cutoff_proofs)])
    assert %{kind: :reject, reason: :trust_pending} = step.trust
    assert {:error, :trust_pending, %{freeze: false}} = step.graph
    assert step.next.frozen == false
  end
end
