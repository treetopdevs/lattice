defmodule Treehouse.CatalogReplacementTrustDemoTest do
  @moduledoc """
  Plan 316 row 316: the runnable demonstration. A client that already trusts the base catalog
  accepts a replacement catalog signed by an authorized admin with a new key, without the old
  catalog signer's key, and refuses one signed by a non-admin. The same pages replay through the
  TS composed evaluator and both runtimes must print the same lines. Disposable keys only; no
  production caller exists and nothing is dialled.

  Run with `scripts/treehouse_replacement_demo.sh` (needs Node 22 for the TS half).
  """
  use ExUnit.Case, async: false

  alias Lattice.Carrier.Wire
  alias Treehouse.{CatalogReplacementTrust, CatalogTrust, CatalogTrustVectors, TransportCatalog}
  alias Treehouse.CatalogReplacementWorld, as: W

  @moduletag :replacement_demo
  @moduletag timeout: 180_000

  @ts_dir Path.expand("../../../../clients/lattice-client", __DIR__)

  test "admin replacement accepted without the old key; non-admin refused; BEAM equals TS" do
    w = W.build()
    base = w.base
    old_key = base.record.catalog_key
    r = rotation_world(w)
    labels = Map.merge(w.labels, r.labels)

    log_r1 = W.with_ops(base, [w.r1])
    log_rn = W.with_ops(base, [w.rn.op])

    page_c0 = W.page(catalogs: [w.c0], logs: [base.log])
    page_r1 = W.page(catalogs: [w.k1], logs: [log_r1], proofs: [w.proof])
    page_rn = W.page(logs: [log_rn], proofs: [w.proof])

    # (ii) R1 is authored by the admin; the new catalog key signs K1; the old key signs nothing.
    assert w.r1.author == base.admin.pub

    {:ok, k1_envelope} =
      TransportCatalog.decode_catalog_json(Treehouse.CatalogTrustVectors.artifact_json(w.k1))

    assert TransportCatalog.verify_catalog(k1_envelope, w.new_catalog.pub) == :ok

    assert TransportCatalog.verify_catalog(k1_envelope, old_key) ==
             {:error, :invalid_catalog_signature}

    refute w.new_catalog.pub == old_key
    refute w.r1.author == old_key

    # (i) install and deliver C0.
    installed = W.install(w)
    d1 = W.evaluate(installed, page_c0)
    v1 = W.view(d1, labels, old_key)
    assert {v1["accepted"], v1["origin"], v1["routes"]} == {"B/C0", "wss://base-relay.invalid", 1}

    # (iii, iv) R1 and K1 together: accepted, every route is at the new origin.
    d2 = W.evaluate(d1.next, page_r1)
    v2 = W.view(d2, labels, old_key)
    assert v2["accepted"] == "R1/K1"
    assert v2["routes"] == 1 and v2["urls"] != []
    assert Enum.all?(d2.routes, &String.starts_with?(&1.url, "wss://r1-relay.invalid"))
    assert v2["old_key_used"] == false

    # (v) separate run: a non-admin's Rn is refused; the watermark and old routes are kept.
    d3 = W.evaluate(d1.next, page_rn)
    v3 = W.view(d3, labels, old_key)
    assert v3["refused"] == ["catalog_authority_refused"]

    assert {v3["accepted"], v3["origin"], v3["frozen"]} ==
             {"B/C0", "wss://base-relay.invalid", false}

    assert d3.routes == d1.routes

    # The TS half replays the same pages: the three narrated steps plus unprinted runs for the
    # other delivery order, a repeated page and the revoke freeze.
    rv =
      Treehouse.CatalogBindingGraphFixtures.revoke(
        base,
        Lattice.Log.frontier(base.log),
        base.delegation.id
      )

    page_rv = W.page(logs: [Lattice.Log.append!(log_r1, rv)])
    page_both = W.page(catalogs: [w.k1], logs: [log_r1], proofs: [w.proof])

    junk_key = Lattice.Identity.from_seed("junk", "r316-demo-junk")
    junk_id = Treehouse.CatalogBindingGraphFixtures.id("no-such-binding")

    junk =
      Treehouse.CatalogBindingGraphFixtures.catalog(
        base,
        junk_id,
        0,
        nil,
        junk_key,
        Treehouse.CatalogBindingGraphFixtures.base_entries(base, "junk")
      )

    runs = [
      {"admin", [{"1 install C0", page_c0, true}, {"2 admin R1 + K1", page_r1, true}]},
      {"nonadmin", [{"install C0", page_c0, false}, {"3 non-admin Rn", page_rn, true}]},
      # Row 526: a rotation of the replacement R1 to a new catalog key, and its first catalog K2.
      {"rotation",
       [
         {"install C0", page_c0, false},
         {"R1 + K1", page_r1, false},
         {"4 R1 rotates to T2", r.page_t2k2, true},
         {"T2 + K2 again", r.page_t2k2, false}
       ]},
      # Row 527: a catalog CT held before its legacy rotation T arrives.
      {"ct_first",
       [
         {"install C0", page_c0, false},
         {"CT", W.page(catalogs: [r.ct]), false},
         {"5 CT before its T", r.page_t, true}
       ]},
      {"k2_first",
       [
         {"install C0", page_c0, false},
         {"R1 + K1", page_r1, false},
         {"K2", W.page(catalogs: [r.k2]), false},
         {"T2", W.page(rotations: [r.t2.envelope], proofs: [w.proof]), false}
       ]},
      {"rotation_bad_sig",
       [
         {"install C0", page_c0, false},
         {"R1 + K1", page_r1, false},
         {"forged T2", W.page(rotations: [r.forged_t2]), false},
         {"T2 + K2", r.page_t2k2, false}
       ]},
      {"rotation_wrong_arity",
       [{"install C0", page_c0, false}, {"one-argument op + K + rotation", r.page_arity, false}]},
      {"junk_before_t",
       [
         {"install C0", page_c0, false},
         {"junk catalog under T", W.page(catalogs: [r.junk_t]), false},
         {"T", r.page_t, false}
       ]},
      # Review round 1 of rows 526 and 527, replayed in both runtimes.
      {"rotation_three",
       [
         {"install C0", page_c0, false},
         {"R1 + K1", page_r1, false},
         {"T2 T3 T4 + K2 K3 K4", r.page_three, false}
       ]},
      {"legacy_two",
       [{"install C0", page_c0, false}, {"T TT + CT CTT", r.page_legacy_two, false}]},
      {"forged_parent_child",
       [
         {"install C0", page_c0, false},
         {"R1 + K1", page_r1, false},
         {"forged T2 + child U", W.page(rotations: [r.forged_t2, r.u.envelope]), false}
       ]},
      {"forged_held",
       [
         {"install C0", page_c0, false},
         {"CT + junk under T", W.page(catalogs: [r.ct, r.junk_t]), false},
         {"T", r.page_t, false}
       ]},
      {"forged_held_chain",
       [
         {"install C0", page_c0, false},
         {"CT + CT1 + junk", W.page(catalogs: [r.ct, r.ct1, r.junk_t]), false},
         {"T", r.page_t, false}
       ]},
      # Review round 2 of rows 526 and 527, replayed in both runtimes.
      {"held_revision_first",
       [
         {"install C0", page_c0, false},
         {"CT1", W.page(catalogs: [r.ct1]), false},
         {"T", r.page_t, false},
         {"CT", W.page(catalogs: [r.ct]), false}
       ]},
      {"blocked_orphan",
       [
         {"install C0", page_c0, false},
         {"C1 + C1b fork", r.page_fork, false},
         {"orphan rotation", W.page(rotations: [r.orphan.envelope]), false}
       ]},
      {"blocked_bad_rotation",
       [
         {"install C0", page_c0, false},
         {"C1 + C1b fork", r.page_fork, false},
         {"R1 + K1 + 63-byte rotation", r.page_bad_rotation, false},
         {"R1 + K1 + rotation without old_signature", r.page_no_signature, false},
         {"R1 + K1 + rotation with an extra key", r.page_extra_key, false}
       ]},
      # Review round 3 of rows 526 and 527 (security), replayed in both runtimes.
      {"held_fork_junk",
       [
         {"install C0", page_c0, false},
         {"CT + CT1 + CT1b + junk", W.page(catalogs: [r.ct, r.ct1, r.ct1b, r.junk_t]), false},
         {"T", r.page_t, false}
       ]},
      {"revive_bound",
       [
         {"install C0", page_c0, false},
         {"17 junk under T", W.page(catalogs: r.junks), false},
         {"T", r.page_t, false},
         {"empty", W.page(), false}
       ]},
      {"closed_unbound",
       [
         {"install C0", page_c0, false},
         {"R1 + K1", page_r1, false},
         {"TR", W.page(rotations: [r.tr.envelope]), false},
         {"R2 + K2r", r.page_r2, false}
       ]},
      {"nonadmin_unbound",
       [
         {"install C0", page_c0, false},
         {"Rn + Kn", r.page_rn, false},
         {"Tn", W.page(rotations: [r.tn.envelope]), false}
       ]},
      {"blocked_plain",
       [
         {"install C0", page_c0, false},
         {"C1 + C1b fork", r.page_fork, false},
         {"R1 + K1 + T", r.page_recover, false}
       ]},
      {"blocked_junk",
       [
         {"install C0", page_c0, false},
         {"C1 + C1b fork", r.page_fork, false},
         {"junk under T", W.page(catalogs: [r.junk_t]), false},
         {"R1 + K1 + T", r.page_recover, false}
       ]},
      # Review round 3 of rows 526 and 527, replayed in both runtimes.
      {"variant_fork",
       [
         {"install C0", page_c0, false},
         {"16 CT1 variants + CT1b", r.round3.page_variants, false},
         {"T + CT", r.round3.page_t_ct, false}
       ]},
      {"orphan_fork",
       [
         {"install C0", page_c0, false},
         {"CT + CT1 + CT1b", W.page(catalogs: [r.ct, r.ct1, r.ct1b]), false},
         {"T + orphan", r.round3.page_t_orphan, false}
       ]},
      {"limit_junk",
       [
         {"install C0", page_c0, false},
         {"C1 + C1b fork", r.page_fork, false},
         {"junk under T1", r.round3.page_limit_junk, false},
         {"T1 T2 T3 + R1 + K1", r.round3.page_limit, false}
       ]},
      {"blocked_pending",
       [
         {"install C0", page_c0, false},
         {"C1 + C1b fork", r.page_fork, false},
         {"CT1", W.page(catalogs: [r.ct1]), false},
         {"T", r.page_t, false}
       ]},
      {"rotation_closed_wire",
       [
         {"install C0", page_c0, false},
         {"R1 + K1", page_r1, false},
         {"T2 duplicate key + K2", r.round3.page_duplicate, false},
         {"T2 loose base64 + K2", r.round3.page_loose, false}
       ]},
      {"k1_first",
       [
         {"install C0", page_c0, false},
         {"K1", W.page(catalogs: [w.k1]), false},
         {"R1", W.page(logs: [log_r1], proofs: [w.proof]), false}
       ]},
      {"twice",
       [
         {"install C0", page_c0, false},
         {"R1 + K1", page_both, false},
         {"R1 + K1 again", page_both, false}
       ]},
      {"junk",
       [
         {"install C0", page_c0, false},
         {"junk catalog", W.page(catalogs: [junk]), false},
         {"R1 + K1", page_both, false}
       ]},
      {"freeze",
       [{"install C0", page_c0, false}, {"R1 + K1", page_both, false}, {"revoke", page_rv, false}]}
    ]

    beam_views =
      for {name, steps} <- runs, into: %{} do
        {_state, views} =
          Enum.reduce(steps, {W.install(w), []}, fn {_title, page, _print}, {state, acc} ->
            result = W.evaluate(state, page)
            {W.persist(state, result), acc ++ [json(W.view(result, labels, old_key))]}
          end)

        {name, views}
      end

    printed =
      for {name, steps} <- runs,
          {{title, _page, true}, v} <- Enum.zip(steps, beam_views[name]),
          do: {title, v}

    assert Enum.map(printed, &elem(&1, 0)) == [
             "1 install C0",
             "2 admin R1 + K1",
             "3 non-admin Rn",
             "4 R1 rotates to T2",
             "5 CT before its T"
           ]

    # Rows 526 and 527 on BEAM before TS must agree.
    assert [_, _, %{"accepted" => "T2/K2", "origin" => "wss://r1-relay.invalid"} = t2, again] =
             beam_views["rotation"]

    assert {t2["routes"], again["kind"]} == {1, "unchanged"}
    assert List.last(beam_views["k2_first"]) == Map.put(t2, "kind", "propose")
    assert List.last(beam_views["rotation_bad_sig"])["accepted"] == "T2/K2"
    assert [_, %{"accepted" => "B/C0", "sidecar" => 0}] = beam_views["rotation_wrong_arity"]

    assert [_, %{"accepted" => "B/C0", "sidecar" => 1}, %{"accepted" => "T/CT", "sidecar" => 0}] =
             beam_views["ct_first"]

    assert [_, %{"sidecar" => 1}, %{"accepted" => "B/C0", "sidecar" => 0}] =
             beam_views["junk_before_t"]

    # Review round 1, asserted on BEAM before TS must agree.
    assert List.last(beam_views["rotation_three"])["accepted"] == "T4/K4"

    assert List.last(beam_views["legacy_two"]) |> Map.take(["accepted", "sidecar"]) ==
             %{"accepted" => "TT/CTT", "sidecar" => 0}

    assert %{"reason" => "trust_pending", "sidecar_rotations" => 1, "accepted" => "R1/K1"} =
             List.last(beam_views["forged_parent_child"])

    assert %{"accepted" => "T/CT", "sidecar" => 0} = List.last(beam_views["forged_held"])
    assert %{"accepted" => "T/CT1", "sidecar" => 0} = List.last(beam_views["forged_held_chain"])

    assert %{"accepted" => "T/CT1", "sidecar" => 0, "reason" => nil} =
             List.last(beam_views["held_revision_first"])

    assert %{"kind" => "retain_blocked", "routes" => 0, "sidecar_rotations" => 0} =
             List.last(beam_views["blocked_orphan"])

    assert %{"accepted" => "B/C0", "routes" => 0, "sidecar" => 1} =
             List.last(beam_views["blocked_bad_rotation"])

    assert %{"kind" => "retain_blocked", "reason" => "catalog_fork", "routes" => 0} =
             List.last(beam_views["held_fork_junk"])

    assert [_, %{"sidecar" => 17}, %{"sidecar" => 1}, %{"sidecar" => 0, "accepted" => "B/C0"}] =
             beam_views["revive_bound"]

    assert %{"accepted" => "R2/K2r", "reason" => nil} = List.last(beam_views["closed_unbound"])
    [_, rn, tn] = beam_views["nonadmin_unbound"]
    assert tn["reason"] == rn["reason"]
    assert List.last(beam_views["blocked_junk"]) == List.last(beam_views["blocked_plain"])

    # Review round 3, asserted on BEAM before TS must agree.
    for name <- ["variant_fork", "orphan_fork"] do
      assert %{"kind" => "retain_blocked", "reason" => "catalog_fork", "routes" => 0} =
               List.last(beam_views[name])
    end

    assert %{"reason" => "control_history_limit", "routes" => 0} =
             List.last(beam_views["limit_junk"])

    assert %{"sidecar" => 1, "routes" => 0} = List.last(beam_views["blocked_pending"])

    assert [_, _, %{"kind" => "reject", "reason" => "malformed_catalog"} = dup, loose] =
             beam_views["rotation_closed_wire"]

    assert loose == dup

    # The order, repeat and freeze runs, asserted on BEAM before TS must agree.
    assert [_, %{"accepted" => "B/C0"}, %{"accepted" => "R1/K1", "frozen" => false}] =
             beam_views["k1_first"]

    assert [_, %{"accepted" => "R1/K1"}, %{"accepted" => "R1/K1"} = again] = beam_views["twice"]
    assert again["kind"] == "unchanged"
    assert Map.delete(again, "kind") == Map.delete(Enum.at(beam_views["twice"], 1), "kind")

    assert [_, %{"accepted" => "B/C0", "routes" => 1}, %{"accepted" => "R1/K1", "routes" => 1}] =
             beam_views["junk"]

    assert [_, _, %{"frozen" => true, "routes" => 0, "origin" => nil}] = beam_views["freeze"]

    # Review findings of the composed evaluator, replayed in both runtimes (Codex round, row 395
    # follow-up): each run carries its own history; a `:trust` step goes through `CatalogTrust`
    # alone and is wrapped with the public `wrap/1`, and has no view.
    extra_runs = extra_runs(w)

    extra_views =
      for run <- extra_runs, into: %{} do
        {_state, views} =
          Enum.reduce(run.steps, {run.install, []}, fn {_title, page, mode}, {state, acc} ->
            case mode do
              :trust ->
                %{next: trust} =
                  CatalogTrust.evaluate(%{
                    installed: state.trust,
                    expected: W.expected(),
                    incoming: page
                  })

                {CatalogReplacementTrust.wrap(trust), acc ++ [nil]}

              :eval ->
                result = W.evaluate(state, page)
                {W.persist(state, result), acc ++ [json(W.view(result, labels, run.old_key))]}
            end
          end)

        {run.name, views}
      end

    assert [_, _, %{"accepted" => "R1/K1", "frozen" => false}, again, %{"kind" => "unchanged"}] =
             extra_views["forged_after"]

    assert again["kind"] == "unchanged"

    assert [_, _, %{"accepted" => "B/C0"}, %{"accepted" => "R1/K1", "routes" => 1}] =
             extra_views["forged_first"]

    assert [nil, nil, %{"reason" => "authority_changed", "frozen" => true, "routes" => 0}] =
             extra_views["wrap_watermark"]

    assert [
             %{"routes" => 2},
             %{"kind" => "retain_blocked", "reason" => "authority_changed", "routes" => 0},
             %{"kind" => "retain_blocked", "reason" => "authority_changed", "routes" => 0} = last
           ] = extra_views["malformed_block"]

    assert last["frozen"] == false

    assert [_, %{"kind" => "retain_blocked", "reason" => "authority_changed"} = blocked] =
             extra_views["orphan_authority"]

    assert {blocked["routes"], blocked["sidecar_rotations"]} == {0, 0}
    beam_views = Map.merge(beam_views, extra_views)

    path =
      Path.join(System.tmp_dir!(), "replacement-demo-#{System.unique_integer([:positive])}.json")

    doc = %{
      "format" => "lattice-replacement-demo-v1",
      "history" => w.h0,
      "labels" => labels,
      "runs" =>
        for {name, steps} <- runs do
          %{
            "name" => name,
            "steps" =>
              Enum.map(steps, fn {title, page, print?} ->
                %{"title" => title, "print" => print?, "page" => W.page_json(page)}
              end)
          }
        end ++
          for run <- extra_runs do
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
        cd: @ts_dir,
        stderr_to_stdout: true
      )

    assert status == 0, out
    lines = String.split(out, "\n", trim: true)
    {[views], ts_lines} = Enum.split_with(lines, &String.starts_with?(&1, "VIEWS "))
    ts = views |> String.replace_prefix("VIEWS ", "") |> Jason.decode!()

    IO.puts("")
    for {title, v} <- printed, do: IO.puts("[beam] " <> W.line(title, v))
    for line <- ts_lines, do: IO.puts(line)
    IO.puts("BEAM == TS: #{if ts == beam_views, do: "ok", else: "MISMATCH"}")
    assert ts == beam_views
  end

  defp extra_runs(w) do
    base = w.base
    log_r1 = W.with_ops(base, [w.r1])
    page_c0 = W.page(catalogs: [w.c0], logs: [base.log])
    page_both = W.page(catalogs: [w.k1], logs: [log_r1], proofs: [w.proof])
    forged = %{w.k1 | signature: <<207, 0::size(504)>>}

    # P2: wrap carries the accepted watermark. C0, then a valid C1 adding a Thread, through
    # CatalogTrust alone; R1 cites C0 and K1 holds only the Space.
    thread = Map.fetch!(base.threads, "thread")
    space_entry = hd(w.c0.catalog.entries)
    alias Treehouse.CatalogBindingGraphFixtures, as: F
    thread_entry = F.pool_thread(base, %{space_entry | route: "/r/" <> F.id("t-route")}, "thread")
    c1 = F.catalog(base, base.boot.id, 1, F.cid(w.c0), base.catalog, [space_entry, thread_entry])

    # P1: a blocked CatalogTrust state and a malformed replacement command.
    f = CatalogTrustVectors.fixture(1)
    thread_log = W.thread_transfer_log(hd(f.threads))
    fixture_install = fixture_install(f)

    plain = fn history ->
      %{catalogs: [], rotations: [], histories: [history], cutoff_proofs: []}
    end

    [
      %{
        name: "forged_after",
        history: w.h0,
        install: W.install(w),
        old_key: base.record.catalog_key,
        steps: [
          {"install C0", page_c0, :eval},
          {"R1 + K1", page_both, :eval},
          {"forged K1", W.page(catalogs: [forged]), :eval},
          {"forged K1 again", W.page(catalogs: [forged]), :eval},
          {"authentic K1", W.page(catalogs: [w.k1]), :eval}
        ]
      },
      %{
        name: "forged_first",
        history: w.h0,
        install: W.install(w),
        old_key: base.record.catalog_key,
        steps: [
          {"install C0", page_c0, :eval},
          {"R1 + forged K1", W.page(catalogs: [forged], logs: [log_r1], proofs: [w.proof]),
           :eval},
          {"nothing new", W.page(), :eval},
          {"K1", W.page(catalogs: [w.k1]), :eval}
        ]
      },
      %{
        name: "wrap_watermark",
        history: w.h0,
        install: W.install(w),
        old_key: base.record.catalog_key,
        steps: [
          {"C0 via trust", page_c0, :trust},
          {"C1 via trust", W.page(catalogs: [c1], logs: [base.log, thread.log]), :trust},
          {"R1 + K1", page_both, :eval}
        ]
      },
      %{
        name: "orphan_authority",
        history: hd(f.histories),
        install: fixture_install,
        old_key: f.space.catalog.pub,
        steps: [
          {"accept catalog",
           %{
             catalogs: [f.catalog_json],
             rotations: [],
             histories: f.histories,
             cutoff_proofs: []
           }, :eval},
          {"thread transfer + orphan rotation",
           %{
             plain.(CatalogTrustVectors.raw_history(thread_log))
             | rotations: [CatalogTrustVectors.artifact_json(fixture_orphan(f))]
           }, :eval}
        ]
      },
      %{
        name: "malformed_block",
        history: hd(f.histories),
        install: fixture_install,
        old_key: f.space.catalog.pub,
        steps: [
          {"accept catalog",
           %{
             catalogs: [f.catalog_json],
             rotations: [],
             histories: f.histories,
             cutoff_proofs: []
           }, :eval},
          {"thread transfer", plain.(CatalogTrustVectors.raw_history(thread_log)), :eval},
          {"malformed replace",
           plain.(
             CatalogTrustVectors.raw_history(
               W.with_malformed_replace(f.space_log, f.space.replica)
             )
           ), :eval}
        ]
      }
    ]
  end

  # Rows 526 and 527: T2 rotates R1 (from K1, signed by K1's key) and K2 is its first catalog; T
  # rotates the bootstrap (from C0, signed by the base catalog key) and CT is its first catalog.
  defp rotation_world(w) do
    alias Treehouse.CatalogBindingGraphFixtures, as: F
    base = w.base
    t2 = W.rotation(w, %{id: w.r1.id, generation: 1}, w.k1, w.new_catalog, "demo-t2")
    k2 = F.catalog(base, t2.id, 0, nil, t2.key, w.k1.catalog.entries)
    t = W.rotation(w, %{id: base.boot.id, generation: 0}, w.c0, base.catalog, "demo-t")
    ct = F.catalog(base, t.id, 0, nil, t.key, w.c0.catalog.entries)
    junk_key = Lattice.Identity.from_seed("junk", "r527-demo-junk")
    junk_t = F.catalog(base, t.id, 0, nil, junk_key, w.c0.catalog.entries)

    one = F.replacement(base, base.log, "r526-demo-one")

    op =
      Lattice.Op.new(
        base.admin,
        base.replica,
        Lattice.Log.frontier(base.log),
        :command,
        {:replace_catalog_v1, [one.claim]},
        cap: base.delegation.id
      )

    review = review_world(w, t2, k2, t, ct)
    k_one = F.catalog(base, op.id, 0, nil, one.catalog_key, one.entries)
    t_one = W.rotation(w, %{id: op.id, generation: 1}, k_one, one.catalog_key, "demo-one")

    %{
      t2: t2,
      k2: k2,
      ct: ct,
      junk_t: junk_t,
      forged_t2: %{t2.envelope | new_signature: <<7, 0::size(504)>>},
      page_t2k2: W.page(rotations: [t2.envelope], catalogs: [k2], proofs: [w.proof]),
      page_t: W.page(rotations: [t.envelope], proofs: [w.proof]),
      page_arity:
        W.page(
          logs: [W.with_ops(base, [op])],
          proofs: [w.proof],
          catalogs: [k_one],
          rotations: [t_one.envelope]
        ),
      labels:
        Map.merge(
          %{t2.id => "T2", F.cid(k2) => "K2", t.id => "T", F.cid(ct) => "CT"},
          review.labels
        )
    }
    |> then(&Map.merge(review, &1))
  end

  # Review round 1: three rotations under R1, two legacy rotations, a child of a forged rotation,
  # an unbound rotation later closed out by R2 or under a non-admin Rn, and a block.
  defp review_world(w, t2, k2, t, ct) do
    alias Treehouse.CatalogBindingGraphFixtures, as: F
    base = w.base
    t3 = W.rotation(w, %{id: t2.id, generation: 2}, k2, t2.key, "demo-t3")
    k3 = F.catalog(base, t3.id, 0, nil, t3.key, k2.catalog.entries)
    t4 = W.rotation(w, %{id: t3.id, generation: 3}, k3, t3.key, "demo-t4")
    k4 = F.catalog(base, t4.id, 0, nil, t4.key, k3.catalog.entries)
    ct1 = F.catalog(base, t.id, 1, F.cid(ct), t.key, ct.catalog.entries)
    moved = Enum.map(ct.catalog.entries, &%{&1 | route: "/r/" <> F.id("demo-ct1b")})
    ct1b = F.catalog(base, t.id, 1, F.cid(ct), t.key, moved)

    junks =
      for i <- 1..17,
          do:
            F.catalog(
              base,
              t.id,
              0,
              nil,
              Lattice.Identity.from_seed("junk", "demo-bound-#{i}"),
              ct.catalog.entries
            )

    tt = W.rotation(w, %{id: t.id, generation: 1}, ct, t.key, "demo-tt")
    ctt = F.catalog(base, tt.id, 0, nil, tt.key, ct.catalog.entries)
    forged = %{t2.envelope | new_signature: <<7, 0::size(504)>>}
    u = W.rotation(w, %{id: TransportCatalog.rotation_id(forged), generation: 2}, k2, t2.key, "u")
    tr = W.rotation(w, %{id: w.r1.id, generation: 1}, w.k1, w.new_catalog, "demo-tr")
    log = W.with_ops(base, [w.r1])

    r2 =
      F.replacement(base, log, "demo-r2",
        parents: [w.r1.id],
        prior_catalogs: [%{binding: w.r1.id, catalog: F.cid(w.k1)}],
        generation: 2
      )

    k2r = F.first(base, r2)
    {:ok, %{cutoff: cut}} = Treehouse.CatalogCutoff.derive(log)
    proof = %{cutoff: cut, history: CatalogTrustVectors.raw_history(log)}
    kn = F.first(base, w.rn)
    tn = W.rotation(w, %{id: w.rn.id, generation: 1}, kn, w.rn.catalog_key, "demo-tn")
    moved = Enum.map(F.base_entries(base), &%{&1 | route: "/r/" <> F.id("demo-sibling")})
    c1 = F.catalog(base, base.boot.id, 1, F.cid(w.c0), base.catalog, F.base_entries(base))
    c1b = F.catalog(base, base.boot.id, 1, F.cid(w.c0), base.catalog, moved)
    orphan = W.rotation(w, %{id: F.id("demo-nowhere"), generation: 1}, w.c0, base.catalog, "o")
    bad = %{t.envelope | old_signature: binary_part(t.envelope.old_signature, 0, 63)}
    recover = W.page(logs: [log], proofs: [w.proof], catalogs: [w.k1])

    %{
      round3:
        round_three(w, %{t: t, t2: t2, k2: k2, ct: ct, ct1: ct1, ct1b: ct1b, orphan: orphan}),
      u: u,
      orphan: orphan,
      page_bad_rotation: %{recover | rotations: [CatalogTrustVectors.artifact_json(bad)]},
      page_no_signature: %{
        recover
        | rotations: [CatalogTrustVectors.artifact_json(Map.delete(t.envelope, :old_signature))]
      },
      page_extra_key: %{
        recover
        | rotations: [CatalogTrustVectors.artifact_json(Map.put(t.envelope, :extra, 1))]
      },
      ct1: ct1,
      ct1b: ct1b,
      junks: junks,
      tr: tr,
      tn: tn,
      page_three:
        W.page(rotations: [t2.envelope, t3.envelope, t4.envelope], catalogs: [k2, k3, k4]),
      page_legacy_two:
        W.page(rotations: [t.envelope, tt.envelope], catalogs: [ct, ctt], proofs: [w.proof]),
      page_r2: W.page(logs: [W.with_ops(base, [w.r1, r2.op])], proofs: [proof], catalogs: [k2r]),
      page_rn: W.page(logs: [W.with_ops(base, [w.rn.op])], proofs: [w.proof], catalogs: [kn]),
      page_fork: W.page(catalogs: [c1, c1b]),
      page_recover:
        W.page(logs: [log], proofs: [w.proof], catalogs: [w.k1], rotations: [t.envelope]),
      labels: %{
        t4.id => "T4",
        F.cid(k4) => "K4",
        tt.id => "TT",
        F.cid(ctt) => "CTT",
        r2.id => "R2",
        F.cid(k2r) => "K2r",
        F.cid(ct1) => "CT1",
        F.cid(ct1b) => "CT1b"
      }
    }
  end

  # Review round 3: sixteen whitespace-prefixed JSON variants of CT1 ahead of its sibling CT1b,
  # an orphan beside a held fork, a forged catalog under one of three sibling rotations (a
  # `control_history_limit` block), and T2 with a duplicate key or non-canonical base64.
  defp round_three(w, %{t: t, t2: t2, k2: k2, ct: ct} = x) do
    alias Treehouse.CatalogBindingGraphFixtures, as: F
    base = w.base
    json = CatalogTrustVectors.artifact_json(x.ct1)
    spaces = [" ", "\t", "\n", "\r"]
    variants = Enum.sort(for a <- spaces, b <- spaces, do: a <> b <> json)
    siblings = sibling_rotations(w)
    junk_key = Lattice.Identity.from_seed("junk", "demo-limit-junk")
    junk = F.catalog(base, elem(hd(siblings), 0), 0, nil, junk_key, w.c0.catalog.entries)
    log = W.with_ops(base, [w.r1])
    ["map", pairs] = Wire.encode_value(t2.envelope)
    wrong = [["atom", "old_signature"], ["bin", Base.encode64(<<0::512>>)]]

    loose =
      Enum.map(pairs, fn
        [["atom", "new_signature"], ["bin", text]] ->
          [["atom", "new_signature"], ["bin", noncanonical(text)]]

        pair ->
          pair
      end)

    with_k2 = W.page(catalogs: [k2], proofs: [w.proof])

    %{
      page_variants: %{
        W.page()
        | catalogs: variants ++ [CatalogTrustVectors.artifact_json(x.ct1b)]
      },
      page_t_ct: W.page(rotations: [t.envelope], catalogs: [ct], proofs: [w.proof]),
      page_t_orphan: W.page(rotations: [t.envelope, x.orphan.envelope], proofs: [w.proof]),
      page_limit_junk: W.page(catalogs: [junk]),
      page_limit: %{
        W.page(logs: [log], proofs: [w.proof], catalogs: [w.k1])
        | rotations: Enum.map(siblings, &elem(&1, 1))
      },
      page_duplicate: %{with_k2 | rotations: [Jason.encode!(["map", [wrong | pairs]])]},
      page_loose: %{with_k2 | rotations: [Jason.encode!(["map", loose])]}
    }
  end

  defp sibling_rotations(w) do
    alias Treehouse.CatalogBindingGraphFixtures, as: F
    base = w.base

    for i <- 1..3 do
      new = Lattice.Identity.from_seed("catalog", "demo-limit-#{i}")

      rotation = %{
        version: 1,
        product: :treehouse,
        space: base.replica,
        bootstrap: base.boot.id,
        parent: base.boot.id,
        prior_catalog: F.cid(w.c0),
        generation: 1,
        new_catalog_key: new.pub,
        nonce: F.id("demo-limit-#{i}"),
        inventory_digest: TransportCatalog.inventory_id(w.c0.catalog.entries),
        cutoffs: [w.proof.cutoff]
      }

      envelope = %{
        rotation: rotation,
        old_signature:
          Lattice.Identity.sign(base.catalog, TransportCatalog.rotation_bytes(rotation)),
        new_signature:
          Lattice.Identity.sign(new, TransportCatalog.rotation_possession_bytes(rotation))
      }

      {TransportCatalog.rotation_id(envelope), CatalogTrustVectors.artifact_json(envelope)}
    end
  end

  # 64 bytes encode to 86 characters and "=="; the last character carries 4 unused bits.
  defp noncanonical(text) do
    <<head::binary-size(85), last, "==">> = text
    alphabet = ~c"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    index = Enum.find_index(alphabet, &(&1 == last))
    head <> <<Enum.at(alphabet, Bitwise.bxor(index, 1))>> <> "=="
  end

  defp fixture_orphan(f) do
    next = Lattice.Identity.from_seed("catalog-demo-orphan", "r2-demo-orphan")

    rotation = %{
      f.rotation
      | parent: CatalogTrustVectors.id("r2-demo-nowhere"),
        nonce: CatalogTrustVectors.id("r2-demo-orphan"),
        new_catalog_key: next.pub
    }

    CatalogTrustVectors.sign_rotation(rotation, f.space.catalog, next)
  end

  defp fixture_install(f) do
    %{kind: :propose, next: installed} =
      CatalogReplacementTrust.prepare_installation(%{
        review: f.review,
        history: hd(f.histories),
        store: %{kind: :verified_fresh, expected: W.expected()}
      })

    installed
  end

  defp json(view), do: view |> Jason.encode!() |> Jason.decode!()
end
