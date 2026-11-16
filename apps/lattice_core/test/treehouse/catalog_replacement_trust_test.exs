defmodule Treehouse.CatalogReplacementTrustTest do
  @moduledoc """
  Plan 316 row 316: `Treehouse.CatalogReplacementTrust` in the default suite. A space with no
  replacement behaves exactly as `CatalogTrust.evaluate/1`; with a replacement, both delivery
  orders of R1 and K1 converge, a lone K1 keeps the old routes, the same bytes twice change
  nothing, and a concurrent revoke of the admin freezes and serves nothing. Disposable keys.
  """
  use ExUnit.Case, async: true

  alias Lattice.{Identity, Log, Op}
  alias Treehouse.CatalogBindingGraphFixtures, as: F
  alias Treehouse.{CatalogReplacementTrust, CatalogTrust, CatalogTrustVectors, TransportCatalog}
  alias Treehouse.CatalogReplacementWorld, as: W

  @expected %{trust_revision: 0, history_generation: 0}

  # --- replacement-free equivalence over the five differential sequences ----------------------

  describe "without a replacement the wrapper equals CatalogTrust" do
    setup do
      f = CatalogTrustVectors.fixture(1)
      %{f: f}
    end

    defp install(f) do
      %{kind: :propose, next: prepared} =
        CatalogTrust.prepare_installation(%{
          review: f.review,
          history: hd(f.histories),
          store: %{kind: :verified_fresh, expected: @expected}
        })

      %{kind: :propose, next: trust} =
        CatalogTrust.evaluate(%{
          installed: prepared,
          expected: @expected,
          incoming: %{
            catalogs: [f.catalog_json],
            rotations: [],
            histories: f.histories,
            cutoff_proofs: []
          }
        })

      trust
    end

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
      next = Identity.from_seed("catalog-" <> label, "r316-eq-" <> label)

      rotation = %{
        f.rotation
        | prior_catalog: TransportCatalog.catalog_id(prior.catalog),
          nonce: CatalogTrustVectors.id("eq-rotation-" <> label),
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

    defp page(opts) do
      %{
        catalogs:
          opts |> Keyword.get(:catalogs, []) |> Enum.map(&CatalogTrustVectors.artifact_json/1),
        rotations:
          opts |> Keyword.get(:rotations, []) |> Enum.map(&CatalogTrustVectors.artifact_json/1),
        histories: [],
        cutoff_proofs: Keyword.get(opts, :proofs, [])
      }
    end

    # Both sides see each page; the CatalogTrust state persists only on a non-reject.
    defp run(f, pages) do
      trust = install(f)

      Enum.reduce(pages, {trust, CatalogReplacementTrust.wrap(trust)}, fn page, {t, w} ->
        expected = CatalogTrust.evaluate(%{installed: t, expected: @expected, incoming: page})

        got =
          CatalogReplacementTrust.evaluate(%{installed: w, expected: @expected, incoming: page})

        if expected.kind == :reject do
          assert got == expected
          {t, w}
        else
          assert {got.kind, got.reason, got.routes} ==
                   {expected.kind, expected.reason, expected.routes}

          assert got.trust_decision == expected
          assert got.next.trust == expected.next
          assert got.refused == %{}
          {expected.next, got.next}
        end
      end)
    end

    test "same-route revision, a planned rotation and its first catalog", %{f: f} do
      c1 = revision(f, f.catalog_envelope, 1, f.space.catalog)
      {t, key} = rotation(f, c1, "planned")
      ct = first_under(f, t, key, c1.catalog.entries)

      run(f, [
        page(catalogs: [c1]),
        page(rotations: [t], proofs: f.cutoff_proofs),
        page(catalogs: [ct])
      ])
    end

    test "a rotation whose recovery cutoffs are withheld", %{f: f} do
      {t, key} = rotation(f, f.catalog_envelope, "withheld")
      ct = first_under(f, t, key, f.catalog.entries)
      run(f, [page(rotations: [t], catalogs: [ct]), page(proofs: f.cutoff_proofs)])
    end

    test "a sibling revision with moved routes", %{f: f} do
      c1 = revision(f, f.catalog_envelope, 1, f.space.catalog)

      moved =
        Enum.map(
          f.catalog.entries,
          &%{&1 | route: "/r/" <> CatalogTrustVectors.id("sib" <> &1.replica)}
        )

      c1b = revision(f, f.catalog_envelope, 1, f.space.catalog, moved)
      run(f, [page(catalogs: [c1]), page(catalogs: [c1b])])
    end

    test "a rotation from an ancestor catalog", %{f: f} do
      c1 = revision(f, f.catalog_envelope, 1, f.space.catalog)
      {t, key} = rotation(f, f.catalog_envelope, "ancestor")
      ct = first_under(f, t, key, f.catalog.entries)

      run(f, [page(catalogs: [c1]), page(rotations: [t], catalogs: [ct], proofs: f.cutoff_proofs)])
    end

    test "malformed pages are refused as CatalogTrust refuses them", %{f: f} do
      trust = install(f)
      wrapped = CatalogReplacementTrust.wrap(trust)

      pages = [
        %{catalogs: [], rotations: [], histories: :bad, cutoff_proofs: []},
        %{catalogs: ["not json"], rotations: ["{"], histories: [], cutoff_proofs: []},
        %{catalogs: [], rotations: [], histories: [%{replica: 1, frames: :x}], cutoff_proofs: []},
        %{catalogs: [f.catalog_json]},
        :nope
      ]

      for page <- pages do
        input = fn installed -> %{installed: installed, expected: @expected, incoming: page} end
        expected = CatalogTrust.evaluate(input.(trust))
        assert expected.kind == :reject
        assert CatalogReplacementTrust.evaluate(input.(wrapped)) == expected
      end
    end

    test "a junk catalog does not stop a legitimate revision", %{f: f} do
      junk_key = Identity.from_seed("junk", "r316-junk-eq")

      junk =
        CatalogTrustVectors.sign_catalog(
          %{f.catalog | binding: CatalogTrustVectors.id("none")},
          junk_key
        )

      c1 = revision(f, f.catalog_envelope, 1, f.space.catalog)

      # CatalogTrust alone would refuse the junk page whole; the wrapper keeps it aside.
      parked =
        CatalogReplacementTrust.evaluate(%{
          installed: CatalogReplacementTrust.wrap(install(f)),
          expected: @expected,
          incoming: page(catalogs: [junk])
        })

      w = parked.next

      got =
        CatalogReplacementTrust.evaluate(%{
          installed: w,
          expected: @expected,
          incoming: page(catalogs: [c1])
        })

      alone =
        CatalogTrust.evaluate(%{
          installed: install(f),
          expected: @expected,
          incoming: page(catalogs: [c1])
        })

      assert {got.kind, got.routes, got.next.trust.accepted} ==
               {alone.kind, alone.routes, alone.next.accepted}
    end

    test "a withheld rotation prior", %{f: f} do
      c1 = revision(f, f.catalog_envelope, 1, f.space.catalog)
      {t, _key} = rotation(f, c1, "prior-withheld")
      run(f, [page(rotations: [t], proofs: f.cutoff_proofs)])
    end
  end

  # --- replacement: delivery orders, pending, idempotence, freeze -------------------------------

  describe "with a replacement" do
    setup do
      w = W.build()
      base = w.base

      %{
        w: w,
        log_r1: W.with_ops(base, [w.r1]),
        installed: W.install(w) |> W.evaluate(W.page(catalogs: [w.c0], logs: [base.log])),
        labels: w.labels,
        old: base.record.catalog_key
      }
    end

    defp page_r1(w, log), do: W.page(logs: [log], proofs: [w.proof])
    defp page_k1(w), do: W.page(catalogs: [w.k1])

    test "R1 then K1: accepted R1/K1 at the new origin; R1 alone serves nothing", c do
      %{w: w, log_r1: log, installed: d1, labels: labels, old: old} = c

      d2 = W.evaluate(d1.next, page_r1(w, log))
      v2 = W.view(d2, labels, old)
      # The accepted binding is closed by the honored replacement until K1 is held (D-275).
      assert {v2["accepted"], v2["routes"], v2["frozen"]} == {"B/C0", 0, false}

      d3 = W.evaluate(d2.next, page_k1(w))
      v3 = W.view(d3, labels, old)

      assert {v3["accepted"], v3["origin"], v3["routes"]} ==
               {"R1/K1", "wss://r1-relay.invalid", 1}

      assert v3["old_key_used"] == false
    end

    test "K1 then R1 reaches the same state", c do
      %{w: w, log_r1: log, installed: d1, labels: labels, old: old} = c

      d2 = W.evaluate(d1.next, page_k1(w))
      v2 = W.view(d2, labels, old)

      # K1 alone is trust_pending and keeps the old routes; the sidecar holds it.
      assert d2.reason == :trust_pending
      assert d2.routes == d1.routes

      assert {v2["accepted"], v2["origin"], v2["sidecar"]} ==
               {"B/C0", "wss://base-relay.invalid", 1}

      d3 = W.evaluate(d2.next, page_r1(w, log))
      v3 = W.view(d3, labels, old)
      assert {v3["accepted"], v3["origin"]} == {"R1/K1", "wss://r1-relay.invalid"}

      together = W.evaluate(d1.next, W.page(logs: [log], proofs: [w.proof], catalogs: [w.k1]))
      assert d3.next.binding == together.next.binding
      assert d3.routes == together.routes
    end

    test "the same bytes twice change nothing", c do
      %{w: w, log_r1: log, installed: d1} = c
      page = W.page(logs: [log], proofs: [w.proof], catalogs: [w.k1])
      d2 = W.evaluate(d1.next, page)
      d3 = W.evaluate(d2.next, page)
      assert d3.kind == :unchanged
      assert d3.next == d2.next
      assert d3.routes == d2.routes
    end

    test "a concurrent revoke of the admin freezes and serves no routes", c do
      %{w: w, log_r1: log, installed: d1, labels: labels, old: old} = c
      d2 = W.evaluate(d1.next, W.page(logs: [log], proofs: [w.proof], catalogs: [w.k1]))
      assert W.view(d2, labels, old)["accepted"] == "R1/K1"

      base = w.base

      rv =
        Treehouse.CatalogBindingGraphFixtures.revoke(
          base,
          Lattice.Log.frontier(base.log),
          base.delegation.id
        )

      d3 = W.evaluate(d2.next, W.page(logs: [Lattice.Log.append!(log, rv)]))
      v3 = W.view(d3, labels, old)

      assert d3.routes == []
      assert v3["origin"] == nil

      # Whether CatalogTrust's own block or the graph's freeze stopped serving, the watermark stays.
      assert v3["accepted"] == "R1/K1"
    end

    test "a non-admin replacement is refused and the old routes are kept", c do
      %{w: w, installed: d1, labels: labels, old: old} = c
      log = W.with_ops(w.base, [w.rn.op])
      d2 = W.evaluate(d1.next, W.page(logs: [log], proofs: [w.proof]))
      v2 = W.view(d2, labels, old)
      assert v2["refused"] == ["catalog_authority_refused"]
      assert d2.routes == d1.routes
      assert v2["frozen"] == false
    end

    test "an old-key catalog fork cannot stop an accepted replacement, in either order", c do
      %{w: w, log_r1: log, installed: d1, labels: labels, old: old} = c
      base = w.base
      alias Treehouse.CatalogBindingGraphFixtures, as: F

      moved = Enum.map(F.base_entries(base), &%{&1 | route: "/r/" <> F.id("sibling")})
      c1 = F.catalog(base, base.boot.id, 1, F.cid(w.c0), base.catalog, F.base_entries(base))
      c1b = F.catalog(base, base.boot.id, 1, F.cid(w.c0), base.catalog, moved)

      # The replacement is accepted first; the fork arrives after it.
      accepted = W.evaluate(d1.next, W.page(logs: [log], proofs: [w.proof], catalogs: [w.k1]))
      forked = W.evaluate(accepted.next, W.page(catalogs: [c1, c1b]))
      assert forked.trust_decision.kind == :retain_blocked
      assert forked.trust_decision.reason == :catalog_fork
      v = W.view(forked, labels, old)

      assert {v["accepted"], v["origin"], v["frozen"]} ==
               {"R1/K1", "wss://r1-relay.invalid", false}

      # The fork comes first and serves nothing; an admin R1 citing both heads then recovers.
      first = W.evaluate(d1.next, W.page(catalogs: [c1, c1b]))
      assert first.trust_decision.reason == :catalog_fork
      assert first.routes == []

      {:ok, recovered} = recover(w, [w.c0, c1, c1b], [c1, c1b], first)
      assert recovered.view["accepted"] == "R1x/K1x"
      assert recovered.view["origin"] == "wss://r1-relay.invalid"
    end

    defp recover(w, catalogs, cited, first) do
      alias Treehouse.CatalogBindingGraphFixtures, as: F
      base = w.base
      nc = Identity.from_seed("catalog", "r316-recover-catalog")
      ns = Identity.from_seed("service", "r316-recover-service")
      sid = F.id("recover-service")
      entries = F.entries(base, "recover", sid, ns.pub)

      request = %{
        author: base.admin.pub,
        nonce: F.id("recover-nonce"),
        parents: [base.boot.id],
        prior_catalogs:
          cited
          |> Enum.map(&F.cid/1)
          |> Enum.sort()
          |> Enum.map(&%{binding: base.boot.id, catalog: &1}),
        generation: 1,
        new_catalog_key: nc.pub,
        new_service_id: sid,
        new_service_key: ns.pub,
        new_origin: "wss://r1-relay.invalid",
        entries: entries,
        replica_logs: %{},
        rotations: [],
        catalogs: catalogs
      }

      {:ok, attempt} = Treehouse.Space.prepare_replace_catalog(base.log, request, %{})

      possession = %{
        catalog: Identity.sign(nc, attempt.catalog_possession_bytes),
        service: Identity.sign(ns, attempt.service_possession_bytes)
      }

      {:ok, authored} =
        Treehouse.Space.author_replace_catalog(base.admin, base.log, attempt, possession)

      k = F.catalog(base, authored.binding_id, 0, nil, nc, entries)
      log = Lattice.Log.append!(base.log, authored.op)
      d = W.evaluate(first.next, W.page(logs: [log], proofs: [w.proof], catalogs: [k]))
      labels = Map.merge(w.labels, %{authored.binding_id => "R1x", F.cid(k) => "K1x"})
      {:ok, %{view: W.view(d, labels, base.record.catalog_key)}}
    end

    test "a rotation under a replacement is refused as trust_pending and changes nothing", c do
      %{w: w, log_r1: log, installed: d1} = c
      accepted = W.evaluate(d1.next, W.page(logs: [log], proofs: [w.proof], catalogs: [w.k1]))
      newer = Identity.from_seed("catalog", "r316-rotation-under-r1")

      rotation =
        Treehouse.CatalogBindingGraphFixtures.rotation(
          w.base,
          %{id: w.r1.id, generation: 1},
          w.k1,
          w.new_catalog,
          newer,
          "under-r1"
        )

      page = %{
        W.page()
        | rotations: [CatalogTrustVectors.artifact_json(rotation.envelope)]
      }

      result = W.evaluate(accepted.next, page)
      assert %{kind: :reject, reason: :trust_pending} = result
      assert W.persist(accepted.next, result) == accepted.next
    end

    test "a forged catalog bound to an unheld id cannot pin the client", c do
      %{w: w, log_r1: log, installed: d1, labels: labels, old: old} = c
      alias Treehouse.CatalogBindingGraphFixtures, as: F

      junk_key = Identity.from_seed("junk", "r316-junk-key")

      junk =
        F.catalog(
          w.base,
          F.id("no-such-binding"),
          0,
          nil,
          junk_key,
          F.base_entries(w.base, "junk")
        )

      waiting = W.evaluate(d1.next, W.page(catalogs: [junk]))
      assert waiting.reason == :trust_pending
      assert waiting.routes == d1.routes

      d3 = W.evaluate(waiting.next, W.page(logs: [log], proofs: [w.proof], catalogs: [w.k1]))
      v = W.view(d3, labels, old)
      assert {v["accepted"], v["origin"], v["routes"]} == {"R1/K1", "wss://r1-relay.invalid", 1}
    end
  end

  # --- a blocked CatalogTrust state: only an honored replacement may supersede the block ---------
  #
  # Rule (D-689): composition and the graph's served routes replace a CatalogTrust block only when
  # the graph honors a replacement node and its first catalog is accepted with the serving node
  # bound to that replacement. A replace-shaped op that is malformed, unauthorized or lacks its
  # catalog never widens what is served: while CatalogTrust is blocked the result is the block's.

  describe "a blocked CatalogTrust state" do
    defp blocked_state do
      f = CatalogTrustVectors.fixture(1)
      installed = install(f)
      wrapped = CatalogReplacementTrust.wrap(installed)
      thread_log = W.thread_transfer_log(hd(f.threads))
      history = CatalogTrustVectors.raw_history(thread_log)
      incoming = %{catalogs: [], rotations: [], histories: [history], cutoff_proofs: []}

      blocked =
        CatalogReplacementTrust.evaluate(%{
          installed: wrapped,
          expected: @expected,
          incoming: incoming
        })

      assert %{kind: :retain_blocked, reason: :authority_changed, routes: []} = blocked
      {f, wrapped, blocked}
    end

    test "a malformed replacement command does not lift an authority block" do
      {f, _wrapped, blocked} = blocked_state()

      history =
        CatalogTrustVectors.raw_history(W.with_malformed_replace(f.space_log, f.space.replica))

      result =
        CatalogReplacementTrust.evaluate(%{
          installed: blocked.next,
          expected: @expected,
          incoming: %{catalogs: [], rotations: [], histories: [history], cutoff_proofs: []}
        })

      assert result.kind == :retain_blocked
      assert result.routes == []
      assert result.next.routes == []
      assert result.next.binding == blocked.next.binding
      assert result.next.trust.blocked.reason == :authority_changed

      # Replaying the Thread transfer after the malformed op changes nothing either.
      again =
        CatalogReplacementTrust.evaluate(%{
          installed: result.next,
          expected: @expected,
          incoming: %{catalogs: [], rotations: [], histories: [history], cutoff_proofs: []}
        })

      assert again.routes == []
    end

    # The block is CatalogTrust's old-key `catalog_fork` on the World's bounded Space. Every row
    # starts from that blocked state; only an honored replacement with its accepted first catalog
    # may serve, and then only its own routes.
    test "table: blocked CatalogTrust x {no op, malformed, unauthorized, honored, honored + K1}" do
      alias Treehouse.CatalogBindingGraphFixtures, as: F
      w = W.build()
      base = w.base
      d1 = W.install(w) |> W.evaluate(W.page(catalogs: [w.c0], logs: [base.log]))
      assert length(d1.routes) == 1

      moved = Enum.map(F.base_entries(base), &%{&1 | route: "/r/" <> F.id("sibling")})
      c1 = F.catalog(base, base.boot.id, 1, F.cid(w.c0), base.catalog, F.base_entries(base))
      c1b = F.catalog(base, base.boot.id, 1, F.cid(w.c0), base.catalog, moved)
      blocked = W.evaluate(d1.next, W.page(catalogs: [c1, c1b]))
      assert blocked.trust_decision.reason == :catalog_fork
      assert blocked.routes == []

      outsider = Identity.from_seed("outsider", "r316-table-outsider")

      malformed =
        Op.new(
          outsider,
          base.replica,
          Log.frontier(base.log),
          :command,
          {:replace_catalog_v1, []},
          cap: nil
        )

      rows = [
        {"no op", W.page(logs: [base.log]), 0},
        {"malformed op", W.page(logs: [W.with_ops(base, [malformed])]), 0},
        {"unauthorized op", W.page(logs: [W.with_ops(base, [w.rn.op])], proofs: [w.proof]), 0},
        {"honored op without its catalog",
         W.page(logs: [W.with_ops(base, [w.r1])], proofs: [w.proof]), 0},
        {"honored op with accepted catalog",
         W.page(logs: [W.with_ops(base, [w.r1])], proofs: [w.proof], catalogs: [w.k1]), 1}
      ]

      for {name, page, count} <- rows do
        result = W.evaluate(blocked.next, page)
        assert length(result.routes) == count, name
        assert result.next.trust.blocked != nil, name

        if count == 0 do
          assert result.next.routes == [], name
          assert result.next.binding == blocked.next.binding, name
        else
          assert Enum.all?(result.routes, &String.starts_with?(&1.url, "wss://r1-relay.invalid"))
        end
      end
    end
  end

  # --- a forged signature variant of an authentic catalog (P2) -------------------------------

  describe "signature variants of one catalog id" do
    setup do
      w = W.build()
      base = w.base
      d1 = W.install(w) |> W.evaluate(W.page(catalogs: [w.c0], logs: [base.log]))
      log = W.with_ops(base, [w.r1])
      forged = %{w.k1 | signature: <<207, 0::size(504)>>}
      %{w: w, d1: d1, log: log, forged: forged}
    end

    test "a forged variant after the authentic catalog changes nothing and cannot freeze", c do
      %{w: w, d1: d1, log: log, forged: forged} = c
      accepted = W.evaluate(d1.next, W.page(logs: [log], proofs: [w.proof], catalogs: [w.k1]))
      assert accepted.next.binding.accepted.catalog == F.cid(w.k1)

      after_forged = W.evaluate(accepted.next, W.page(catalogs: [forged]))

      assert {after_forged.kind, after_forged.next} == {:unchanged, accepted.next}
      assert after_forged.routes == accepted.routes
      refute after_forged.next.binding.frozen
      assert length(after_forged.next.extra.catalogs) == 1
    end

    test "a forged variant before the authentic catalog is dropped and the authentic recovers",
         c do
      %{w: w, d1: d1, log: log, forged: forged} = c
      page = W.page(logs: [log], proofs: [w.proof], catalogs: [forged])
      first = W.evaluate(d1.next, page)
      assert first.routes == d1.routes or first.routes == []
      refute first.next.binding.frozen

      authentic = W.evaluate(first.next, W.page(catalogs: [w.k1]))
      together = W.evaluate(d1.next, W.page(logs: [log], proofs: [w.proof], catalogs: [w.k1]))
      assert authentic.next == together.next
      assert authentic.routes == together.routes
      assert length(authentic.routes) == 1
    end

    test "a forged variant parked before its op is held is dropped when the op arrives", c do
      %{w: w, d1: d1, log: log, forged: forged} = c
      parked = W.evaluate(d1.next, W.page(catalogs: [forged, w.k1]))
      assert length(parked.next.extra.catalogs) == 2

      done = W.evaluate(parked.next, W.page(logs: [log], proofs: [w.proof]))
      assert length(done.next.extra.catalogs) == 1
      assert done.next.binding.accepted.catalog == F.cid(w.k1)
      refute done.next.binding.frozen
    end
  end

  # --- wrap keeps the accepted watermark (P2) ----------------------------------------------

  describe "wrap" do
    test "carries CatalogTrust's accepted watermark and its cumulative routes" do
      {w, trust, c1} = trusted_with_thread()
      wrapped = CatalogReplacementTrust.wrap(trust)
      assert %{binding: binding, catalog: catalog} = wrapped.binding.accepted
      assert {binding, catalog} == {w.base.boot.id, F.cid(c1)}
      assert map_size(Map.fetch!(wrapped.binding.accepted, :routes)) == 2
    end

    test "a replacement that drops the accepted Thread freezes instead of silently dropping it" do
      {w, trust, _c1} = trusted_with_thread()
      wrapped = CatalogReplacementTrust.wrap(trust)

      result =
        W.evaluate(
          wrapped,
          W.page(logs: [W.with_ops(w.base, [w.r1])], proofs: [w.proof], catalogs: [w.k1])
        )

      assert result.reason == :authority_changed
      assert result.next.binding.frozen
      assert result.routes == []
    end

    defp trusted_with_thread do
      w = W.build()
      base = w.base
      thread = Map.fetch!(base.threads, "thread")

      %{kind: :propose, next: prepared} =
        CatalogTrust.prepare_installation(%{
          review: w.review,
          history: w.h0,
          store: %{kind: :verified_fresh, expected: @expected}
        })

      deliver = fn state, catalogs, histories ->
        %{kind: :propose, next: next} =
          CatalogTrust.evaluate(%{
            installed: state,
            expected: @expected,
            incoming: %{
              catalogs: Enum.map(catalogs, &CatalogTrustVectors.artifact_json/1),
              rotations: [],
              histories: histories,
              cutoff_proofs: []
            }
          })

        next
      end

      trust = deliver.(prepared, [w.c0], [w.h0])
      space_entry = hd(w.c0.catalog.entries)

      thread_entry =
        F.pool_thread(base, %{space_entry | route: "/r/" <> F.id("t-route")}, "thread")

      c1 =
        F.catalog(base, base.boot.id, 1, F.cid(w.c0), base.catalog, [space_entry, thread_entry])

      histories = [w.h0, CatalogTrustVectors.raw_history(thread.log)]
      {w, deliver.(trust, [c1], histories), c1}
    end
  end
end
