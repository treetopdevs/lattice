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
        {:create_thread, [f.thread_replica, "Pretend listing"]}, cap: f.space.delegation.id)

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

  defp replace_thread(catalog, change) do
    %{
      catalog
      | entries:
          Enum.map(catalog.entries, fn entry ->
            if entry.kind == :thread, do: Map.merge(entry, change), else: entry
          end)
    }
  end

  defp fixture do
    space = CatalogVectors.bootstrap_history()
    thread_root = Identity.from_seed("thread-root", "catalog-entry-independent-thread")

    thread_replica =
      Authority.bind_replica(
        "replica:treehouse:thread:" <> id("thread") <> "#authority:bounded-continuation-v1",
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
        {:create_thread, ["Fieldnotes"]}, cap: grant.id)

    thread_log =
      Log.new(thread_replica) |> Log.append!(thread_genesis) |> Log.append!(thread_creation)

    reference =
      Op.new(
        space.root,
        space.replica,
        Log.frontier(space.log),
        :command,
        {:create_thread, [thread_replica, "Fieldnotes"]}, cap: space.delegation.id)

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

  defp id(label),
    do: :crypto.hash(:sha256, "r11a-entry-" <> label) |> Base.url_encode64(padding: false)
end
