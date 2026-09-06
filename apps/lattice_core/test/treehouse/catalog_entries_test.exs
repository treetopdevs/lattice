defmodule Treehouse.CatalogEntriesTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Identity, Log, Op}
  alias Lattice.Authority.Delegation
  alias Treehouse.{CatalogEntries, CatalogVectors}

  test "actual independent Thread genesis and Space reference establish facts without route authority" do
    f = fixture()
    assert {:ok, result} = CatalogEntries.observe(f.catalog, f.histories)
    assert result.bootstrap == %{id: f.space.bootstrap.id, record: f.space.record}
    assert result.entries == f.catalog.entries
    refute Map.has_key?(result, :routes)
    refute f.thread_root.pub == f.space.root.pub
  end

  test "signed catalog metadata cannot replace actual root, genesis or reference evidence" do
    f = fixture()

    for change <- [
          %{root: f.space.root.pub},
          %{genesis: f.thread_creation.id},
          %{creation: f.thread_genesis.id},
          %{reference: f.space.creation.id}
        ] do
      altered = replace_thread(f.catalog, change)
      assert {:error, :invalid_catalog_transition} = CatalogEntries.observe(altered, f.histories)
    end

    altered = %{
      f.catalog
      | entries: Enum.map(f.catalog.entries, &%{&1 | service_key: f.space.catalog.pub})
    }

    assert {:ok, _} = Treehouse.TransportCatalog.normalize_catalog(altered)
    assert {:error, :invalid_catalog_transition} = CatalogEntries.observe(altered, f.histories)
  end

  test "an actually signed unauthorized Space reference stays refused" do
    f = fixture()
    stranger = Identity.from_seed("stranger", "catalog-entry-stranger")

    denied =
      Op.new(
        stranger,
        f.space.replica,
        Log.frontier(f.histories[f.space.replica]),
        :command,
        {:create_thread, [f.thread_replica, "Pretend listing"]},
        cap: f.space.delegation.id
      )

    histories = Map.update!(f.histories, f.space.replica, &Log.append!(&1, denied))
    catalog = replace_thread(f.catalog, %{reference: denied.id})
    assert {:error, :invalid_catalog_transition} = CatalogEntries.observe(catalog, histories)
  end

  test "missing evidence is pending while forged complete history refuses" do
    f = fixture()

    assert {:error, :trust_pending} =
             CatalogEntries.observe(f.catalog, Map.delete(f.histories, f.thread_replica))

    forged = %{f.thread_creation | sig: <<0::512>>}
    corrupt = %{f.thread_log | ops: Map.put(f.thread_log.ops, forged.id, forged)}
    histories = Map.put(f.histories, f.thread_replica, corrupt)
    assert {:error, :invalid_verified_history} = CatalogEntries.observe(f.catalog, histories)
  end

  test "a copied root delegation cannot authenticate another genesis author" do
    f = fixture()
    stranger = Identity.from_seed("stranger", "catalog-entry-genesis-impostor")
    empty = Delegation.genesis(f.thread_root, f.thread_replica, ops: [], roles: [], live: false)
    false_genesis = Op.new(stranger, f.thread_replica, [], :authority, {:genesis, empty, %{}})
    {:genesis, grant, _} = f.thread_genesis.body

    creation =
      Op.new(
        f.thread_root,
        f.thread_replica,
        [f.thread_genesis.id, false_genesis.id],
        :command,
        {:create_thread, ["Still the root's command"]},
        cap: grant.id
      )

    log = f.thread_log |> Log.append!(false_genesis) |> Log.append!(creation)
    analysis = Authority.analyze(Treehouse.Thread, log)
    refute MapSet.member?(analysis.quarantine, creation.id)
    assert :ok = Authority.verify_chain([empty], f.thread_replica)
    catalog = replace_thread(f.catalog, %{genesis: false_genesis.id, creation: creation.id})

    assert {:error, :invalid_catalog_transition} =
             CatalogEntries.observe(catalog, Map.put(f.histories, f.thread_replica, log))
  end

  test "a later valid metadata pin does not replace the actual Space creation genesis" do
    f = fixture()

    catalog = %{
      f.catalog
      | entries:
          Enum.map(f.catalog.entries, fn
            %{kind: :space} = entry -> %{entry | genesis: f.space.pin.id}
            entry -> entry
          end)
    }

    refute MapSet.member?(
             Authority.analyze(Treehouse.Space, f.space.log).quarantine,
             f.space.pin.id
           )

    assert {:error, :invalid_catalog_transition} = CatalogEntries.observe(catalog, f.histories)
    assert {:ok, _} = CatalogEntries.observe(f.catalog, f.histories)
  end

  test "an unrelated valid genesis cannot stand in for the causal creation ancestor" do
    f = fixture()
    empty = Delegation.genesis(f.thread_root, f.thread_replica, ops: [], roles: [], live: false)
    unrelated = Op.new(f.thread_root, f.thread_replica, [], :authority, {:genesis, empty, %{}})
    log = Log.append!(f.thread_log, unrelated)
    refute MapSet.member?(Authority.analyze(Treehouse.Thread, log).quarantine, unrelated.id)
    catalog = replace_thread(f.catalog, %{genesis: unrelated.id})

    assert {:error, :invalid_catalog_transition} =
             CatalogEntries.observe(catalog, Map.put(f.histories, f.thread_replica, log))
  end

  test "valid genesis dependencies and transitive creation ancestry do not require a direct edge" do
    f = fixture()
    {:genesis, grant, _} = f.thread_genesis.body
    empty = Delegation.genesis(f.thread_root, f.thread_replica, ops: [], roles: [], live: false)

    genesis =
      Op.new(
        f.thread_root,
        f.thread_replica,
        [f.thread_creation.id],
        :authority,
        {:genesis, empty, %{}}
      )

    intermediate =
      Op.new(
        f.thread_root,
        f.thread_replica,
        [genesis.id],
        :command,
        {:post, ["Before creation"]},
        cap: grant.id
      )

    creation =
      Op.new(
        f.thread_root,
        f.thread_replica,
        [intermediate.id],
        :command,
        {:create_thread, ["A named later creation attempt"]},
        cap: grant.id
      )

    log =
      f.thread_log |> Log.append!(genesis) |> Log.append!(intermediate) |> Log.append!(creation)

    catalog = replace_thread(f.catalog, %{genesis: genesis.id, creation: creation.id})

    assert {:ok, result} =
             CatalogEntries.observe(catalog, Map.put(f.histories, f.thread_replica, log))

    assert result.entries == catalog.entries
  end

  test "corrupt extra history refuses before missing entries and unsupported evidence" do
    f = fixture()
    replica = "replica:extra"
    op = Op.new(f.thread_root, replica, [], :command, {:post, ["extra"]})
    extra = Log.new(replica) |> Log.append!(op)
    corrupt = %{extra | ops: %{op.id => %{op | sig: <<0::512>>}}}
    histories = f.histories |> Map.delete(f.thread_replica) |> Map.put(replica, corrupt)
    assert {:error, :invalid_verified_history} = CatalogEntries.observe(f.catalog, histories)

    unsupported = %{f.space.creation | id: "unsupported-evidence", body: self()}
    assert {:quarantined, space_log, :bad_signature} = Log.accept(f.space.log, unsupported)
    histories = Map.put(histories, f.space.replica, space_log)
    assert {:error, :invalid_verified_history} = CatalogEntries.observe(f.catalog, histories)

    assert {:error, :unsupported_cutoff} =
             CatalogEntries.observe(f.catalog, Map.delete(histories, replica))
  end

  test "every history map key and retained cache is authenticated without repairing input" do
    f = fixture()

    for histories <- [
          Map.put(f.histories, "replica:wrong-index", f.thread_log),
          Map.put(f.histories, f.thread_replica, %{f.thread_log | referenced: MapSet.new()}),
          Map.put(f.histories, f.thread_replica, %{
            f.thread_log
            | ops: Map.delete(f.thread_log.ops, f.thread_genesis.id)
          }),
          Map.put(f.histories, f.thread_replica, %{
            f.thread_log
            | quarantine: [%{reason: :bad_signature}]
          })
        ] do
      before = :erlang.term_to_binary(histories)
      assert {:error, :invalid_verified_history} = CatalogEntries.observe(f.catalog, histories)
      assert :erlang.term_to_binary(histories) == before
    end
  end

  test "missing named operations and references remain pending without synthetic entries" do
    f = fixture()

    for change <- [
          %{genesis: id("missing-genesis")},
          %{creation: id("missing-creation")},
          %{reference: id("missing-reference")}
        ] do
      assert {:error, :trust_pending} =
               CatalogEntries.observe(replace_thread(f.catalog, change), f.histories)
    end
  end

  test "a complete signed creation with refused authority is invalid rather than pending" do
    f = fixture()
    stranger = Identity.from_seed("stranger", "catalog-entry-creation-impostor")
    {:genesis, grant, _} = f.thread_genesis.body

    denied =
      Op.new(
        stranger,
        f.thread_replica,
        [f.thread_genesis.id],
        :command,
        {:create_thread, ["Not my Thread"]},
        cap: grant.id
      )

    log = Log.append!(f.thread_log, denied)
    assert MapSet.member?(Authority.analyze(Treehouse.Thread, log).quarantine, denied.id)

    assert {:error, :invalid_catalog_transition} =
             CatalogEntries.observe(
               replace_thread(f.catalog, %{creation: denied.id}),
               Map.put(f.histories, f.thread_replica, log)
             )
  end

  test "catalog shape and exact honored bootstrap are checked independently" do
    f = fixture()

    assert {:error, :malformed_catalog} =
             CatalogEntries.observe(Map.put(f.catalog, :trusted, true), f.histories)

    catalog = %{
      f.catalog
      | bootstrap: f.space.creation.id,
        entries:
          Enum.map(f.catalog.entries, fn
            %{kind: :space} = entry -> %{entry | reference: f.space.creation.id}
            entry -> entry
          end)
    }

    assert {:ok, _} = Treehouse.TransportCatalog.normalize_catalog(catalog)
    assert {:error, :invalid_catalog_transition} = CatalogEntries.observe(catalog, f.histories)
  end

  test "legacy root-bound, wrong-kind and unsupported families cannot enter this catalog profile" do
    for family <- [:legacy, :wrong_kind, :unsupported] do
      f = fixture(family)
      assert :ok = Log.verify_authenticity(f.thread_log)
      assert {:ok, _} = Treehouse.TransportCatalog.normalize_catalog(f.catalog)

      assert {:error, :invalid_catalog_transition} =
               CatalogEntries.observe(f.catalog, f.histories)
    end
  end

  test "validated rejected evidence is preserved beside authentic named operations" do
    f = fixture()
    before_creation = Log.new(f.thread_replica) |> Log.append!(f.thread_genesis)
    forged = %{f.thread_creation | sig: <<0::512>>}
    assert {:quarantined, log, :bad_signature} = Log.accept(before_creation, forged)
    assert {:ok, log} = Log.accept(log, f.thread_creation)
    histories = Map.put(f.histories, f.thread_replica, log)
    before = :erlang.term_to_binary(histories)
    assert {:ok, _} = CatalogEntries.observe(f.catalog, histories)
    assert :erlang.term_to_binary(histories) == before
  end

  test "an honored reference to a different child is not proof of the catalogued child" do
    f = fixture()

    other =
      Authority.bind_replica(
        "replica:treehouse:thread:" <> id("other") <> "#authority:bounded-continuation-v1",
        f.thread_root.pub
      )

    reference =
      Op.new(
        f.space.root,
        f.space.replica,
        Log.frontier(f.histories[f.space.replica]),
        :command,
        {:create_thread, [other, "Another child"]},
        cap: f.space.delegation.id
      )

    log = Log.append!(f.histories[f.space.replica], reference)
    refute MapSet.member?(Authority.analyze(Treehouse.Space, log).quarantine, reference.id)

    assert {:error, :invalid_catalog_transition} =
             CatalogEntries.observe(
               replace_thread(f.catalog, %{reference: reference.id}),
               Map.put(f.histories, f.space.replica, log)
             )
  end

  test "a signed but unauthorized bootstrap cannot establish the service binding" do
    f = fixture()
    stranger = Identity.from_seed("stranger", "catalog-entry-bootstrap-impostor")

    bootstrap =
      Op.new(
        stranger,
        f.space.replica,
        Log.frontier(f.histories[f.space.replica]),
        :command,
        {:catalog_bootstrap_v1, [f.space.record]},
        cap: f.space.delegation.id
      )

    log = Log.append!(f.histories[f.space.replica], bootstrap)
    assert MapSet.member?(Authority.analyze(Treehouse.Space, log).quarantine, bootstrap.id)

    catalog = %{
      f.catalog
      | bootstrap: bootstrap.id,
        entries:
          Enum.map(f.catalog.entries, fn
            %{kind: :space} = entry -> %{entry | reference: bootstrap.id}
            entry -> entry
          end)
    }

    assert {:ok, _} = Treehouse.TransportCatalog.normalize_catalog(catalog)

    assert {:error, :invalid_catalog_transition} =
             CatalogEntries.observe(catalog, Map.put(f.histories, f.space.replica, log))
  end

  defp replace_thread(catalog, change) do
    %{
      catalog
      | entries:
          Enum.map(catalog.entries, fn entry ->
            if entry.kind == :thread, do: Map.merge(entry, change), else: entry
          end)
    }
  end

  defp fixture(family \\ :bounded) do
    space = CatalogVectors.bootstrap_history()
    thread_root = Identity.from_seed("thread-root", "catalog-entry-independent-thread")

    thread_replica =
      Authority.bind_replica(
        thread_name(family),
        thread_root.pub
      )

    grant =
      Delegation.genesis(thread_root, thread_replica,
        ops: [:create_thread, :post, :archive_thread],
        roles: [:moderator]
      )

    thread_genesis = Op.new(thread_root, thread_replica, [], :authority, {:genesis, grant, %{}})

    thread_creation =
      Op.new(
        thread_root,
        thread_replica,
        [thread_genesis.id],
        :command,
        {:create_thread, ["Fieldnotes"]},
        cap: grant.id
      )

    thread_log =
      Log.new(thread_replica) |> Log.append!(thread_genesis) |> Log.append!(thread_creation)

    reference =
      Op.new(
        space.root,
        space.replica,
        Log.frontier(space.log),
        :command,
        {:create_thread, [thread_replica, "Fieldnotes"]},
        cap: space.delegation.id
      )

    space_log = Log.append!(space.log, reference)

    entries = [
      %{
        product: :treehouse,
        replica: space.replica,
        kind: :space,
        schema: :treehouse_space_v1,
        root: space.root.pub,
        genesis: space.genesis.id,
        creation: space.creation.id,
        reference: space.bootstrap.id,
        route: "/r/" <> id("space-route"),
        service_id: space.record.service_id,
        service_key: space.record.service_key
      },
      %{
        product: :treehouse,
        replica: thread_replica,
        kind: :thread,
        schema: :treehouse_thread_v1,
        root: thread_root.pub,
        genesis: thread_genesis.id,
        creation: thread_creation.id,
        reference: reference.id,
        route: "/r/" <> id("thread-route"),
        service_id: space.record.service_id,
        service_key: space.record.service_key
      }
    ]

    catalog = %{
      version: 1,
      product: :treehouse,
      space: space.replica,
      bootstrap: space.bootstrap.id,
      binding: space.bootstrap.id,
      revision: 0,
      previous: nil,
      entries: Enum.sort_by(entries, & &1.replica)
    }

    %{
      space: space,
      thread_root: thread_root,
      thread_replica: thread_replica,
      thread_genesis: thread_genesis,
      thread_creation: thread_creation,
      thread_log: thread_log,
      reference: reference,
      catalog: catalog,
      histories: %{space.replica => space_log, thread_replica => thread_log}
    }
  end

  defp thread_name(:bounded),
    do: "replica:treehouse:thread:" <> id("thread") <> "#authority:bounded-continuation-v1"

  defp thread_name(:legacy), do: "replica:treehouse:thread:" <> id("thread")

  defp thread_name(:wrong_kind),
    do: "replica:treehouse:space:" <> id("thread") <> "#authority:bounded-continuation-v1"

  defp thread_name(:unsupported),
    do: "replica:treehouse:thread:" <> id("thread") <> "#authority:bounded-continuation-v2"

  defp id(label),
    do: :crypto.hash(:sha256, "r11a-entry-" <> label) |> Base.url_encode64(padding: false)
end
