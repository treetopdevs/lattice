defmodule Treehouse.CatalogDecisionOrderTest do
  use ExUnit.Case, async: false
  alias Treehouse.CatalogTrust
  Code.require_file("../../../../scripts/support/catalog_resolver_json.exs", __DIR__)
  @client Path.expand("../../../../clients/lattice-client", __DIR__)

  @tag timeout: 300_000
  test "catalog preflight, route blame and first fork witnesses agree across actual owners" do
    {json, status} =
      System.cmd("node", ["--import", "tsx", "test/support/catalog_decision_order_peer.ts"],
        cd: @client,
        stderr_to_stdout: true
      )

    assert status == 0, json
    table = Jason.decode!(json)
    assert length(table["cases"]) == 18

    errors =
      for item <- table["cases"], {row, index} <- Enum.with_index(item["orders"]), reduce: [] do
        errors ->
          input = NativeCatalogResolverPeer.input(row["input"])
          before = :erlang.term_to_binary(input)
          actual = input |> CatalogTrust.evaluate() |> NativeCatalogResolverPeer.output()
          assert :erlang.term_to_binary(input) == before

          if actual == row["decision"] do
            errors
          else
            [
              {item["name"], index, Map.take(actual, ["kind", "reason", "detail"]),
               get_in(actual, ["next", "blocked"]),
               Map.take(row["decision"], ["kind", "reason", "detail"]),
               get_in(row["decision"], ["next", "blocked"])}
              | errors
            ]
          end
      end

    assert errors == [], "Complete public decisions differ: #{inspect(Enum.reverse(errors))}"
  end

  alias Lattice.{Log, Op}
  alias Treehouse.{CatalogTrustVectors, TransportCatalog}
  @expected %{trust_revision: 0, history_generation: 0}

  @tag timeout: 300_000
  test "independently BEAM-authored ordering requests agree with the TypeScript public owner" do
    f = CatalogTrustVectors.fixture(1)

    %{kind: :propose, next: prepared} =
      CatalogTrust.prepare_installation(%{
        review: f.review,
        history: hd(f.histories),
        store: %{kind: :verified_fresh, expected: @expected}
      })

    %{kind: :propose, next: accepted} =
      CatalogTrust.evaluate(
        request(prepared, %{catalogs: [f.catalog_json], histories: f.histories})
      )

    bad = CatalogTrustVectors.artifact_json(%{f.catalog_envelope | signature: <<0::512>>})
    wrong = CatalogTrustVectors.id("beam-order-foreign-bootstrap")

    scoped =
      signed(
        %{
          f.catalog
          | bootstrap: wrong,
            entries:
              Enum.map(f.catalog.entries, fn e ->
                if e.kind == :space, do: %{e | reference: wrong}, else: e
              end)
        },
        f
      )

    orphan = %{
      f.catalog
      | revision: 1,
        previous: CatalogTrustVectors.id("beam-order-missing-parent")
    }

    orphan_bad =
      CatalogTrustVectors.artifact_json(%{
        CatalogTrustVectors.sign_catalog(orphan, f.space.catalog)
        | signature: <<0::512>>
      })

    moved = %{
      f.catalog
      | revision: 1,
        previous: TransportCatalog.catalog_id(f.catalog),
        entries:
          Enum.map(f.catalog.entries, fn e ->
            if e.kind == :thread,
              do: %{e | route: "/r/" <> CatalogTrustVectors.id("beam-order-moved")},
              else: e
          end)
    }

    %{kind: :propose, next: advanced} =
      CatalogTrust.evaluate(request(accepted, %{catalogs: [signed(moved, f)]}))

    f2 = CatalogTrustVectors.fixture(2)
    old_thread = hd(f.threads).replica
    old_route = Enum.find(f.catalog.entries, &(&1.replica == old_thread)).route
    moved_route = Enum.find(moved.entries, &(&1.replica == old_thread)).route

    collision =
      Enum.find_value(0..4095, fn n ->
        catalog = %{
          f2.catalog
          | revision: 2,
            previous: TransportCatalog.catalog_id(moved),
            entries:
              Enum.map(f2.catalog.entries, fn e ->
                cond do
                  e.kind == :space ->
                    %{e | route: "/r/" <> CatalogTrustVectors.id("beam-order-space-#{n}")}

                  e.replica == old_thread ->
                    %{e | route: moved_route}

                  true ->
                    %{e | route: old_route}
                end
              end)
        }

        id = TransportCatalog.catalog_id(catalog)

        if id < TransportCatalog.catalog_id(f.catalog) and id < TransportCatalog.catalog_id(moved),
          do: signed(catalog, f)
      end)

    assert is_binary(collision)

    fork = %{
      f.catalog
      | entries:
          Enum.map(
            f.catalog.entries,
            &%{&1 | route: "/r/" <> CatalogTrustVectors.id("beam-fork:#{&1.replica}")}
          )
    }

    %{kind: :retain_blocked, reason: :catalog_fork, next: frozen} =
      CatalogTrust.evaluate(request(accepted, %{catalogs: [signed(fork, f)]}))

    {:catalog_bootstrap_v1, [record]} = f.space.bootstrap.body

    boot =
      Op.new(
        f.space.root,
        f.space.replica,
        Log.frontier(f.space_log),
        :command,
        {:catalog_bootstrap_v1,
         [%{record | nonce: CatalogTrustVectors.id("beam-order-new-bootstrap")}]},
        cap: f.space.delegation.id
      )

    history = f.space_log |> Log.append!(boot) |> CatalogTrustVectors.raw_history()

    families = [
      {"scope", accepted, %{catalogs: [bad, scoped]}, :reject, :wrong_catalog_scope},
      {"shape", accepted, %{catalogs: [bad, "{}"]}, :reject, :malformed_catalog},
      {"rotation-stage", accepted, %{catalogs: [bad], rotations: ["{}"]}, :reject,
       :invalid_catalog_signature},
      {"duplicate", accepted, %{catalogs: ["  " <> f.catalog_json <> "\n"]}, :unchanged, nil},
      {"bad-orphan", accepted, %{catalogs: [orphan_bad]}, :reject, :invalid_catalog_signature},
      {"orphan", accepted, %{catalogs: [signed(orphan, f)]}, :reject, :trust_pending},
      {"routes", advanced, %{catalogs: [collision], histories: f2.histories}, :reject,
       :invalid_catalog_transition},
      {"fork-bootstrap", frozen, %{histories: [history]}, :retain_blocked, :catalog_fork}
    ]

    cases =
      for {name, state, page, kind, reason} <- families, reverse <- [false, true] do
        page =
          Map.new(page, fn {key, rows} ->
            rows = if reverse, do: Enum.reverse(rows), else: rows

            rows =
              if key == :histories and reverse,
                do: Enum.map(rows, &%{&1 | frames: Enum.reverse(&1.frames)}),
                else: rows

            {key, rows}
          end)

        input = request(state, page)
        before = :erlang.term_to_binary(input)
        decision = CatalogTrust.evaluate(input)
        assert decision.kind == kind, inspect({name, decision})
        if reason, do: assert(decision.reason == reason, inspect({name, decision}))
        if name == "fork-bootstrap", do: assert(decision.next.blocked == frozen.blocked)

        if name == "routes",
          do: assert(decision.detail.ids == [TransportCatalog.catalog_id(f.catalog)])

        assert before == :erlang.term_to_binary(input)
        %{name: "#{name}:#{reverse}", input: input, decision: decision}
      end

    path =
      Path.join(
        System.tmp_dir!(),
        "catalog-beam-order-#{System.unique_integer([:positive])}.json"
      )

    on_exit(fn -> File.rm(path) end)

    File.write!(
      path,
      Jason.encode!(
        NativeCatalogResolverPeer.output(%{
          cases: Enum.map(cases, &Map.take(&1, [:name, :input]))
        })
      )
    )

    {json, status} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/native_catalog_resolver_peer.ts", "consume", path],
        cd: @client,
        stderr_to_stdout: true
      )

    assert status == 0, json
    results = Jason.decode!(json)["results"]
    assert length(results) == length(cases)

    for {item, result} <- Enum.zip(cases, results) do
      assert result["name"] == item.name
      assert result["decision"] == NativeCatalogResolverPeer.output(item.decision), item.name
    end
  end

  defp request(state, page),
    do: %{
      installed: state,
      expected: @expected,
      incoming: Map.merge(%{catalogs: [], rotations: [], histories: [], cutoff_proofs: []}, page)
    }

  defp signed(catalog, f),
    do:
      catalog
      |> CatalogTrustVectors.sign_catalog(f.space.catalog)
      |> CatalogTrustVectors.artifact_json()
end
