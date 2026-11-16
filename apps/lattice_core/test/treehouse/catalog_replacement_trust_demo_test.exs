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

  alias Treehouse.CatalogReplacementWorld, as: W
  alias Treehouse.TransportCatalog

  @moduletag :replacement_demo
  @moduletag timeout: 180_000

  @ts_dir Path.expand("../../../../clients/lattice-client", __DIR__)

  test "admin replacement accepted without the old key; non-admin refused; BEAM equals TS" do
    w = W.build()
    base = w.base
    old_key = base.record.catalog_key
    labels = w.labels

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
             "3 non-admin Rn"
           ]

    # The order, repeat and freeze runs, asserted on BEAM before TS must agree.
    assert [_, %{"accepted" => "B/C0"}, %{"accepted" => "R1/K1", "frozen" => false}] =
             beam_views["k1_first"]

    assert [_, %{"accepted" => "R1/K1"}, %{"accepted" => "R1/K1"} = again] = beam_views["twice"]
    assert again["kind"] == "unchanged"
    assert Map.delete(again, "kind") == Map.delete(Enum.at(beam_views["twice"], 1), "kind")

    assert [_, %{"accepted" => "B/C0", "routes" => 1}, %{"accepted" => "R1/K1", "routes" => 1}] =
             beam_views["junk"]

    assert [_, _, %{"frozen" => true, "routes" => 0, "origin" => nil}] = beam_views["freeze"]

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

  defp json(view), do: view |> Jason.encode!() |> Jason.decode!()
end
