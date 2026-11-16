defmodule Treehouse.CatalogBindingGraphTest do
  @moduledoc """
  Plan 316 PR 4a resolver tests for `Treehouse.CatalogBindingGraph`. Every scenario in
  `Treehouse.CatalogBindingGraphScenarios` runs here with the persisted accepted
  watermark and `frozen` bit between deliveries; each intermediate delivery is asserted against its hand-written
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
    do: Enum.map(r.claim.cutoffs, &Map.take(&1, [:replica, :frontier, :log_digest]))

  test "a proven cutoff without its frontier is malformed input (D-A19)" do
    r = F.replacement(@base, @base.log, "no-frontier")
    log = F.append(@base.log, [r.op])
    [cut] = proven(r)

    for bad <- [Map.delete(cut, :frontier), %{cut | frontier: [1]}] do
      assert {:error, :malformed_catalog, _} = resolve(%{space: log, proven: [bad]})
    end

    assert {:ok, _} = resolve(%{space: log, proven: [cut]})
  end

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
    # An op cap that is not the acquisition delegation fails step 4 first (rank 5 over the
    # literal binding's rank 6); the literal deps binding alone is pinned in the scenario table.
    assert g.raw_evidence[r.id] == :catalog_authority_refused
    assert G.heads(g) == [@base.boot.id]
  end

  test "generation arithmetic is capped at 2^53-1 (finding 9)" do
    for %{"generations" => gens, "next" => next} <- S.generation_cases() do
      assert G.next_generation(gens) == if(next, do: {:ok, next}, else: :error)
    end
  end

  # Review round 2, finding 4: after accepted R1/K1 is union-refused by a concurrent holder
  # change, the public preflight must prepare the C13 recovery claim citing `{R1, K1}` (the
  # resolver accepts it and it clears the refusal); citing `{R1, nil}` closes K1 out instead.
  test "authoring prepares the C13 recovery claim that cites the refused accepted catalog" do
    c0 = F.c0(@base)

    r1 =
      F.replacement(@base, @base.log, "r1",
        prior_catalogs: [%{binding: @base.boot.id, catalog: F.cid(c0)}]
      )

    k1 = F.first(@base, r1)

    t2 =
      F.transfer(@base, Log.frontier(@base.log), @base.nominee.pub,
        issuer: @base.admin,
        parent_id: @base.delegation.id
      )

    log = F.append(@base.log, [r1.op, t2.op])

    service = F.identity("service-c13-prep")
    service_id = F.id("service-id-c13-prep")

    request = fn prior ->
      %{
        author: @base.nominee.pub,
        nonce: F.id("nonce-c13-prep"),
        parents: [r1.id],
        prior_catalogs: [%{binding: r1.id, catalog: prior}],
        generation: 2,
        new_catalog_key: F.identity("catalog-c13-prep").pub,
        new_service_id: service_id,
        new_service_key: service.pub,
        new_origin: "wss://c13-prep-relay.invalid",
        entries: F.entries(@base, "c13-prep", service_id, service.pub),
        replica_logs: %{},
        rotations: [],
        catalogs: [c0, k1]
      }
    end

    assert {:ok, attempt} =
             Treehouse.CatalogReplacementAuthoring.prepare(log, request.(F.cid(k1)), %{})

    assert attempt.claim.prior_catalogs == [%{binding: r1.id, catalog: F.cid(k1)}]

    assert Treehouse.CatalogReplacementAuthoring.prepare(log, request.(nil), %{}) ==
             {:error, :catalog_fork}

    # `catalog_heads` (promotion, split forks) is unchanged; only coverage reads citable heads.
    {:ok, g} = resolve(%{space: log, catalogs: %{F.cid(c0) => c0, F.cid(k1) => k1}})
    assert G.node(g, r1.id).refused? and g.citable_catalog_heads[r1.id] == [F.cid(k1)]
    assert g.catalog_heads[r1.id] == nil
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

  defp thread(space, suffix),
    do: %{
      space
      | replica: space.replica <> "-" <> suffix,
        kind: :thread,
        schema: :treehouse_thread_v1,
        route: "/r/" <> F.id("route-" <> suffix)
    }

  # S11 (C4): three old-key rotations under the accepted R1 make the verifier return
  # control_history_limit, but the preflight prepares the R2 {R1, K1} resolution through the
  # head-root escape, and the verifier accepts that R2.
  test "authoring prepares a resolution past three rotation heads (head-limit escape)" do
    c0 = F.c0(@base)

    r1 =
      F.replacement(@base, @base.log, "esc-r1",
        prior_catalogs: [%{binding: @base.boot.id, catalog: F.cid(c0)}]
      )

    k1 = F.first(@base, r1)
    log = F.append(@base.log, [r1.op])

    trs =
      for n <- ~w(a b c),
          do:
            F.rotation(
              @base,
              %{id: r1.id, generation: 1},
              k1,
              r1.catalog_key,
              F.identity("esc-" <> n),
              "esc-" <> n
            )

    rotations = Map.new(trs, &{&1.id, &1.envelope})

    assert {:error, :control_history_limit, _} =
             resolve(%{space: log, rotations: rotations, catalogs: catalogs([c0, k1])})

    service = F.identity("service-esc-r2")
    service_id = F.id("service-id-esc-r2")

    request = fn parents, priors ->
      %{
        author: @base.admin.pub,
        nonce: F.id("nonce-esc-r2"),
        parents: parents,
        prior_catalogs: priors,
        generation: 2,
        new_catalog_key: F.identity("catalog-esc-r2").pub,
        new_service_id: service_id,
        new_service_key: service.pub,
        new_origin: "wss://esc-r2-relay.invalid",
        entries: F.entries(@base, "esc-r2", service_id, service.pub),
        replica_logs: %{},
        rotations: Enum.map(trs, & &1.envelope),
        catalogs: [c0, k1]
      }
    end

    assert {:ok, attempt} =
             Treehouse.CatalogReplacementAuthoring.prepare(
               log,
               request.([r1.id], [%{binding: r1.id, catalog: F.cid(k1)}]),
               %{}
             )

    # A claim that does not cite every head root keeps the verifier's limit.
    assert Treehouse.CatalogReplacementAuthoring.prepare(
             log,
             request.([@base.boot.id], [%{binding: @base.boot.id, catalog: F.cid(c0)}]),
             %{}
           ) == {:error, :control_history_limit}

    assert attempt.claim.prior_catalogs == [%{binding: r1.id, catalog: F.cid(k1)}]
  end

  # Row 382 item 2 in the preflight: a nil-cited parent's floor must be carried. R's first
  # catalog is refused (Thread cutoff missing), so R2 citing {R, nil} must still carry C0's
  # Thread.
  test "cover_claim carries a nil-cited parent's floor" do
    [space] = F.base_entries(@base)
    th = thread(space, "floor-thread")
    c0 = F.catalog(@base, @base.boot.id, 0, nil, @base.catalog, [space, th])
    sid = F.id("service-id-floor-r")
    key = F.identity("service-floor-r").pub
    moved = for e <- [space, th], do: %{e | service_id: sid, service_key: key}

    r =
      F.replacement(@base, @base.log, "floor-r",
        prior_catalogs: [%{binding: @base.boot.id, catalog: F.cid(c0)}],
        entries: moved
      )

    kr = F.first(@base, r)
    log = F.append(@base.log, [r.op])
    {:ok, g} = resolve(%{space: log, catalogs: catalogs([c0, kr])})
    assert g.refusals[F.cid(kr)].reason == :invalid_catalog_transition
    assert g.floors[r.id].entries == [space, th]

    claim = %{
      r.claim
      | parents: [r.id],
        prior_catalogs: [%{binding: r.id, catalog: nil}],
        generation: 2
    }

    assert G.cover_claim(g, claim, [space]) == {:error, :invalid_catalog_transition}
    assert G.cover_claim(g, claim, [space, th]) == :ok
  end

  # C1 in the preflight: a rotation fork requires citing both the rotation and its open parent.
  test "cover_claim requires a rotation fork's rotation and parent" do
    c0 = F.c0(@base)
    c1 = F.catalog(@base, @base.boot.id, 1, F.cid(c0), @base.catalog, F.base_entries(@base))
    tkey = F.identity("fork-t-key")
    t = F.rotation(@base, %{id: @base.boot.id, generation: 0}, c0, @base.catalog, tkey, "fork-t")
    ct = F.catalog(@base, t.id, 0, nil, tkey, F.base_entries(@base))

    {:ok, g} =
      resolve(%{
        space: @base.log,
        rotations: %{t.id => t.envelope},
        catalogs: catalogs([c0, c1, ct]),
        proven:
          Enum.map(t.envelope.rotation.cutoffs, &Map.take(&1, [:replica, :frontier, :log_digest]))
      })

    assert [%{kind: :rotation}] = g.forks
    assert g.fork_bindings == [@base.boot.id]
    r = F.replacement(@base, @base.log, "fork-r")
    both = Enum.sort([t.id, @base.boot.id])

    priors =
      Enum.sort([
        %{binding: t.id, catalog: F.cid(ct)},
        %{binding: @base.boot.id, catalog: F.cid(c1)}
      ])

    entries = F.entries(@base, "fork-r-fresh", r.service_id, r.service_key.pub)

    only_t = %{
      r.claim
      | parents: [t.id],
        prior_catalogs: [%{binding: t.id, catalog: F.cid(ct)}],
        generation: 2
    }

    assert G.cover_claim(g, only_t, entries) == {:error, :catalog_fork}
    claim = %{r.claim | parents: both, prior_catalogs: priors, generation: 2}
    assert G.cover_claim(g, claim, entries) == :ok
    # An entry re-pointing a held catalog's route at another replica is refused.
    [e] = entries
    squat = %{e | replica: e.replica <> "-squat", kind: :thread, schema: :treehouse_thread_v1}
    squat = %{squat | route: hd(c0.catalog.entries).route}
    assert G.cover_claim(g, claim, [e, squat]) == {:error, :invalid_catalog_transition}
  end

  # PR #221 round 5, finding 4 (D-A10): a closed-out old-key catalog squatting the honest
  # head's route cannot veto a later resolution that carries the honest catalog's entries
  # unchanged; a new entry re-pointing that route is still refused.
  test "cover_claim lets a closed-out squat not veto carried entries" do
    r = F.replacement(@base, @base.log, "carry-r")
    kr = F.first(@base, r)
    [space] = F.base_entries(@base)
    [route] = Enum.map(r.entries, & &1.route)

    thread = %{
      space
      | replica: @base.replica <> "-squat",
        kind: :thread,
        schema: :treehouse_thread_v1
    }

    squat =
      F.catalog(@base, @base.boot.id, 0, nil, @base.catalog, [space, %{thread | route: route}])

    log = F.append(@base.log, [r.op])
    {:ok, g} = resolve(%{space: log, catalogs: catalogs([squat, kr]), proven: proven(r)})
    assert g.closed_out[F.cid(squat)] == :catalog_rollback
    assert g.decision.accepted

    claim = %{
      r.claim
      | parents: [r.id],
        prior_catalogs: [%{binding: r.id, catalog: F.cid(kr)}],
        generation: 2,
        nonce: F.id("carry-r2-nonce")
    }

    assert G.cover_claim(g, claim, r.entries) == :ok

    moved = %{hd(r.entries) | replica: @base.replica <> "-new", kind: :thread}
    fresh = %{hd(r.entries) | route: "/r/" <> F.id("carry-fresh")}

    assert G.cover_claim(g, claim, [fresh, moved]) == {:error, :invalid_catalog_transition}
  end

  # Row 386, repair (a): `trust_pending` ORs the complete part's freeze into `frozen` and serves
  # the watermark's own `serving` only while not frozen; without those fields (a page-level
  # refusal) it keeps `frozen` and serves nothing. Pending evidence never lifts a freeze.
  test "advance/2 on trust_pending is sticky and freezes only on the complete part's bit" do
    a = %{binding: "b", generation: 0, catalog: "c", revision: 0, routes: %{}}
    frozen = %{accepted: a, frozen: true}
    open = %{accepted: a, frozen: false}

    pending = fn freeze, serving ->
      {:error, :trust_pending, %{ids: ["x"], freeze: freeze, serving: serving}}
    end

    assert G.advance(frozen, pending.(false, "c")) == %{accepted: a, frozen: true, serving: nil}
    assert G.advance(open, pending.(true, "c")) == %{accepted: a, frozen: true, serving: nil}
    assert G.advance(open, pending.(false, "c")) == %{accepted: a, frozen: false, serving: "c"}
    assert G.advance(open, pending.(false, nil)) == %{accepted: a, frozen: false, serving: nil}

    for state <- [frozen, open] do
      assert G.advance(state, {:error, :trust_pending, %{ids: []}}) ==
               %{accepted: a, frozen: state.frozen, serving: nil}

      assert %{serving: nil} = G.advance(state, {:error, :control_history_limit, %{ids: []}})
      assert %{serving: nil} = G.advance(state, {:error, :malformed_catalog, %{ids: []}})
    end
  end

  # Design section 1.5: the only branch that lifts `frozen` needs an accepting decision that
  # clears; an accepting decision that does not clear leaves a frozen client frozen.
  test "advance/2 lifts frozen only on an accepting decision that clears" do
    a = %{binding: "b", generation: 0, catalog: "c", revision: 0, routes: %{"/a" => "space"}}
    frozen = %{accepted: a, frozen: true}

    result = fn accepted?, clears?, block ->
      {:ok,
       %{
         catalogs: %{"k" => %{entries: [%{route: "/k", replica: "space"}]}},
         decision: %{
           accepted: accepted?,
           head: "h",
           generation: 1,
           catalog: if(accepted?, do: "k"),
           revision: 0,
           clears_authority_changed: clears?,
           block: block,
           serving: if(accepted?, do: "k")
         }
       }}
    end

    assert G.advance(frozen, result.(true, false, nil)) == %{
             accepted: a,
             frozen: true,
             serving: nil
           }

    assert %{accepted: %{binding: "h", catalog: "k", routes: routes}, frozen: false, serving: "k"} =
             G.advance(frozen, result.(true, true, nil))

    assert routes == %{"/a" => "space", "/k" => "space"}
    open = %{frozen | frozen: false}
    freeze = %{reason: :authority_changed, ids: ["h"], freeze: true}

    assert G.advance(open, result.(false, false, freeze)) == %{
             accepted: a,
             frozen: true,
             serving: nil
           }

    derived = %{reason: :catalog_authority_refused, ids: ["h"], freeze: false}

    assert G.advance(open, result.(false, false, derived)) == %{
             accepted: a,
             frozen: false,
             serving: nil
           }
  end

  defp catalogs(list), do: Map.new(list, &{F.cid(&1), &1})
end
