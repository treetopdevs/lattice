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

    test "a rotation under a replacement advances the client to the rotated key", c do
      %{w: w, log_r1: log, installed: d1, labels: labels, old: old} = c
      accepted = W.evaluate(d1.next, W.page(logs: [log], proofs: [w.proof], catalogs: [w.k1]))
      t = W.rotation(w, %{id: w.r1.id, generation: 1}, w.k1, w.new_catalog, "under-r1")
      k = F.catalog(w.base, t.id, 0, nil, t.key, w.k1.catalog.entries)
      labels = Map.merge(labels, %{t.id => "T", F.cid(k) => "KT"})

      rotated = W.evaluate(accepted.next, W.page(rotations: [t.envelope]))
      assert rotated.kind == :propose
      assert rotated.reason == :trust_pending

      result = W.evaluate(rotated.next, W.page(catalogs: [k]))
      v = W.view(result, labels, old)
      assert {v["accepted"], v["origin"], v["routes"]} == {"T/KT", "wss://r1-relay.invalid", 1}
      assert Enum.all?(result.routes, &(&1.service_key == hd(w.k1.catalog.entries).service_key))
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

  # --- D-881: review findings, replayed in BEAM and in the TS twin ------------------------------
  #
  # 1. `wrap/1` keeps the route table of every catalog on the accepted chain, not only the
  #    accepted catalog's: a route the client served earlier stays reserved.
  # 2. A `replace_catalog_v1` body that is not a 2-tuple is not a replacement op in either runtime.
  # 3. A sidecar catalog bound to a `{:replace_catalog_v1, [claim]}` op (wrong argument count) is
  #    dropped in both runtimes: no catalog key is read from a command of the wrong arity.

  describe "D-881 review findings" do
    test "wrap keeps the routes of every catalog on the accepted chain" do
      s = d881_moved_route()
      routes = CatalogReplacementTrust.wrap(s.trust).binding.accepted.routes
      assert routes[s.route_b] == s.thread_replica
      assert routes[s.route_b2] == s.thread_replica
    end

    test "wrap keeps the routes of catalogs before a rotation" do
      f = CatalogTrustVectors.fixture(1)

      moved =
        Enum.map(
          f.catalog.entries,
          &%{&1 | route: "/r/" <> CatalogTrustVectors.id("d881" <> &1.replica)}
        )

      c1 = revision(f, f.catalog_envelope, 1, f.space.catalog, moved)
      key = Identity.from_seed("catalog-d881", "r316-d881-rotation")

      rotation = %{
        f.rotation
        | prior_catalog: TransportCatalog.catalog_id(c1.catalog),
          nonce: CatalogTrustVectors.id("d881-rotation"),
          new_catalog_key: key.pub,
          inventory_digest: TransportCatalog.inventory_id(moved)
      }

      t = CatalogTrustVectors.sign_rotation(rotation, f.space.catalog, key)
      ct = first_under(f, t, key, moved)

      trust =
        Enum.reduce(
          [
            page(catalogs: [c1]),
            page(rotations: [t], proofs: f.cutoff_proofs),
            page(catalogs: [ct])
          ],
          install(f),
          fn page, state ->
            %{kind: :propose, next: next} =
              CatalogTrust.evaluate(%{installed: state, expected: @expected, incoming: page})

            next
          end
        )

      assert trust.accepted.binding == TransportCatalog.rotation_id(t)
      routes = CatalogReplacementTrust.wrap(trust).binding.accepted.routes
      for e <- f.catalog.entries ++ moved, do: assert(routes[e.route] == e.replica)
    end

    test "a descendant replacement reusing a route the accepted chain served stays frozen" do
      [_, _, _, last] = d881_views(d881_moved_route().run)
      assert {last["frozen"], last["routes"], last["origin"]} == {true, 0, nil}
      assert last["accepted"] == "B/C2"
    end

    test "the mirrored watermark keeps a route moved within one page" do
      [_, mid, last] = d881_views(d881_moved_route().one_page)
      assert {mid["accepted"], mid["routes"]} == {"B/C2", 2}
      assert {last["frozen"], last["routes"], last["origin"]} == {true, 0, nil}
      assert last["accepted"] == "B/C2"
    end

    test "a replace_catalog_v1 body of the wrong tuple arity is not a replacement op" do
      [_, last] = d881_views(d881_three_tuple())
      assert last["refused"] == []
      assert {last["accepted"], last["routes"], last["frozen"]} == {"B/C0", 1, false}
    end

    test "a catalog bound to a replace_catalog_v1 command of the wrong arity is dropped" do
      [_, last] = d881_views(d881_one_argument())
      assert last["sidecar"] == 0
      assert {last["accepted"], last["routes"]} == {"B/C0", 1}
    end

    @tag :replacement_demo
    @tag timeout: 180_000
    test "BEAM equals TS on the D-881 and D-882 runs" do
      moved = d881_moved_route()

      runs = [
        moved.run,
        moved.one_page,
        d881_three_tuple(),
        d881_one_argument(),
        d882_unseen_bootstrap(),
        d882_control_history_limit()
      ]

      beam = Map.new(runs, &{&1.name, d881_views(&1)})

      path =
        Path.join(
          System.tmp_dir!(),
          "replacement-d881-#{System.unique_integer([:positive])}.json"
        )

      doc = %{
        "format" => "lattice-replacement-demo-v1",
        "history" => hd(runs).history,
        "labels" => Enum.reduce(runs, %{}, &Map.merge(&2, &1.labels)),
        "runs" =>
          for run <- runs do
            %{
              "name" => run.name,
              "history" => run.history,
              "steps" =>
                Enum.map(run.steps, fn {title, page, mode} ->
                  %{
                    "title" => title,
                    "print" => false,
                    "mode" => to_string(mode),
                    "page" => W.page_json(page)
                  }
                end)
            }
          end
      }

      File.write!(path, Jason.encode!(doc))
      on_exit(fn -> File.rm(path) end)

      {out, status} =
        System.cmd(
          "node",
          ["--import", "tsx", "test/support/consume_catalog_replacement_demo.ts", path],
          cd: Path.expand("../../../../clients/lattice-client", __DIR__),
          stderr_to_stdout: true
        )

      assert status == 0, out
      [views] = for "VIEWS " <> json <- String.split(out, "\n", trim: true), do: json
      assert Jason.decode!(views) == beam
    end
  end

  # --- D-882: only the block classes the replacement graph resolves are superseded -------------
  #
  # The old-key catalog fork case (still superseded) is "an old-key catalog fork cannot stop an
  # accepted replacement, in either order" and the "honored op with accepted catalog" row of the
  # blocked-state table above.

  describe "D-882 supersession" do
    test "an unreviewed bootstrap beside an honored replacement stays blocked and serves nothing" do
      [_, last] = d881_views(d882_unseen_bootstrap())
      assert {last["kind"], last["reason"]} == {"retain_blocked", "catalog_fork"}
      assert {last["routes"], last["origin"], last["urls"]} == {0, nil, []}
      assert last["accepted"] == "B/C0"
    end

    test "a control_history_limit block is not superseded by an honored replacement" do
      [_, last] = d881_views(d882_control_history_limit())
      assert {last["kind"], last["reason"]} == {"retain_blocked", "control_history_limit"}
      assert {last["routes"], last["origin"]} == {0, nil}
    end
  end

  # D-882 (a): the client reviewed and installed a history with one bootstrap. A later page
  # holds a second root-authored bootstrap (before the admin transfer, so it is valid), the
  # leased admin's replacement R citing C0, and K. CatalogTrust blocks as `catalog_fork` naming
  # the unseen bootstrap; the graph judges only the reviewed one and would honor R.
  defp d882_unseen_bootstrap do
    w = W.build()
    base = w.base
    pre_ops = base.log |> Log.ops() |> Map.drop([base.transfer.id, base.beacon1.id])
    pre = Log.from_ops(base.replica, pre_ops)
    record = %{base.record | nonce: F.id("d882-unseen-nonce")}

    unseen =
      F.op(base.root, base, Log.frontier(pre), :command, {:catalog_bootstrap_v1, [record]},
        cap: F.genesis_delegation(base).id
      )

    transfer = Op.new(base.root, base.replica, [unseen.id], :authority, base.transfer.body)
    beacon = F.beacon(base, [transfer.id], 1)
    log = F.append(pre, [unseen, transfer, beacon])
    world = %{base | log: log, transfer: transfer, beacon1: beacon}

    r =
      F.replacement(world, log, "d882-r",
        prior_catalogs: [%{binding: base.boot.id, catalog: F.cid(w.c0)}]
      )

    k = F.first(world, r)
    {:ok, %{cutoff: cutoff}} = Treehouse.CatalogCutoff.derive(log)
    proof = %{cutoff: cutoff, history: CatalogTrustVectors.raw_history(log)}
    h0 = CatalogTrustVectors.raw_history(pre)
    w = %{w | base: world, h0: h0}
    labels = %{unseen.id => "B2", r.id => "R", F.cid(k) => "K"}

    d881_run(w, "d882_unseen_bootstrap", labels, [
      {"install C0", W.page(catalogs: [w.c0], logs: [pre]), :eval},
      {"B2 + R + K", W.page(logs: [W.with_ops(world, [r.op])], proofs: [proof], catalogs: [k]),
       :eval}
    ])
  end

  # D-882 (b): three sibling rotations of the bootstrap from C0 make three binding heads, so
  # CatalogTrust blocks as `control_history_limit`; the same page holds the honored R1 and K1.
  defp d882_control_history_limit do
    w = W.build()
    base = w.base

    rotations =
      for i <- 1..3 do
        new = Identity.from_seed("catalog", "r316-d882-rotation-#{i}")

        rotation = %{
          version: 1,
          product: :treehouse,
          space: base.replica,
          bootstrap: base.boot.id,
          parent: base.boot.id,
          prior_catalog: F.cid(w.c0),
          generation: 1,
          new_catalog_key: new.pub,
          nonce: F.id("d882-rotation-#{i}"),
          inventory_digest: TransportCatalog.inventory_id(w.c0.catalog.entries),
          cutoffs: [w.proof.cutoff]
        }

        CatalogTrustVectors.artifact_json(%{
          rotation: rotation,
          old_signature: Identity.sign(base.catalog, TransportCatalog.rotation_bytes(rotation)),
          new_signature: Identity.sign(new, TransportCatalog.rotation_possession_bytes(rotation))
        })
      end

    page = W.page(logs: [W.with_ops(base, [w.r1])], proofs: [w.proof], catalogs: [w.k1])

    d881_run(w, "d882_control_history_limit", %{}, [
      {"install C0", W.page(catalogs: [w.c0], logs: [base.log]), :eval},
      {"3 rotations + R1 + K1", %{page | rotations: rotations}, :eval}
    ])
  end

  # Each step either evaluates through the composed evaluator (`:eval`, with a view) or goes
  # through `CatalogTrust` alone and is wrapped (`:trust`, no view), as the TS consumer does.
  defp d881_views(run) do
    {_state, views} =
      Enum.reduce(run.steps, {W.install(run.world), []}, fn {_title, page, mode}, {state, acc} ->
        case mode do
          :trust ->
            %{next: trust} =
              CatalogTrust.evaluate(%{
                installed: state.trust,
                expected: @expected,
                incoming: page
              })

            {CatalogReplacementTrust.wrap(trust), acc ++ [nil]}

          :eval ->
            result = W.evaluate(state, page)
            view = W.view(result, run.labels, run.world.base.record.catalog_key)
            {W.persist(state, result), acc ++ [view |> Jason.encode!() |> Jason.decode!()]}
        end
      end)

    views
  end

  defp d881_run(w, name, labels, steps),
    do: %{name: name, world: w, history: w.h0, labels: Map.merge(w.labels, labels), steps: steps}

  # Finding 1: C0 (Space), C1 adds Thread T at /b, C2 moves T to /b2, all accepted through
  # CatalogTrust and wrapped. R cites {bootstrap, nil}; its descendant R2 carries T on a fresh
  # route and a second Thread at /b. /b was served under C1, so K2 is a rollback and the client
  # stays frozen.
  defp d881_moved_route do
    w = W.build()
    base = w.base
    [space] = w.c0.catalog.entries
    t = Map.fetch!(base.threads, "thread")
    t2 = Map.fetch!(base.threads, "thread2")
    route_b = "/r/" <> F.id("d881-b")
    route_b2 = "/r/" <> F.id("d881-b2")

    c1 =
      F.catalog(base, base.boot.id, 1, F.cid(w.c0), base.catalog, [
        space,
        at(base, space, "thread", route_b)
      ])

    c2 =
      F.catalog(base, base.boot.id, 2, F.cid(c1), base.catalog, [
        space,
        at(base, space, "thread", route_b2)
      ])

    r = F.replacement(base, base.log, "d881-r")
    lr = W.with_ops(base, [r.op])

    {:ok, %{cutoff: space_cut}} = Treehouse.CatalogCutoff.derive(lr)
    {:ok, %{cutoff: t_cut}} = Treehouse.CatalogCutoff.derive(t.log)
    {:ok, %{cutoff: t2_cut}} = Treehouse.CatalogCutoff.derive(t2.log)

    # R2's entries move onto R2's own service pair (F.replacement's default for "d881-r2").
    {sid, skey} = {F.id("service-id-d881-r2"), F.identity("service-d881-r2").pub}

    r2_entries =
      for e <- [
            space,
            at(base, space, "thread", "/r/" <> F.id("d881-fresh")),
            at(base, space, "thread2", route_b)
          ],
          do: %{e | service_id: sid, service_key: skey}

    r2 =
      F.replacement(base, lr, "d881-r2",
        parents: [r.id],
        prior_catalogs: [%{binding: r.id, catalog: nil}],
        generation: 2,
        entries: r2_entries,
        claim: %{cutoffs: Enum.sort_by([space_cut, t_cut, t2_cut], & &1.replica)}
      )

    k2 = F.first(base, r2)
    l2 = W.with_ops(base, [r.op, r2.op])
    raw = &CatalogTrustVectors.raw_history/1

    proofs = [
      w.proof,
      %{cutoff: space_cut, history: raw.(lr)},
      %{cutoff: t_cut, history: raw.(t.log)},
      %{cutoff: t2_cut, history: raw.(t2.log)}
    ]

    labels = %{
      F.cid(c1) => "C1",
      F.cid(c2) => "C2",
      r.id => "R",
      r2.id => "R2",
      F.cid(k2) => "K2"
    }

    steps = [
      {"C0 via trust", W.page(catalogs: [w.c0], logs: [base.log]), :trust},
      {"C1 via trust", W.page(catalogs: [c1], logs: [base.log, t.log]), :trust},
      {"C2 via trust", W.page(catalogs: [c2]), :trust},
      {"R + R2 + K2", W.page(catalogs: [k2], logs: [l2, t2.log], proofs: proofs), :eval}
    ]

    trust =
      Enum.reduce(Enum.take(steps, 3), W.install(w).trust, fn {_, page, :trust}, state ->
        %{next: next} =
          CatalogTrust.evaluate(%{installed: state, expected: @expected, incoming: page})

        next
      end)

    # The same history through the composed evaluator alone, C1 and C2 on one page: the mirrored
    # watermark must keep /b too, not only the routes CatalogTrust serves for C2.
    one_page = [
      {"C0", W.page(catalogs: [w.c0], logs: [base.log]), :eval},
      {"C1 + C2", W.page(catalogs: [c1, c2], logs: [base.log, t.log]), :eval},
      List.last(steps)
    ]

    %{
      run: d881_run(w, "d881_moved_route", labels, steps),
      one_page: d881_run(w, "d881_moved_route_one_page", labels, one_page),
      trust: trust,
      route_b: route_b,
      route_b2: route_b2,
      thread_replica: t.replica
    }
  end

  defp at(base, space, pool, route), do: F.pool_thread(base, %{space | route: route}, pool)

  # Finding 2: an admin-signed `{:replace_catalog_v1, [], "extra"}` command after C0.
  defp d881_three_tuple do
    w = W.build()
    base = w.base

    op =
      Op.new(
        base.admin,
        base.replica,
        Log.frontier(base.log),
        :command,
        {:replace_catalog_v1, [], "extra"},
        cap: base.delegation.id
      )

    d881_run(w, "d881_three_tuple", %{}, [
      {"install C0", W.page(catalogs: [w.c0], logs: [base.log]), :eval},
      {"three-tuple op", W.page(logs: [W.with_ops(base, [op])], proofs: [w.proof]), :eval}
    ])
  end

  # Finding 3: an admin-signed `{:replace_catalog_v1, [claim]}` (one argument, not three) and a
  # catalog signed by that claim's catalog key, bound to the op's id.
  defp d881_one_argument do
    w = W.build()
    base = w.base
    r = F.replacement(base, base.log, "d881-one")

    op =
      Op.new(
        base.admin,
        base.replica,
        Log.frontier(base.log),
        :command,
        {:replace_catalog_v1, [r.claim]},
        cap: base.delegation.id
      )

    k = F.catalog(base, op.id, 0, nil, r.catalog_key, r.entries)

    d881_run(w, "d881_one_argument", %{op.id => "R1arg", F.cid(k) => "K1arg"}, [
      {"install C0", W.page(catalogs: [w.c0], logs: [base.log]), :eval},
      {"one-argument op + K",
       W.page(logs: [W.with_ops(base, [op])], proofs: [w.proof], catalogs: [k]), :eval}
    ])
  end

  # --- rows 526 and 527: rotations under a replacement, and catalogs held before their rotation -

  describe "rows 526 and 527" do
    setup do
      w = W.build()
      base = w.base
      log = W.with_ops(base, [w.r1])
      d1 = W.install(w) |> W.evaluate(W.page(catalogs: [w.c0], logs: [base.log]))
      accepted = W.evaluate(d1.next, W.page(logs: [log], proofs: [w.proof], catalogs: [w.k1]))
      t2 = W.rotation(w, %{id: w.r1.id, generation: 1}, w.k1, w.new_catalog, "t2")
      k2 = F.catalog(base, t2.id, 0, nil, t2.key, w.k1.catalog.entries)
      labels = Map.merge(w.labels, %{t2.id => "T2", F.cid(k2) => "K2"})

      %{
        w: w,
        log: log,
        d1: d1,
        accepted: accepted,
        t2: t2,
        k2: k2,
        labels: labels,
        old: base.record.catalog_key
      }
    end

    test "T2 and K2 on one page advance R1/K1 to T2/K2 at the replacement's origin", c do
      result = W.evaluate(c.accepted.next, W.page(rotations: [c.t2.envelope], catalogs: [c.k2]))
      v = W.view(result, c.labels, c.old)
      assert {v["accepted"], v["origin"], v["routes"]} == {"T2/K2", "wss://r1-relay.invalid", 1}
      assert result.kind == :propose
      assert result.next.extra.rotations == [c.t2.json]
    end

    test "T2 and K2 converge in every delivery order", c do
      t2 = W.page(rotations: [c.t2.envelope])
      k2 = W.page(catalogs: [c.k2])
      both = W.page(rotations: [c.t2.envelope], catalogs: [c.k2])

      finals =
        for pages <- [[t2, k2], [k2, t2], [both]] do
          Enum.reduce(pages, c.accepted, fn page, d ->
            result = W.evaluate(d.next, page)
            refute result.kind == :reject
            result
          end)
        end

      views = Enum.map(finals, &W.view(&1, c.labels, c.old))
      assert [%{"accepted" => "T2/K2", "routes" => 1} | _] = views
      assert views |> Enum.uniq() |> length() == 1
      assert finals |> Enum.map(& &1.next.binding) |> Enum.uniq() |> length() == 1
    end

    test "T2 without K2 keeps R1/K1 served and waits", c do
      result = W.evaluate(c.accepted.next, W.page(rotations: [c.t2.envelope]))
      v = W.view(result, c.labels, c.old)
      assert {v["accepted"], v["origin"], v["routes"]} == {"R1/K1", "wss://r1-relay.invalid", 1}
      assert result.reason == :trust_pending
      assert result.routes == c.accepted.routes
    end

    test "a forged T2 variant is dropped and the authentic T2 still advances", c do
      forged = %{c.t2.envelope | new_signature: <<7, 0::size(504)>>}
      dropped = W.evaluate(c.accepted.next, W.page(rotations: [forged]))
      refute dropped.kind == :reject
      refute Map.has_key?(dropped.next.extra, :rotations)
      assert W.view(dropped, c.labels, c.old)["accepted"] == "R1/K1"

      advanced =
        W.evaluate(dropped.next, W.page(rotations: [c.t2.envelope], catalogs: [c.k2]))

      assert W.view(advanced, c.labels, c.old)["accepted"] == "T2/K2"
      assert advanced.next.extra.rotations == [c.t2.json]
    end

    test "a rotation under a non-admin replacement serves nothing", c do
      %{w: w, d1: d1} = c
      kn = F.first(w.base, w.rn)
      tn = W.rotation(w, %{id: w.rn.id, generation: 1}, kn, w.rn.catalog_key, "t2n")
      k2n = F.catalog(w.base, tn.id, 0, nil, tn.key, kn.catalog.entries)

      page =
        W.page(
          logs: [W.with_ops(w.base, [w.rn.op])],
          proofs: [w.proof],
          rotations: [tn.envelope],
          catalogs: [kn, k2n]
        )

      result = W.evaluate(d1.next, page)
      v = W.view(result, c.labels, c.old)
      assert "catalog_authority_refused" in v["refused"]
      assert v["accepted"] == "B/C0"
      assert result.routes == d1.routes
    end

    test "an old-key rotation under a replacement closed by an admin R2 is never served", c do
      %{w: w, log: log, accepted: accepted} = c
      base = w.base

      r2 =
        F.replacement(base, log, "r526-r2",
          parents: [w.r1.id],
          prior_catalogs: [%{binding: w.r1.id, catalog: F.cid(w.k1)}],
          generation: 2
        )

      k2r = F.first(base, r2)
      l2 = W.with_ops(base, [w.r1, r2.op])
      {:ok, %{cutoff: cut}} = Treehouse.CatalogCutoff.derive(log)
      proof = %{cutoff: cut, history: CatalogTrustVectors.raw_history(log)}
      closed = W.evaluate(accepted.next, W.page(logs: [l2], proofs: [proof], catalogs: [k2r]))
      labels = Map.merge(c.labels, %{r2.id => "R2", F.cid(k2r) => "K2r"})
      assert W.view(closed, labels, c.old)["accepted"] == "R2/K2r"

      tr = W.rotation(w, %{id: w.r1.id, generation: 1}, w.k1, w.new_catalog, "tr")
      ktr = F.catalog(base, tr.id, 0, nil, tr.key, w.k1.catalog.entries)

      for pages <- [
            [W.page(rotations: [tr.envelope], catalogs: [ktr])],
            [W.page(catalogs: [ktr]), W.page(rotations: [tr.envelope])]
          ] do
        last = Enum.reduce(pages, closed, &W.evaluate(&2.next, &1))
        refute last.kind == :reject
        assert W.view(last, labels, c.old)["accepted"] == "R2/K2r"
        refute Enum.any?(last.routes, &(&1.binding == tr.id or &1.catalog == F.cid(ktr)))
      end
    end

    test "after a revoke freeze, T2 and K2 serve nothing", c do
      %{w: w, log: log, accepted: accepted} = c
      rv = F.revoke(w.base, Log.frontier(w.base.log), w.base.delegation.id)
      frozen = W.evaluate(accepted.next, W.page(logs: [Log.append!(log, rv)]))
      assert frozen.routes == []

      result = W.evaluate(frozen.next, W.page(rotations: [c.t2.envelope], catalogs: [c.k2]))
      assert result.routes == []
      assert result.next.binding.frozen or result.next.trust.blocked != nil
    end

    # The block is CatalogTrust's old-key `catalog_fork` (the World has no served Thread whose
    # authority could change); it takes the same blocked branch as an `authority_changed` block.
    test "a CatalogTrust block never overwrites the graph's watermark on T2", c do
      %{w: w} = c
      base = w.base
      advanced = W.evaluate(c.accepted.next, W.page(rotations: [c.t2.envelope], catalogs: [c.k2]))
      assert W.view(advanced, c.labels, c.old)["accepted"] == "T2/K2"

      moved = Enum.map(F.base_entries(base), &%{&1 | route: "/r/" <> F.id("r526-sibling")})
      c1 = F.catalog(base, base.boot.id, 1, F.cid(w.c0), base.catalog, F.base_entries(base))
      c1b = F.catalog(base, base.boot.id, 1, F.cid(w.c0), base.catalog, moved)
      blocked = W.evaluate(advanced.next, W.page(catalogs: [c1, c1b]))
      assert blocked.trust_decision.reason == :catalog_fork
      assert blocked.next.binding.accepted.binding == c.t2.id
      assert blocked.next.binding.accepted.catalog == F.cid(c.k2)
      assert blocked.routes == []
      assert blocked.next.routes == []
    end

    test "an orphan rotation and a rotation before its op are refused as CatalogTrust refuses",
         c do
      %{w: w, d1: d1, accepted: accepted} = c
      orphan = W.rotation(w, %{id: F.id("r526-nowhere"), generation: 1}, w.k1, w.new_catalog, "o")

      for {state, page} <- [
            {accepted.next, W.page(rotations: [orphan.envelope])},
            {d1.next, W.page(rotations: [c.t2.envelope], catalogs: [c.k2])}
          ] do
        result = W.evaluate(state, page)
        assert %{kind: :reject, reason: :trust_pending} = result

        assert result ==
                 CatalogTrust.evaluate(%{
                   installed: state.trust,
                   expected: @expected,
                   incoming: page
                 })
      end
    end

    test "a rotation under a replace_catalog_v1 command of the wrong arity is dropped", c do
      %{w: w, d1: d1} = c
      base = w.base
      r = F.replacement(base, base.log, "r526-one")

      op =
        Op.new(
          base.admin,
          base.replica,
          Log.frontier(base.log),
          :command,
          {:replace_catalog_v1, [r.claim]},
          cap: base.delegation.id
        )

      k = F.catalog(base, op.id, 0, nil, r.catalog_key, r.entries)
      t = W.rotation(w, %{id: op.id, generation: 1}, k, r.catalog_key, "one")

      page =
        W.page(
          logs: [W.with_ops(base, [op])],
          proofs: [w.proof],
          catalogs: [k],
          rotations: [t.envelope]
        )

      result = W.evaluate(d1.next, page)
      refute result.kind == :reject
      refute Map.has_key?(result.next.extra, :rotations)
      assert W.view(result, c.labels, c.old)["accepted"] == "B/C0"
    end

    test "a sidecar without rotations keeps the saved shape", c do
      assert c.d1.next.extra == %{catalogs: []}
      assert Map.keys(c.accepted.next.extra) == [:catalogs]
      saved = %{c.accepted.next | extra: %{catalogs: c.accepted.next.extra.catalogs}}
      assert W.evaluate(saved, W.page()) == W.evaluate(c.accepted.next, W.page())
    end
  end

  describe "row 527: a catalog held before its rotation" do
    setup do
      %{f: CatalogTrustVectors.fixture(1)}
    end

    test "CT then T reaches the one-page state", %{f: f} do
      {t, key} = rotation(f, f.catalog_envelope, "r527")
      ct = first_under(f, t, key, f.catalog.entries)
      wrapped = CatalogReplacementTrust.wrap(install(f))

      eval =
        &CatalogReplacementTrust.evaluate(%{installed: &1, expected: @expected, incoming: &2})

      held = eval.(wrapped, page(catalogs: [ct]))
      assert held.reason == :trust_pending
      assert length(held.next.extra.catalogs) == 1

      done = eval.(held.next, page(rotations: [t], proofs: f.cutoff_proofs))
      together = eval.(wrapped, page(rotations: [t], catalogs: [ct], proofs: f.cutoff_proofs))
      assert done.next.trust.accepted.binding == TransportCatalog.rotation_id(t)
      assert done.next.trust.accepted.catalog == TransportCatalog.catalog_id(ct.catalog)
      assert done.next.extra.catalogs == []
      assert done.next.trust == together.next.trust
      assert done.routes == together.routes
    end

    test "a junk catalog held under T is dropped and T is still retained", %{f: f} do
      {t, _key} = rotation(f, f.catalog_envelope, "r527-junk")
      junk_key = Identity.from_seed("junk", "r527-junk-key")

      junk =
        CatalogTrustVectors.sign_catalog(
          %{f.catalog | binding: TransportCatalog.rotation_id(t), revision: 0, previous: nil},
          junk_key
        )

      wrapped = CatalogReplacementTrust.wrap(install(f))

      eval =
        &CatalogReplacementTrust.evaluate(%{installed: &1, expected: @expected, incoming: &2})

      held = eval.(wrapped, page(catalogs: [junk]))
      assert length(held.next.extra.catalogs) == 1

      t_page = page(rotations: [t], proofs: f.cutoff_proofs)

      assert %{kind: :reject} =
               CatalogTrust.evaluate(%{
                 installed: held.next.trust,
                 expected: @expected,
                 incoming: %{t_page | catalogs: held.next.extra.catalogs}
               })

      done = eval.(held.next, t_page)
      refute done.kind == :reject
      assert Enum.map(done.next.trust.rotations, & &1.id) == [TransportCatalog.rotation_id(t)]
      assert done.next.extra.catalogs == []
      assert done.next.trust == eval.(wrapped, t_page).next.trust
    end
  end
end
