defmodule LatticeCarrierServer.Operator.CatalogClosedBindingSigningTest do
  # Row 360 (plan 316 PR 3 residual, D-459): the custodian refuses to sign under a binding
  # the PR 4a resolver closes, judged over the package's histories, the ledger's own signed
  # envelopes and retained rotations/catalogs. Disposable seeded fixture keys only. Not
  # retained-client acceptance, a route switch, 4c wiring or a freshness guarantee.
  use ExUnit.Case, async: false

  alias Lattice.Log
  alias LatticeCarrierServer.Operator.CatalogSigningPackage

  alias LatticeCarrierServer.Operator.CatalogCeremony.{
    Binding,
    BindingClosure,
    SignCatalog,
    Signer,
    SigningLedger
  }

  alias LatticeCarrierServer.Secret
  alias Treehouse.CatalogBindingGraph
  alias Treehouse.CatalogBindingGraphFixtures, as: F
  alias Treehouse.TransportCatalog

  setup_all do
    base = F.base()
    c0 = catalog(base, 0, nil, entries(base, ["thread"]))
    c1 = catalog(base, 1, F.cid(c0), entries(base, ["thread", "thread2"]))
    {:ok, base: base, c0: c0, c1: c1, b: base.boot.id}
  end

  setup do
    dir = Path.join(System.tmp_dir!(), "r360-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    File.chmod!(dir, 0o700)
    on_exit(fn -> File.rm_rf(dir) end)
    {:ok, dir: dir}
  end

  # --- fixtures -----------------------------------------------------------------

  # The bootstrap Space entry plus one pool Thread per name, each on its own route, under the
  # bootstrap service pair (a bootstrap revision 0 is exactly one Space and one Thread).
  defp entries(base, threads) do
    [space] = F.base_entries(base, "r360-space")

    [space | for(name <- threads, do: thread(base, space, name))]
  end

  defp thread(base, space, name),
    do: %{F.pool_thread(base, space, name) | route: "/r/" <> F.id("r360-route-" <> name)}

  defp catalog(base, revision, previous, entries),
    do: F.catalog(base, base.boot.id, revision, previous, base.catalog, entries)

  defp bootstrap_binding(base) do
    %{
      bootstrap_id: base.boot.id,
      record: base.record,
      realm: TransportCatalog.service_realm(base.record.service_id),
      attested: %{}
    }
  end

  defp package(base, log, binding, envelope) do
    %{
      catalog: envelope.catalog,
      digest: CatalogSigningPackage.digest(envelope.catalog),
      binding: binding,
      histories: Map.put(F.histories(base), base.replica, log)
    }
  end

  defp ledger!(f, name, binding, identity) do
    ceremony = Path.join(f.dir, "ceremony-" <> name)
    File.mkdir_p!(ceremony)
    File.chmod!(ceremony, 0o700)
    assert {:ok, _} = SigningLedger.init(ceremony, binding)
    keys = Path.join(f.dir, "keys-" <> name)
    File.mkdir_p!(keys)
    File.chmod!(keys, 0o700)
    seed = Path.join(keys, "signer.seed")
    {:ok, _} = Signer.write_seed(seed, Secret.wrap(identity.priv))
    {ceremony, seed}
  end

  defp sign(package, ceremony, seed, opts \\ []),
    do: SignCatalog.sign_reviewed(package, ceremony, seed, package.digest, opts)

  defp resolve(base, log, catalogs, rotations \\ []) do
    CatalogBindingGraph.resolve(%{
      bootstrap: base.boot,
      space: log,
      histories: F.histories(base),
      rotations: Map.new(rotations, &{TransportCatalog.rotation_id(&1), &1}),
      catalogs: Map.new(catalogs, &{F.cid(&1), &1}),
      proven_cutoffs: [],
      accepted: nil
    })
  end

  # Sign c0 under the bootstrap binding on the base history (the ledger then holds it).
  defp signed_c0!(f, name) do
    binding = bootstrap_binding(f.base)
    {ceremony, seed} = ledger!(f, name, binding, f.base.catalog)
    assert {:ok, _} = sign(package(f.base, f.base.log, binding, f.c0), ceremony, seed)
    {binding, ceremony, seed}
  end

  # --- cases --------------------------------------------------------------------

  test "the resolver surface the check reads is resolve/1, closed/1 and closed_out/1 (R4)" do
    Code.ensure_loaded!(CatalogBindingGraph)
    assert function_exported?(CatalogBindingGraph, :resolve, 1)
    assert function_exported?(CatalogBindingGraph, :closed, 1)
    assert function_exported?(CatalogBindingGraph, :closed_out, 1)
  end

  test "an open bootstrap binding signs and replays keyless with :ok", f do
    binding = bootstrap_binding(f.base)
    {ceremony, seed} = ledger!(f, "open", binding, f.base.catalog)
    package = package(f.base, f.base.log, binding, f.c0)

    assert :ok = BindingClosure.check(package, [])
    assert {:ok, envelope} = sign(package, ceremony, seed)
    assert :ok = TransportCatalog.verify_catalog_json(envelope, f.base.catalog.pub)
    assert {:ok, ^envelope} = sign(package, ceremony, "/absent")
    assert {:ok, state} = SigningLedger.status(ceremony, binding)
    assert :ok = BindingClosure.check(package, state.chain)
  end

  test "a replacement citing {B, nil} refuses B with :catalog_binding_closed before key access",
       f do
    r = F.replacement(f.base, f.base.log, "r360-direct")
    log = F.append(f.base.log, [r.op])
    assert {:ok, g} = resolve(f.base, log, [])
    assert f.b in CatalogBindingGraph.closed(g)

    binding = bootstrap_binding(f.base)
    {ceremony, seed} = ledger!(f, "direct", binding, f.base.catalog)
    package = package(f.base, log, binding, f.c0)

    assert {:error, :catalog_binding_closed} = sign(package, ceremony, seed)
    assert {:error, :catalog_binding_closed} = sign(package, ceremony, "/absent")
    assert {:ok, %{chain: [], committed: nil}} = SigningLedger.status(ceremony, binding)
  end

  test "a cited prior held only by the ledger closes B with :catalog_binding_closed", f do
    {binding, ceremony, seed} = signed_c0!(f, "ledger-prior")

    r =
      F.replacement(f.base, f.base.log, "r360-cite-c0",
        prior_catalogs: [%{binding: f.b, catalog: F.cid(f.c0)}]
      )

    log = F.append(f.base.log, [r.op])

    # Without the ledger's c0 the cited prior is not held: the resolver pends.
    assert {:error, :trust_pending, _} = resolve(f.base, log, [])
    assert {:ok, g} = resolve(f.base, log, [f.c0])
    assert f.b in CatalogBindingGraph.closed(g)

    package = package(f.base, log, binding, f.c1)
    assert {:error, :catalog_binding_closed} = sign(package, ceremony, seed)
    assert {:ok, state} = SigningLedger.status(ceremony, binding)
    assert length(state.chain) == 1 and state.head["revision"] == 0
  end

  test "a stored replay under a closed binding is :catalog_binding_closed and keeps the head",
       f do
    {binding, ceremony, seed} = signed_c0!(f, "replay")
    {:ok, before} = SigningLedger.status(ceremony, binding)

    r =
      F.replacement(f.base, f.base.log, "r360-replay",
        prior_catalogs: [%{binding: f.b, catalog: F.cid(f.c0)}]
      )

    log = F.append(f.base.log, [r.op])
    package = package(f.base, log, binding, f.c0)

    assert {:error, :catalog_binding_closed} = sign(package, ceremony, seed)
    assert {:error, :catalog_binding_closed} = sign(package, ceremony, "/absent")
    assert {:ok, later} = SigningLedger.status(ceremony, binding)
    assert later.head_bytes == before.head_bytes
    assert Enum.map(later.chain, & &1.bytes) == Enum.map(before.chain, & &1.bytes)
  end

  describe "ancestor B of a cited rotation T" do
    setup f do
      rotated = F.identity("rot-r360-t")
      t = F.rotation(f.base, %{id: f.b, generation: 0}, f.c0, f.base.catalog, rotated, "r360-t")
      ct = F.catalog(f.base, t.id, 0, nil, rotated, f.c0.catalog.entries)

      r =
        F.replacement(f.base, f.base.log, "r360-f2",
          parents: [t.id],
          prior_catalogs: [%{binding: t.id, catalog: F.cid(ct)}],
          generation: 2
        )

      {:ok, t: t, ct: ct, log: F.append(f.base.log, [r.op])}
    end

    test "refuses under ancestor B of cited rotation T with :catalog_binding_closed", f do
      assert {:ok, g} = resolve(f.base, f.log, [f.c0, f.ct], [f.t.envelope])
      assert f.b in CatalogBindingGraph.closed(g)
      assert f.t.id in CatalogBindingGraph.closed(g)

      {binding, ceremony, seed} = signed_c0!(f, "rotation")
      package = package(f.base, f.log, binding, f.c1)

      assert {:error, :catalog_binding_closed} =
               sign(package, ceremony, seed,
                 retained: [rotations: [f.t.envelope], catalogs: [f.ct]]
               )
    end

    test "refuses with :catalog_binding_unresolved when T is not supplied (never signs)", f do
      assert {:error, :trust_pending, _} = resolve(f.base, f.log, [f.c0])

      {binding, ceremony, seed} = signed_c0!(f, "rotation-absent")
      package = package(f.base, f.log, binding, f.c1)

      assert {:error, :catalog_binding_unresolved} = sign(package, ceremony, seed)
      assert {:ok, %{head: %{"revision" => 0}}} = SigningLedger.status(ceremony, binding)
    end
  end

  test "a union-refused but D-276-eligible R' citing B still refuses with :catalog_binding_closed",
       f do
    {binding, ceremony, seed} = signed_c0!(f, "union-refused")

    r =
      F.replacement(f.base, f.base.log, "r360-refused",
        prior_catalogs: [%{binding: f.b, catalog: F.cid(f.c0)}]
      )

    rv = F.revoke(f.base, Log.frontier(f.base.log), f.base.delegation.id)
    log = F.append(f.base.log, [r.op, rv])

    assert {:ok, g} = resolve(f.base, log, [f.c0])
    assert CatalogBindingGraph.node(g, r.id).refused?
    assert f.b in CatalogBindingGraph.closed(g)

    package = package(f.base, log, binding, f.c1)
    assert {:error, :catalog_binding_closed} = sign(package, ceremony, seed)
  end

  test "a replacement binding closed by a successor replacement is :catalog_binding_closed", f do
    r = F.replacement(f.base, f.base.log, "r360-r")
    log = F.append(f.base.log, [r.op])
    {:ok, derived} = Binding.replacement(bootstrap_binding(f.base), r.claim, r.id)
    {ceremony, seed} = ledger!(f, "replacement", derived, r.catalog_key)
    kr = F.first(f.base, r)
    package = package(f.base, log, derived, kr)

    assert {:ok, envelope} = sign(package, ceremony, seed)
    assert {:ok, ^envelope} = sign(package, ceremony, "/absent")

    r2 =
      F.replacement(f.base, log, "r360-r2",
        parents: [r.id],
        prior_catalogs: [%{binding: r.id, catalog: nil}],
        generation: 2
      )

    closed = F.append(log, [r2.op])
    assert {:ok, g} = resolve(f.base, closed, [kr])
    assert r.id in CatalogBindingGraph.closed(g)

    assert {:error, :catalog_binding_closed} =
             sign(package(f.base, closed, derived, kr), ceremony, "/absent")
  end

  test "a bootstrap binding whose record differs from the Space's is :catalog_binding_unresolved",
       f do
    binding = bootstrap_binding(f.base)
    wrong = %{binding | record: %{binding.record | nonce: F.id("r360-other-nonce")}}
    {ceremony, seed} = ledger!(f, "wrong-record", wrong, f.base.catalog)
    package = package(f.base, f.base.log, wrong, f.c0)

    assert {:error, :catalog_binding_unresolved} = sign(package, ceremony, seed)
    assert {:ok, %{chain: [], committed: nil}} = SigningLedger.status(ceremony, wrong)
  end

  test "three binding heads (control_history_limit) are :catalog_binding_unresolved", f do
    rs = for name <- ~w(r360-h1 r360-h2 r360-h3), do: F.replacement(f.base, f.base.log, name)
    log = F.append(f.base.log, Enum.map(rs, & &1.op))
    assert {:error, :control_history_limit, _} = resolve(f.base, log, [])

    binding = bootstrap_binding(f.base)
    {ceremony, seed} = ledger!(f, "heads", binding, f.base.catalog)

    assert {:error, :catalog_binding_unresolved} =
             sign(package(f.base, log, binding, f.c0), ceremony, seed)
  end

  test "the observed Space a package was decoded against is the one judged (D-910)", f do
    r = F.replacement(f.base, f.base.log, "r360-observed")
    log = F.append(f.base.log, [r.op])
    binding = bootstrap_binding(f.base)
    package = package(f.base, f.base.log, binding, f.c0)

    assert :ok = BindingClosure.check(package, [])

    observed = Map.put(package.histories, f.base.replica, log)

    assert {:error, :catalog_binding_closed} =
             BindingClosure.check(Map.put(package, :observed, observed), [])
  end

  test "a package without an authenticated Space log is :catalog_binding_unresolved", f do
    binding = bootstrap_binding(f.base)
    package = package(f.base, f.base.log, binding, f.c0)

    assert {:error, :catalog_binding_unresolved} =
             BindingClosure.check(%{package | histories: F.histories(f.base)}, [])
  end
end
