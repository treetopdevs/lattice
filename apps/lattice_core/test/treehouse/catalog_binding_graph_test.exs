defmodule Treehouse.CatalogBindingGraphTest do
  @moduledoc """
  Plan 316 PR 4a resolver tests for `Treehouse.CatalogBindingGraph`. Every scenario in
  `Treehouse.CatalogBindingGraphScenarios` runs here with persisted accepted and blocked
  state between deliveries; each intermediate delivery is asserted against its hand-written
  label-space expectation (heads, closed, closed-out, nodes, refused, raw, refusals, pending
  cutoffs, fork kinds, decision). Disposable seeded keys only; no route, no trust.
  """
  use ExUnit.Case, async: true

  alias Lattice.{Log, Op}
  alias Treehouse.CatalogBindingGraph, as: G
  alias Treehouse.CatalogBindingGraphFixtures, as: F
  alias Treehouse.CatalogBindingGraphScenarios, as: S

  @base F.base()

  for scenario <- S.all(@base) do
    @scenario scenario
    test @scenario.name do
      @base
      |> S.run(@scenario)
      |> Enum.with_index(1)
      |> Enum.each(fn {r, i} ->
        assert r.label_view == r.expect,
               "#{@scenario.name}, delivery #{i}:\n" <>
                 inspect(r.label_view, pretty: true, limit: :infinity)
      end)
    end
  end

  defp resolve(evidence, state \\ F.empty_state()) do
    {result, _} =
      F.deliver(@base, state, Map.merge(%{rotations: %{}, catalogs: %{}, proven: []}, evidence))

    result
  end

  defp proven(r),
    do: Enum.map(r.claim.cutoffs, &%{replica: &1.replica, log_digest: &1.log_digest})

  test "replacement and rotation nodes carry generation, service, origin and parents (D-270)" do
    c0 = F.c0(@base)
    r = F.replacement(@base, @base.log, "fields")

    t =
      F.rotation(
        @base,
        %{id: r.id, generation: 1},
        F.first(@base, r),
        r.catalog_key,
        F.identity("tf"),
        "tf"
      )

    {:ok, g} =
      resolve(%{
        space: F.append(@base.log, [r.op]),
        rotations: %{t.id => t.envelope},
        catalogs: Map.new([c0, F.first(@base, r)], &{F.cid(&1), &1}),
        proven: proven(r)
      })

    b = G.node(g, @base.boot.id)
    assert {b.kind, b.generation, b.origin} == {:bootstrap, 0, "wss://base-relay.invalid"}
    n = G.node(g, r.id)

    assert %{
             kind: :replacement,
             generation: 1,
             parents: [_],
             refused?: false,
             core_reason: nil,
             pending: []
           } = n

    assert {n.service_id, n.service_key, n.origin} ==
             {r.service_id, r.service_key.pub, "wss://fields-relay.invalid"}

    assert n.inventory == r.claim.inventory_digest
    rot = G.node(g, t.id)
    assert {rot.kind, rot.generation, rot.parents} == {:rotation, 2, [r.id]}

    assert {rot.service_id, rot.service_key, rot.origin} ==
             {n.service_id, n.service_key, n.origin}

    assert G.heads(g) == [t.id] and G.closed(g) == [@base.boot.id] and
             G.closed_out(g) == %{F.cid(c0) => :catalog_rollback}
  end

  test "literal claim-to-op bindings and both possession signatures are re-checked" do
    r = F.replacement(@base, @base.log, "lit", op_cap: F.genesis_delegation(@base).id)
    bad = F.replacement(@base, @base.log, "pos", bad_possession: true)
    {:ok, g} = resolve(%{space: F.append(@base.log, [r.op, bad.op])})
    assert g.raw_evidence[bad.id] == :invalid_possession
    assert g.raw_evidence[r.id] in [:catalog_authority_refused, :invalid_catalog_transition]
    assert G.heads(g) == [@base.boot.id]
  end

  test "generation arithmetic is capped at 2^53-1 (finding 9)" do
    for %{"generations" => gens, "next" => next} <- S.generation_cases() do
      assert G.next_generation(gens) == if(next, do: {:ok, next}, else: :error)
    end
  end

  test "cover_claim: unheld prior, then transition failure, then omitted head fork" do
    c0 = F.c0(@base)

    a =
      F.replacement(@base, @base.log, "ca",
        prior_catalogs: [%{binding: @base.boot.id, catalog: F.cid(c0)}]
      )

    b =
      F.replacement(@base, @base.log, "cb",
        prior_catalogs: [%{binding: @base.boot.id, catalog: F.cid(c0)}]
      )

    log = F.append(@base.log, [a.op, b.op])
    {:ok, g} = resolve(%{space: log, catalogs: %{F.cid(c0) => c0}, proven: proven(a)})

    claim = fn parents, priors, gen ->
      %{a.claim | parents: parents, prior_catalogs: priors, generation: gen}
    end

    nil_prior = fn ids -> for(id <- Enum.sort(ids), do: %{binding: id, catalog: nil}) end
    both = Enum.sort([a.id, b.id])

    assert G.cover_claim(
             g,
             claim.(
               both,
               [%{binding: a.id, catalog: F.id("unheld")}, %{binding: b.id, catalog: nil}],
               2
             ),
             a.entries
           ) ==
             {:error, :trust_pending}

    assert G.cover_claim(
             g,
             claim.([F.id("unknown")], nil_prior.([F.id("unknown")]), 2),
             a.entries
           ) ==
             {:error, :trust_pending}

    assert G.cover_claim(g, claim.(both, nil_prior.(both), 3), a.entries) ==
             {:error, :invalid_catalog_transition}

    assert G.cover_claim(g, claim.([a.id], nil_prior.([a.id]), 2), a.entries) ==
             {:error, :catalog_fork}

    assert G.cover_claim(g, claim.(both, nil_prior.(both), 2), a.entries) == :ok
    assert Log.has?(log, a.id) and match?(%Op{}, a.op)
  end
end
