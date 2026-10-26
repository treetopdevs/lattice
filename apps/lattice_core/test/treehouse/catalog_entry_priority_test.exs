defmodule Treehouse.CatalogEntryPriorityTest do
  use ExUnit.Case, async: true
  alias Lattice.{Identity, Log, Op}
  alias Treehouse.{CatalogEntries, CatalogTrust, CatalogTrustVectors, TransportCatalog}
  @expected %{trust_revision: 0, history_generation: 0}
  @invalid_cases [
    :empty_child,
    :malformed_creation_missing_genesis,
    :root_missing_creation,
    :root_missing_genesis,
    :genesis_kind_missing_creation,
    :creation_kind_missing_genesis,
    :reference_kind_missing_creation,
    :reference_kind_missing_genesis,
    :refused_creation_missing_genesis,
    :refused_reference_missing_creation
  ]

  for name <- @invalid_cases do
    @scenario name
    test "available invalid proof dominates missing evidence: #{name}" do
      {f, catalog, logs} = scenario(@scenario)
      assert {:ok, _} = TransportCatalog.normalize_catalog(catalog)
      assert {:error, :invalid_catalog_transition} = CatalogEntries.observe(catalog, logs)
      decision = evaluate(install(f), catalog_json(catalog, f), logs)
      assert decision.kind == :reject
      assert decision.reason == :invalid_catalog_transition
      target = Enum.find(catalog.entries, &(&1.kind == :thread))

      refused =
        case @scenario do
          name
          when name in [:refused_creation_missing_genesis, :malformed_creation_missing_genesis] ->
            [target.creation]

          :refused_reference_missing_creation ->
            [target.reference]

          _ ->
            []
        end

      assert {:error, :invalid_catalog_transition, ^refused} =
               CatalogEntries.observe_with_detail(catalog, logs)

      assert decision.detail.ids == Enum.sort([TransportCatalog.catalog_id(catalog) | refused])
    end
  end

  @control_cases [
    :complete,
    :missing_genesis,
    :missing_creation,
    :missing_reference,
    :missing_child,
    :missing_child_wrong_root,
    :missing_child_wrong_reference
  ]
  for name <- @control_cases do
    @scenario name
    test "complete and genuinely incomplete controls retain their meaning: #{name}" do
      {f, catalog, logs} = scenario(@scenario)
      decision = evaluate(install(f), catalog_json(catalog, f), logs)
      assert decision.kind == :propose

      if @scenario == :complete do
        assert {:ok, _} = CatalogEntries.observe(catalog, logs)
        assert decision.reason == nil
        assert length(decision.routes) == 2
      else
        assert {:error, :trust_pending} = CatalogEntries.observe(catalog, logs)
        assert decision.reason == :trust_pending
        assert decision.next.accepted == nil
        assert decision.routes == []
      end
    end
  end

  test "saved invalid proof cannot be repaired or hidden by a valid incoming catalog" do
    {f, catalog, logs} = scenario(:root_missing_creation)
    initial = install(f)
    good = evaluate(initial, f.catalog_json, logs)
    assert good.kind == :propose
    assert length(good.routes) == 2
    json = catalog_json(catalog, f)

    broken = %{
      initial
      | histories: raw(logs),
        catalogs: [%{id: TransportCatalog.catalog_id(catalog), json: json}]
    }

    refused = evaluate(broken, f.catalog_json, logs)
    assert refused.kind == :reject
    assert refused.reason == :trust_recovery_required
  end

  test "diagnostic structure preserves missing Space and bootstrap prerequisites" do
    f = CatalogTrustVectors.fixture(1)
    logs = Map.new([f.space_log | Enum.map(f.threads, & &1.log)], &{&1.replica, &1})
    assert CatalogEntries.structure_status(f.catalog, logs) == :complete

    assert CatalogEntries.structure_status(f.catalog, Map.delete(logs, f.space.replica)) ==
             :pending

    before_bootstrap =
      Log.new(f.space.replica) |> Log.append!(f.space.genesis) |> Log.append!(f.space.creation)

    assert CatalogEntries.structure_status(
             f.catalog,
             Map.put(logs, f.space.replica, before_bootstrap)
           ) == :pending
  end

  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @tag timeout: 300_000
  test "fresh TS entry priority decisions match the full BEAM owner" do
    check_peer(peer([]))
  end

  @tag timeout: 300_000
  test "fresh BEAM entry priority decisions match the full TS owner" do
    path = temporary()
    bundle = CatalogTrustVectors.write_public_fixture!(path)

    cases =
      Enum.map(@control_cases ++ @invalid_cases ++ [:unrelated_forgery], fn name ->
        {case_f, catalog, logs} = scenario(name)

        %{
          name: Atom.to_string(name),
          catalogJson: catalog_json(catalog, case_f),
          histories: raw(logs),
          reason: expected_reason(name)
        }
      end)

    File.write!(
      path,
      Jason.encode!(bundle |> Map.put(:cases, cases) |> Map.put(:frozen, frozen_bundle()))
    )

    check_peer(peer(["consume", path]))
  end

  @tag timeout: 300_000
  test "fresh TS cross-entry ordering and Space proof match BEAM" do
    check_peer(peer(["multi"]), 8, 8)
  end

  @tag timeout: 300_000
  test "fresh BEAM cross-entry ordering and Space proof match TS" do
    f = CatalogTrustVectors.fixture(2)
    [first, second] = Enum.sort_by(f.threads, & &1.replica)
    stranger = Identity.from_seed("multi-stranger", "multi-stranger")

    denied =
      Map.new([first, second], fn t ->
        {t.replica,
         Op.new(stranger, t.replica, [t.genesis.id], :command, {:create_thread, ["Denied"]},
           cap: t.delegation.id
         )}
      end)

    denied_space =
      Op.new(stranger, f.space.replica, [f.space.genesis.id], :command, {:create_space, []},
        cap: f.space.delegation.id
      )

    histories =
      [
        Log.append!(f.space_log, denied_space)
        | Enum.map([first, second], &Log.append!(&1.log, denied[&1.replica]))
      ]
      |> Map.new(&{&1.replica, &1})
      |> raw()

    missing = CatalogTrustVectors.id("multi-missing")

    variants = [
      {"pending_then_invalid",
       %{first.replica => %{genesis: missing}, second.replica => %{root: f.space.root.pub}}},
      {"invalid_then_pending",
       %{first.replica => %{root: f.space.root.pub}, second.replica => %{genesis: missing}}},
      {"first_invalid_only",
       %{
         first.replica => %{root: f.space.root.pub},
         second.replica => %{creation: denied[second.replica].id}
       }},
      {"first_refused_only",
       %{
         first.replica => %{creation: denied[first.replica].id},
         second.replica => %{root: f.space.root.pub}
       }},
      {"first_refused_clean_sibling",
       %{first.replica => %{creation: denied[first.replica].id, genesis: missing}}},
      {"second_refused_clean_sibling",
       %{second.replica => %{creation: denied[second.replica].id, genesis: missing}}},
      {"space_refused_and_missing",
       %{f.space.replica => %{creation: denied_space.id, genesis: missing}}},
      {"space_invalid_and_missing",
       %{f.space.replica => %{genesis: missing, creation: f.space.genesis.id}}}
    ]

    cases =
      Enum.map(variants, fn {name, edits} ->
        catalog = %{
          f.catalog
          | entries: Enum.map(f.catalog.entries, &Map.merge(&1, Map.get(edits, &1.replica, %{})))
        }

        %{
          name: name,
          catalogJson: catalog_json(catalog, f),
          histories: histories,
          reason: "invalid_catalog_transition"
        }
      end)

    path = temporary()

    File.write!(
      path,
      Jason.encode!(%{
        review: normalize(f.review),
        histories: f.histories,
        cutoffProofs: [],
        catalogJson: f.catalog_json,
        cases: cases,
        frozen:
          frozen_bundle(
            f,
            Enum.map(
              cases,
              &Map.put(
                &1,
                :retain,
                &1.name in [
                  "first_refused_clean_sibling",
                  "second_refused_clean_sibling",
                  "space_refused_and_missing"
                ]
              )
            )
          )
      })
    )

    check_peer(peer(["consume-multi", path]), 8, 8)
  end

  defp check_peer(table, expected_count \\ 18, frozen_count \\ 5) do
    path = temporary()
    File.write!(path, Jason.encode!(table["bundle"]))
    f = CatalogTrustVectors.read_ts_fixture!(path)
    initial = install(f)
    intact = evaluate_raw(initial, f.catalog_json, f.histories)
    assert intact.kind == :propose
    {:ok, base_envelope} = TransportCatalog.decode_catalog_json(f.catalog_json)
    assert length(intact.routes) == length(base_envelope.catalog.entries)
    assert normalize(intact) == table["intact"]
    check_frozen_peer(table, initial, path, frozen_count)
    cases = table["bundle"]["cases"]
    assert length(cases) == expected_count
    assert length(Enum.uniq_by(cases, & &1["name"])) == expected_count
    assert length(table["results"]) == expected_count

    for {c, observed} <- Enum.zip(cases, table["results"]) do
      assert c["name"] == observed["name"]
      assert length(observed["orders"]) == 2

      for {reverse, order} <- Enum.zip([false, true], observed["orders"]) do
        raw_bundle = Map.put(table["bundle"], "histories", c["histories"])
        File.write!(path, Jason.encode!(raw_bundle))
        decoded = CatalogTrustVectors.read_ts_fixture!(path)

        histories =
          if reverse,
            do:
              decoded.histories
              |> Enum.reverse()
              |> Enum.map(&%{&1 | frames: Enum.reverse(&1.frames)}),
            else: decoded.histories

        decision = evaluate_raw(initial, c["catalogJson"], histories)
        assert normalize(decision) == order["decision"], "#{c["name"]} reverse=#{reverse}"
        assert (decision.reason && Atom.to_string(decision.reason)) == c["reason"]

        if c["reason"] not in [nil, "trust_pending"] do
          {:ok, envelope} = TransportCatalog.decode_catalog_json(c["catalogJson"])

          broken = %{
            initial
            | histories: histories,
              catalogs: [
                %{id: TransportCatalog.catalog_id(envelope.catalog), json: c["catalogJson"]}
              ]
          }

          recovered = evaluate_raw(broken, f.catalog_json, f.histories)
          assert recovered.kind == :reject
          assert recovered.reason == :trust_recovery_required
          assert normalize(recovered) == order["saved"]
        end
      end
    end
  end

  defp check_frozen_peer(
         %{"bundle" => %{"frozen" => frozen}} = table,
         initial,
         path,
         frozen_count
       ) do
    decode = fn histories ->
      File.write!(path, Jason.encode!(Map.put(table["bundle"], "histories", histories)))
      CatalogTrustVectors.read_ts_fixture!(path).histories
    end

    base = evaluate_raw(initial, frozen["baseCatalogJson"], decode.(frozen["baseHistories"]))
    assert normalize(base) == table["frozenResults"]["base"]
    setup = evaluate_raw(base.next, nil, decode.(frozen["freezeHistories"]))
    assert normalize(setup) == table["frozenResults"]["setup"]
    assert length(frozen["cases"]) == frozen_count
    assert length(table["frozenResults"]["cases"]) == length(frozen["cases"])

    for {c, observed} <- Enum.zip(frozen["cases"], table["frozenResults"]["cases"]) do
      assert c["name"] == observed["name"]
      assert length(observed["orders"]) == 2

      for {reverse, order} <- Enum.zip([false, true], observed["orders"]) do
        histories = decode.(c["histories"])

        histories =
          if reverse,
            do: histories |> Enum.reverse() |> Enum.map(&%{&1 | frames: Enum.reverse(&1.frames)}),
            else: histories

        catalogs = c["catalogs"] || c["catalogJson"]
        catalogs = if reverse and is_list(catalogs), do: Enum.reverse(catalogs), else: catalogs
        decision = evaluate_raw(setup.next, catalogs, histories)
        assert decision.kind == :retain_blocked
        assert decision.reason == :authority_changed
        assert decision.routes == []
        expected_ids = Enum.map(order["decision"]["next"]["catalogs"], & &1["id"])
        assert Enum.map(decision.next.catalogs, & &1.id) == expected_ids
        assert normalize(decision) == order["decision"], "frozen #{c["name"]}"
        reopened = evaluate_raw(decision.next, nil, [])
        assert normalize(reopened) == order["reopened"]
      end
    end
  end

  defp check_frozen_peer(_table, _initial, _path, _frozen_count), do: :ok

  defp evaluate_raw(initial, json, histories),
    do:
      CatalogTrust.evaluate(%{
        installed: initial,
        expected: @expected,
        incoming: %{
          catalogs: if(is_nil(json), do: [], else: List.wrap(json)),
          rotations: [],
          histories: histories,
          cutoff_proofs: []
        }
      })

  defp peer(args) do
    {output, status} =
      System.cmd(
        "node",
        ["--import", "tsx", "test/support/catalog_entry_priority_peer.ts" | args],
        cd: @client,
        stderr_to_stdout: true
      )

    assert status == 0, output
    Jason.decode!(output)
  end

  defp temporary do
    path =
      Path.join(
        System.tmp_dir!(),
        "catalog-entry-priority-#{System.unique_integer([:positive])}.json"
      )

    on_exit(fn -> File.rm(path) end)
    path
  end

  defp normalize(value) when is_map(value),
    do:
      Map.new(value, fn {k, v} ->
        {key(k),
         if(k in [:space_root, :root, :service_key, :catalog_key, :new_key] and is_binary(v),
           do: Base.encode64(v),
           else: normalize(v)
         )}
      end)

  defp normalize(value) when is_list(value), do: Enum.map(value, &normalize/1)
  defp normalize(value) when value in [nil, true, false], do: value
  defp normalize(value) when is_atom(value), do: Atom.to_string(value)
  defp normalize(value), do: value

  defp key(value) when is_atom(value),
    do:
      value
      |> Atom.to_string()
      |> then(fn s -> Regex.replace(~r/_([a-z])/, s, fn _, c -> String.upcase(c) end) end)

  defp key(value), do: value

  test "unrelated forgery takes priority over invalid and missing entry facts" do
    {f, catalog, logs} = scenario(:unrelated_forgery)
    assert {:error, :invalid_verified_history} = CatalogEntries.observe(catalog, logs)
    decision = evaluate(install(f), catalog_json(catalog, f), logs)
    assert decision.kind == :reject
    assert decision.reason == :invalid_verified_history
  end

  defp expected_reason(:complete), do: nil
  defp expected_reason(:unrelated_forgery), do: "invalid_verified_history"

  defp expected_reason(name),
    do: if(name in @invalid_cases, do: "invalid_catalog_transition", else: "trust_pending")

  defp scenario(name) do
    f = CatalogTrustVectors.fixture(1)
    t = hd(f.threads)
    missing = CatalogTrustVectors.id("missing-entry-item")
    logs = Map.new([f.space_log, t.log], &{&1.replica, &1})
    stranger = Identity.from_seed("entry-priority-stranger", "entry-priority-stranger")

    refused_creation =
      Op.new(stranger, t.replica, [t.genesis.id], :command, {:create_thread, ["Denied"]},
        cap: t.delegation.id
      )

    malformed_creation =
      Op.new(t.root, t.replica, [t.genesis.id], :command, {:create_thread, []},
        cap: t.delegation.id
      )

    refused_reference =
      Op.new(
        stranger,
        f.space.replica,
        Log.frontier(f.space_log),
        :command,
        {:create_thread, [t.replica, "Denied"]},
        cap: f.space.delegation.id
      )

    edits =
      Map.fetch!(
        %{
          complete: %{},
          empty_child: %{},
          missing_child: %{},
          missing_genesis: %{genesis: missing},
          missing_creation: %{creation: missing},
          missing_reference: %{reference: missing},
          missing_child_wrong_root: %{root: f.space.root.pub},
          missing_child_wrong_reference: %{reference: f.space.creation.id},
          root_missing_creation: %{root: f.space.root.pub, creation: missing},
          root_missing_genesis: %{root: f.space.root.pub, genesis: missing},
          genesis_kind_missing_creation: %{genesis: t.creation.id, creation: missing},
          creation_kind_missing_genesis: %{creation: t.genesis.id, genesis: missing},
          reference_kind_missing_creation: %{reference: f.space.creation.id, creation: missing},
          reference_kind_missing_genesis: %{reference: f.space.creation.id, genesis: missing},
          refused_creation_missing_genesis: %{creation: refused_creation.id, genesis: missing},
          malformed_creation_missing_genesis: %{creation: malformed_creation.id, genesis: missing},
          refused_reference_missing_creation: %{
            reference: refused_reference.id,
            creation: missing
          },
          unrelated_forgery: %{root: f.space.root.pub, creation: missing}
        },
        name
      )

    logs =
      case name do
        name
        when name in [:missing_child, :missing_child_wrong_root, :missing_child_wrong_reference] ->
          Map.delete(logs, t.replica)

        :empty_child ->
          Map.put(logs, t.replica, Log.new(t.replica))

        :refused_creation_missing_genesis ->
          Map.put(logs, t.replica, Log.append!(t.log, refused_creation))

        :malformed_creation_missing_genesis ->
          Map.put(logs, t.replica, Log.append!(t.log, malformed_creation))

        :refused_reference_missing_creation ->
          Map.put(logs, f.space.replica, Log.append!(f.space_log, refused_reference))

        :unrelated_forgery ->
          extra = CatalogTrustVectors.fixture(2).threads |> List.last()

          forged = %{
            extra.log
            | ops: Map.update!(extra.log.ops, extra.genesis.id, &%{&1 | sig: <<0::512>>})
          }

          Map.put(logs, extra.replica, forged)

        _ ->
          logs
      end

    catalog = %{
      f.catalog
      | entries:
          Enum.map(f.catalog.entries, fn entry ->
            if entry.kind == :thread, do: Map.merge(entry, edits), else: entry
          end)
    }

    {f, catalog, logs}
  end

  defp frozen_bundle do
    f = CatalogTrustVectors.fixture(1)

    cases =
      Enum.map(
        [
          :refused_creation_missing_genesis,
          :refused_reference_missing_creation,
          :malformed_creation_missing_genesis,
          :root_missing_creation
        ],
        fn name ->
          {case_f, catalog, logs} = scenario(name)

          %{
            name: Atom.to_string(name),
            catalogJson: catalog_json(catalog, case_f),
            histories: raw(logs),
            reason: "invalid_catalog_transition",
            retain: name != :root_missing_creation
          }
        end
      )

    {_, pending, _} = scenario(:refused_creation_missing_genesis)
    parent_json = hd(cases).catalogJson

    child =
      catalog_json(%{pending | revision: 1, previous: TransportCatalog.catalog_id(pending)}, f)

    cached =
      hd(cases)
      |> Map.put(:name, "same_inventory_cache")
      |> Map.put(:catalogs, [parent_json, child])

    frozen_bundle(f, cases ++ [cached])
  end

  defp frozen_bundle(f, cases) do
    transfer =
      Enum.find_value(1..200, fn index ->
        successor =
          Identity.from_seed("entry-frozen-successor", "entry-frozen-successor-#{index}")

        delegation =
          Lattice.Authority.Delegation.new(f.space.root, f.space.replica, successor.pub,
            parent_id: f.space.delegation.id,
            ops: MapSet.to_list(f.space.delegation.ops),
            roles: [:admin]
          )

        op =
          Op.new(
            f.space.root,
            f.space.replica,
            [f.space.creation.id],
            :authority,
            {:transfer, :admin, delegation, 0}
          )

        if Map.has_key?(
             Lattice.Authority.analyze(Treehouse.Space, Log.append!(f.space_log, op)).reasons,
             f.space.bootstrap.id
           ),
           do: op
      end) || flunk("no refusing signed transfer found")

    %{
      baseCatalogJson:
        catalog_json(
          %{f.catalog | entries: Enum.filter(f.catalog.entries, &(&1.kind == :space))},
          f
        ),
      baseHistories: [hd(f.histories)],
      freezeHistories: [f.space_log |> Log.append!(transfer) |> CatalogTrustVectors.raw_history()],
      cases: cases
    }
  end

  defp catalog_json(catalog, f),
    do:
      catalog
      |> CatalogTrustVectors.sign_catalog(f.space.catalog)
      |> CatalogTrustVectors.artifact_json()

  defp raw(logs),
    do:
      logs |> Enum.sort() |> Enum.map(fn {_name, log} -> CatalogTrustVectors.raw_history(log) end)

  defp install(f) do
    %{kind: :propose, next: initial} =
      CatalogTrust.prepare_installation(%{
        review: f.review,
        history: hd(f.histories),
        store: %{kind: :verified_fresh, expected: @expected}
      })

    initial
  end

  defp evaluate(initial, json, logs),
    do:
      CatalogTrust.evaluate(%{
        installed: initial,
        expected: @expected,
        incoming: %{catalogs: [json], rotations: [], histories: raw(logs), cutoff_proofs: []}
      })
end
