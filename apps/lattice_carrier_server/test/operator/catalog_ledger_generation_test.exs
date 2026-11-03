defmodule LatticeCarrierServer.Operator.CatalogLedgerGenerationTest do
  # Plan 316 PR 3 (fixture-only part): the custodian signing ledger is keyed by
  # {binding_id, catalog_key}. A bootstrap binding keeps today's bytes; a
  # replacement binding derived from a normalized claim starts a fresh ledger
  # whose revision 0 is the claim's committed inventory. Disposable seeded keys
  # only; the op id is a fixture value, not a resolver decision (PR 4).
  use ExUnit.Case, async: false

  alias Lattice.Carrier.Wire
  alias Lattice.Identity
  alias LatticeCarrierServer.Operator.CatalogCeremony.{Binding, SigningLedger}
  alias LatticeCarrierServer.Operator.PublicHistory
  alias Treehouse.TransportCatalog

  @space "replica:treehouse:space:r316-ledger"
  @thread "replica:treehouse:thread:r316-ledger"

  # Computed on origin/main e6df0497f before the PR 3 change.
  @genesis_head ~s({"binding":"gNyo4qAiPniKUucOqMhxb44etGZPHhbjv5u_eEEvkAA","id":null,"key":"mYXgLTFyVlItt5bhhZ4kNWQZsDq0fWy/9m3qbdrgpbk=","revision":null})
  @revision_head ~s({"binding":"gNyo4qAiPniKUucOqMhxb44etGZPHhbjv5u_eEEvkAA","id":"_NbdJ-Mm4Lg7_WjDKZv9ktQs-pg5GApB0rC6cOpSXdE","key":"mYXgLTFyVlItt5bhhZ4kNWQZsDq0fWy/9m3qbdrgpbk=","revision":0})
  @genesis_status ~s({"binding":"gNyo4qAiPniKUucOqMhxb44etGZPHhbjv5u_eEEvkAA","envelopes":[],"format":"treehouse-custodian-status-v1","head":"{\\"binding\\":\\"gNyo4qAiPniKUucOqMhxb44etGZPHhbjv5u_eEEvkAA\\",\\"id\\":null,\\"key\\":\\"mYXgLTFyVlItt5bhhZ4kNWQZsDq0fWy/9m3qbdrgpbk=\\",\\"revision\\":null}","key":"mYXgLTFyVlItt5bhhZ4kNWQZsDq0fWy/9m3qbdrgpbk="})
  @committed_status_sha256 "35dacda79ce16776937a13843e02327e2973785004b872b790c52fe62f21e0fd"

  setup do
    base = Path.join(System.tmp_dir!(), "r316-ledger-#{System.unique_integer([:positive])}")
    File.mkdir_p!(base)
    File.chmod!(base, 0o700)
    on_exit(fn -> File.rm_rf(base) end)

    old_catalog = Identity.from_seed("catalog", "r316-ledger-bootstrap-catalog")
    old_service = Identity.from_seed("service", "r316-ledger-bootstrap-service")
    new_catalog = Identity.from_seed("catalog", "r316-ledger-replacement-catalog")
    new_service = Identity.from_seed("service", "r316-ledger-replacement-service")
    root = Identity.from_seed("root", "r316-ledger-root")

    record = %{
      version: 1,
      product: :treehouse,
      space: @space,
      space_root: root.pub,
      profile_genesis: id("r316-profile-genesis"),
      profile_id: id("r316-profile-id"),
      replacement_rule: :bounded_space_admin_v1,
      catalog_key: old_catalog.pub,
      service_id: id("r316-bootstrap-service"),
      service_key: old_service.pub,
      origin: "wss://relay.example.test",
      nonce: id("r316-bootstrap-nonce")
    }

    {:ok, ^record} = TransportCatalog.normalize_bootstrap(record)

    bootstrap = %{
      bootstrap_id: id("r316-bootstrap"),
      record: record,
      realm: TransportCatalog.service_realm(record.service_id),
      attested: %{}
    }

    new_service_id = id("r316-replacement-service")

    inventory = [
      entry(@space, :space, bootstrap.bootstrap_id, "space", new_service_id, new_service.pub),
      entry(@thread, :thread, id("r316-thread-ref"), "thread", new_service_id, new_service.pub)
    ]

    claim = %{
      version: 1,
      product: :treehouse,
      space: @space,
      bootstrap: bootstrap.bootstrap_id,
      profile_genesis: record.profile_genesis,
      profile_id: record.profile_id,
      parents: [bootstrap.bootstrap_id],
      prior_catalogs: [%{binding: bootstrap.bootstrap_id, catalog: nil}],
      generation: 1,
      nonce: id("r316-replacement-nonce"),
      new_catalog_key: new_catalog.pub,
      new_service_id: new_service_id,
      new_service_key: new_service.pub,
      new_origin: "wss://replacement-relay.invalid:8443",
      inventory_digest: TransportCatalog.inventory_id(inventory),
      cutoffs: [%{replica: @space, frontier: [id("r316-frontier")], log_digest: id("r316-log")}],
      author: root.pub,
      cap: id("r316-cap"),
      holder_epoch: id("r316-holder-epoch"),
      deps: [id("r316-dep")],
      epoch: 1,
      epoch_basis: [id("r316-beacon")]
    }

    {:ok, ^claim} = TransportCatalog.normalize_replacement_claim(claim)
    op_id = id("r316-replacement-op")
    {:ok, replacement} = Binding.replacement(bootstrap, claim, op_id)

    {:ok,
     base: base,
     bootstrap: bootstrap,
     replacement: replacement,
     claim: claim,
     op_id: op_id,
     inventory: inventory,
     old_catalog: old_catalog,
     old_service: old_service,
     new_catalog: new_catalog,
     new_service: new_service}
  end

  # ---------------------------------------------------------------- helpers

  defp id(label), do: :crypto.hash(:sha256, label) |> Base.url_encode64(padding: false)

  defp entry(replica, kind, reference, label, service_id, service_key) do
    %{
      product: :treehouse,
      replica: replica,
      kind: kind,
      schema: if(kind == :space, do: :treehouse_space_v1, else: :treehouse_thread_v1),
      root: :crypto.hash(:sha256, "r316-root-" <> label),
      genesis: id("r316-genesis-" <> label),
      creation: id("r316-creation-" <> label),
      reference: reference,
      route: "/r/" <> id("r316-route-" <> label),
      service_id: service_id,
      service_key: service_key
    }
  end

  defp bootstrap_catalog(f) do
    b = f.bootstrap

    %{
      version: 1,
      product: :treehouse,
      space: @space,
      bootstrap: b.bootstrap_id,
      binding: b.bootstrap_id,
      revision: 0,
      previous: nil,
      entries: [
        entry(@space, :space, b.bootstrap_id, "space", b.record.service_id, b.record.service_key),
        entry(
          @thread,
          :thread,
          id("r316-thread-ref"),
          "thread",
          b.record.service_id,
          b.record.service_key
        )
      ]
    }
  end

  defp replacement_catalog(f, entries \\ nil) do
    %{
      version: 1,
      product: :treehouse,
      space: @space,
      bootstrap: f.bootstrap.bootstrap_id,
      binding: f.op_id,
      revision: 0,
      previous: nil,
      entries: entries || f.inventory
    }
  end

  defp envelope(catalog, signer) do
    signed = %{
      catalog: catalog,
      signature: Identity.sign(signer, TransportCatalog.catalog_bytes(catalog))
    }

    PublicHistory.canonical(Wire.encode_value(signed))
  end

  # Commit one envelope through the real owner without a BEAM-side chain check;
  # whatever is written is judged on the next open.
  defp commit(dir, binding, catalog, signer) do
    bytes = envelope(catalog, signer)
    head = SigningLedger.head(binding, catalog.revision, TransportCatalog.catalog_id(catalog))

    with {:ok, _} <-
           SigningLedger.transact(dir, binding, "open", fn _ -> {:ok, head, bytes, bytes} end),
         do: {:ok, bytes}
  end

  defp ledger_dir(f, name) do
    dir = Path.join(f.base, name)
    File.mkdir_p!(dir)
    File.chmod!(dir, 0o700)
    dir
  end

  defp head_path(dir), do: Path.join([dir, "catalog-signing", "head.json"])

  # ---------------------------------------------------------------- tests

  test "a bootstrap binding keeps its ledger head and custodian status bytes", f do
    b = f.bootstrap
    same = Map.put(b, :binding_id, b.bootstrap_id)

    for binding <- [b, same] do
      assert Binding.binding_id(binding) == b.bootstrap_id
      assert SigningLedger.head(binding, nil, nil) == @genesis_head
      assert SigningLedger.head(binding, 0, id("r316-catalog")) == @revision_head
    end

    dir = ledger_dir(f, "bootstrap")
    assert {:ok, genesis} = SigningLedger.init(dir, b)
    assert genesis.head_bytes == @genesis_head
    assert SigningLedger.export_status(genesis, b) == @genesis_status
    assert SigningLedger.export_status(genesis, same) == @genesis_status

    catalog = bootstrap_catalog(f)
    assert SigningLedger.extends?(catalog, nil)
    assert SigningLedger.extends?(catalog, nil, b)
    assert {:ok, _} = commit(dir, b, catalog, f.old_catalog)
    assert {:ok, state} = SigningLedger.status(dir, b)
    status = SigningLedger.export_status(state, b)
    assert Base.encode16(:crypto.hash(:sha256, status), case: :lower) == @committed_status_sha256
    assert {:ok, _} = SigningLedger.verify_status(status, b)
    assert {:ok, _} = SigningLedger.verify_status(status, same)
  end

  test "Binding.replacement/3 derives the new binding from a normalized claim", f do
    r = f.replacement
    claim = f.claim
    b = f.bootstrap

    assert r.kind == :replacement
    assert r.binding_id == f.op_id
    assert Binding.binding_id(r) == f.op_id
    assert r.bootstrap_id == b.bootstrap_id
    assert r.generation == claim.generation
    assert r.inventory_digest == claim.inventory_digest
    assert r.record.catalog_key == claim.new_catalog_key
    assert r.record.service_id == claim.new_service_id
    assert r.record.service_key == claim.new_service_key
    assert r.record.origin == claim.new_origin
    assert r.record.space == b.record.space
    assert r.realm == TransportCatalog.service_realm(claim.new_service_id)
    refute Map.has_key?(r, :attested)

    for bad <- [
          {b, %{claim | bootstrap: id("another-bootstrap")}, f.op_id},
          {b, %{claim | space: "replica:treehouse:space:another"}, f.op_id},
          {b, %{claim | profile_genesis: id("another-profile-genesis")}, f.op_id},
          {b, %{claim | profile_id: id("another-profile-id")}, f.op_id},
          {b, %{claim | generation: 2}, f.op_id},
          {b,
           %{
             claim
             | parents: [id("r316-other-parent")],
               prior_catalogs: [%{binding: id("r316-other-parent"), catalog: nil}]
           }, f.op_id},
          {b,
           %{
             claim
             | parents: Enum.sort([b.bootstrap_id, id("r316-other-parent")]),
               prior_catalogs:
                 Enum.sort([b.bootstrap_id, id("r316-other-parent")])
                 |> Enum.map(&%{binding: &1, catalog: nil})
           }, f.op_id},
          {b, Map.put(claim, :extra, 1), f.op_id},
          {b, Map.delete(claim, :cutoffs), f.op_id},
          {b, nil, f.op_id},
          {b, claim, "not-an-op-id"},
          {b, claim, nil},
          {b, claim, b.bootstrap_id},
          {r, claim, id("r316-second-op")}
        ] do
      {parent, value, op_id} = bad
      assert {:error, :malformed_binding} = Binding.replacement(parent, value, op_id)
    end
  end

  test "a replacement binding initializes a fresh ledger and accepts revision 0 under its own binding id",
       f do
    r = f.replacement
    dir = ledger_dir(f, "replacement")
    assert {:ok, genesis} = SigningLedger.init(dir, r)
    assert Jason.decode!(genesis.head_bytes)["binding"] == f.op_id
    assert Jason.decode!(genesis.head_bytes)["key"] == Base.encode64(f.claim.new_catalog_key)

    catalog = replacement_catalog(f)
    assert SigningLedger.extends?(catalog, nil, r)

    assert {:ok, envelope} = commit(dir, r, catalog, f.new_catalog)
    assert {:ok, state} = SigningLedger.status(dir, r)
    assert state.committed.catalog.revision == 0
    assert state.committed.bytes == envelope
    assert state.pending == nil
    assert state.head["binding"] == f.op_id
    assert state.head["revision"] == 0
    assert state.head["id"] == TransportCatalog.catalog_id(catalog)
    assert {:ok, verified} = SigningLedger.verify_status(SigningLedger.export_status(state, r), r)
    assert verified.committed.catalog == catalog

    # Later revisions under R use the unchanged successor rule.
    second =
      entry(
        "replica:treehouse:thread:r316-second",
        :thread,
        id("r316-second-ref"),
        "second",
        f.claim.new_service_id,
        f.claim.new_service_key
      )

    next = %{
      catalog
      | revision: 1,
        previous: TransportCatalog.catalog_id(catalog),
        entries: Enum.sort_by(catalog.entries ++ [second], & &1.replica)
    }

    assert SigningLedger.extends?(next, state.committed, r)
    assert {:ok, _} = commit(dir, r, next, f.new_catalog)
    assert {:ok, %{committed: %{catalog: ^next}}} = SigningLedger.status(dir, r)

    # The custodian status for R never verifies under B.
    assert {:error, :catalog_ledger_corrupt} =
             SigningLedger.verify_status(SigningLedger.export_status(state, r), f.bootstrap)
  end

  test "a space-only revision 0 is a replacement shape, never a bootstrap shape", f do
    [space_entry, _] = f.inventory
    claim = %{f.claim | inventory_digest: TransportCatalog.inventory_id([space_entry])}
    {:ok, r} = Binding.replacement(f.bootstrap, claim, f.op_id)
    assert SigningLedger.extends?(replacement_catalog(f, [space_entry]), nil, r)

    b = f.bootstrap
    [space_only, _] = bootstrap_catalog(f).entries
    refute SigningLedger.extends?(%{bootstrap_catalog(f) | entries: [space_only]}, nil, b)
  end

  test "a space-only replacement genesis reaches all 12 Threads within the envelope bound",
       f do
    [space_entry, _] = f.inventory
    claim = %{f.claim | inventory_digest: TransportCatalog.inventory_id([space_entry])}
    {:ok, r} = Binding.replacement(f.bootstrap, claim, f.op_id)
    dir = ledger_dir(f, "space-only-full")
    {:ok, _} = SigningLedger.init(dir, r)

    genesis = replacement_catalog(f, [space_entry])
    assert {:ok, _} = commit(dir, r, genesis, f.new_catalog)

    last =
      Enum.reduce(1..12, genesis, fn n, previous ->
        label = "full-#{String.pad_leading(Integer.to_string(n), 2, "0")}"

        thread =
          entry(
            "replica:treehouse:thread:r316-" <> label,
            :thread,
            id("r316-ref-" <> label),
            label,
            claim.new_service_id,
            claim.new_service_key
          )

        next = %{
          previous
          | revision: n,
            previous: TransportCatalog.catalog_id(previous),
            entries: Enum.sort_by(previous.entries ++ [thread], & &1.replica)
        }

        assert {:ok, state} = SigningLedger.status(dir, r)
        assert SigningLedger.extends?(next, state.committed, r)
        assert {:ok, _} = commit(dir, r, next, f.new_catalog)
        next
      end)

    assert {:ok, state} = SigningLedger.status(dir, r)
    assert state.committed.catalog == last
    assert length(state.chain) == 13
    assert Enum.count(last.entries, &(&1.kind == :thread)) == 12
    assert {:ok, _} = SigningLedger.verify_status(SigningLedger.export_status(state, r), r)

    # A bootstrap ledger keeps its 12-envelope bound: its genesis already holds a Thread.
    assert SigningLedger.max_envelopes(f.bootstrap) == 12
    assert SigningLedger.max_envelopes(r) == 13
  end

  test "replacement revision 0 must match the claim inventory digest", f do
    r = f.replacement
    [space_entry, thread_entry] = f.inventory
    changed = %{thread_entry | route: "/r/" <> id("r316-other-route")}

    for entries <- [[space_entry], [space_entry, changed]] do
      catalog = replacement_catalog(f, entries)
      refute SigningLedger.extends?(catalog, nil, r)

      dir = ledger_dir(f, "digest-#{length(entries)}-#{System.unique_integer([:positive])}")
      {:ok, _} = SigningLedger.init(dir, r)
      assert {:ok, _} = commit(dir, r, catalog, f.new_catalog)
      assert {:error, :catalog_ledger_corrupt} = SigningLedger.status(dir, r)
    end

    # A later revision 0 shape is still required: revision and previous are fixed.
    refute SigningLedger.extends?(%{replacement_catalog(f) | revision: 1}, nil, r)
  end

  test "an entry that keeps the parent service identity is refused under a replacement binding",
       f do
    r = f.replacement
    old = f.bootstrap.record

    for {field, value} <- [service_id: old.service_id, service_key: old.service_key] do
      entries = Enum.map(f.inventory, &Map.put(&1, field, value))
      claim = %{f.claim | inventory_digest: TransportCatalog.inventory_id(entries)}
      {:ok, r2} = Binding.replacement(f.bootstrap, claim, f.op_id)
      refute SigningLedger.extends?(replacement_catalog(f, entries), nil, r2)
    end

    # Mixed services are not even a catalog; the closed codec refuses them first.
    [space_entry, thread_entry] = f.inventory
    mixed = [space_entry, %{thread_entry | service_key: old.service_key}]

    assert {:error, :malformed_catalog} =
             TransportCatalog.normalize_catalog(replacement_catalog(f, mixed))

    assert SigningLedger.extends?(replacement_catalog(f), nil, r)
  end

  test "binding ids do not cross ledgers", f do
    r = f.replacement
    b = f.bootstrap

    # A catalog that names B, signed by R's key, is refused by R's ledger.
    named_b = %{replacement_catalog(f) | binding: b.bootstrap_id}
    dir_r = ledger_dir(f, "cross-r")
    {:ok, _} = SigningLedger.init(dir_r, r)
    assert {:ok, _} = commit(dir_r, r, named_b, f.new_catalog)
    assert {:error, :catalog_ledger_corrupt} = SigningLedger.status(dir_r, r)

    # A catalog that names R over bootstrap B, signed by B's key, is refused by B's ledger.
    named_r = %{bootstrap_catalog(f) | binding: f.op_id}
    dir_b = ledger_dir(f, "cross-b")
    {:ok, _} = SigningLedger.init(dir_b, b)
    assert {:ok, _} = commit(dir_b, b, named_r, f.old_catalog)
    assert {:error, :catalog_ledger_corrupt} = SigningLedger.status(dir_b, b)
  end

  test "a ceremony directory that holds binding B refuses init and open for replacement binding R",
       f do
    dir = ledger_dir(f, "held-by-b")
    {:ok, _} = SigningLedger.init(dir, f.bootstrap)
    before = File.read!(head_path(dir))

    assert {:error, :catalog_ledger_corrupt} = SigningLedger.init(dir, f.replacement)
    assert {:error, :catalog_ledger_corrupt} = SigningLedger.status(dir, f.replacement)
    assert File.read!(head_path(dir)) == before
    assert {:ok, _} = SigningLedger.status(dir, f.bootstrap)
  end

  test "replay and crash refusals hold under a replacement binding", f do
    r = f.replacement
    catalog = replacement_catalog(f)

    # (a) Replaying the stored head and envelope is a durable no-op.
    dir = ledger_dir(f, "replay")
    {:ok, genesis} = SigningLedger.init(dir, r)
    {:ok, envelope} = commit(dir, r, catalog, f.new_catalog)
    committed_head = File.read!(head_path(dir))
    assert {:ok, ^envelope} = commit(dir, r, catalog, f.new_catalog)
    assert File.read!(head_path(dir)) == committed_head
    assert {:ok, %{chain: [_]}} = SigningLedger.status(dir, r)

    # (b) A competing revision 0 after commit is a fork; nothing changes.
    [space_entry, thread_entry] = f.inventory
    other = replacement_catalog(f, [space_entry, %{thread_entry | route: "/r/" <> id("fork")}])

    assert {:error, :catalog_ledger_fork} = commit(dir, r, other, f.new_catalog)
    assert File.read!(head_path(dir)) == committed_head
    assert {:ok, %{chain: [%{bytes: ^envelope}]}} = SigningLedger.status(dir, r)

    # (c) Envelope published, head still genesis: pending, not committed.
    File.write!(head_path(dir), genesis.head_bytes)
    assert {:ok, state} = SigningLedger.status(dir, r)
    assert state.committed == nil
    assert state.pending.bytes == envelope
    assert state.head["revision"] == nil
  end
end
