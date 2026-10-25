defmodule LatticeCarrierServer.Operator.ServiceBindingStagingTest do
  @moduledoc """
  Plan 224 PR 2: staging refuses every Treehouse instance that is not bound to
  the ceremony's service realm and key, and accepts the one reviewed migration.
  """
  use ExUnit.Case, async: false
  if :os.type() != {:unix, :linux}, do: @moduletag(skip: "Requires actual Linux OS lock")
  alias Lattice.{Authority, Identity, Log, Sim}
  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.Operator.{CatalogBinding, CatalogStore, Fixture, Journal, Staging}
  alias Treehouse.TransportCatalog

  setup do
    {:ok, data} = Fixture.new()
    {:ok, Map.new(data)}
  end

  # The candidate manifest artifact, decoded, rewritten by `fun` and re-encoded.
  defp mutate(f, fun) do
    Enum.map(f.artifacts, fn
      %{kind: :manifest} = manifest ->
        %{manifest | bytes: manifest.bytes |> Jason.decode!() |> fun.() |> Jason.encode!()}

      artifact ->
        artifact
    end)
  end

  defp both(fun), do: fn m -> Map.update!(m, "instances", fn [a, b] -> [fun.(a), fun.(b)] end) end
  defp child(fun), do: fn m -> Map.update!(m, "instances", fn [a, b] -> [a, fun.(b)] end) end
  defp space(fun), do: fn m -> Map.update!(m, "instances", fn [a, b] -> [fun.(a), b] end) end

  defp identity_file(f, name, seed) do
    path = Path.join(f.root, name)
    File.write!(path, Base.encode16(:crypto.hash(:sha256, seed), case: :lower))
    File.chmod!(path, 0o600)
    path
  end

  defp refuses(f, artifacts, reason) do
    assert {:error, ^reason} =
             Staging.prepare(f.root, nil, f.request, artifacts, f.ceremony_dir)

    assert {:ok, nil} = Journal.read(f.root)
    assert File.read!(f.active_log) == f.active_bytes
  end

  test "the honest bound candidate stages", f do
    assert {:ok, record} = Staging.prepare(f.root, nil, f.request, f.artifacts, f.ceremony_dir)
    assert record["service"]["realm"] == f.binding_realm
    assert record["service"]["pub"] == Base.encode64(f.service_pub)
  end

  test "an admitted instance under the wrong realm refuses", f do
    refuses(
      f,
      mutate(f, child(&Map.put(&1, "realm", "child-service"))),
      :service_binding_mismatch
    )
  end

  test "instances under the wrong service key refuse", f do
    other = identity_file(f, "other.identity", "other-service")

    refuses(
      f,
      mutate(f, both(&Map.put(&1, "identity_file", other))),
      :service_binding_mismatch
    )
  end

  test "a missing route refuses", f do
    refuses(f, mutate(f, child(&Map.delete(&1, "route"))), :service_binding_mismatch)
  end

  test "a missing Space route refuses", f do
    refuses(f, mutate(f, space(&Map.delete(&1, "route"))), :service_binding_mismatch)
  end

  test "a duplicate route is refused by the manifest", f do
    route = f.space_route
    refuses(f, mutate(f, child(&Map.put(&1, "route", route))), :invalid_candidate_manifest)
  end

  test "a trusted peer under the service realm refuses", f do
    key = Base.encode64(:crypto.hash(:sha256, "impostor"))
    peer = %{"realm" => f.binding_realm, "pubkey" => key}

    refuses(
      f,
      mutate(f, child(&Map.update!(&1, "trusted_peers", fn peers -> [peer | peers] end))),
      :service_binding_mismatch
    )
  end

  test "an unbound Space instance refuses", f do
    refuses(f, mutate(f, space(&Map.put(&1, "realm", "free-realm"))), :service_binding_mismatch)
  end

  test "instances with different identity files refuse", f do
    same = identity_file(f, "same-seed.identity", "child-service")
    refuses(f, mutate(f, child(&Map.put(&1, "identity_file", same))), :service_binding_mismatch)
  end

  test "relay realms short of the trusted realms refuse", f do
    refuses(
      f,
      mutate(f, child(&Map.update!(&1, "relay_realms", fn [_ | rest] -> rest end))),
      :relay_realms_unreviewed
    )
  end

  test "a Space instance with no relay realms refuses", f do
    refuses(f, mutate(f, space(&Map.put(&1, "relay_realms", []))), :relay_realms_unreviewed)
  end

  test "duplicated relay realms refuse", f do
    refuses(
      f,
      mutate(
        f,
        child(&Map.update!(&1, "relay_realms", fn [first | _] = all -> [first | all] end))
      ),
      :relay_realms_unreviewed
    )
  end

  test "trusted peers other than the root and roster refuse", f do
    refuses(
      f,
      mutate(f, space(&Map.update!(&1, "trusted_peers", fn [_ | rest] -> rest end))),
      :invalid_candidate_manifest
    )
  end

  # A second realm whose key duplicates a roster member's collapses in the
  # set comparison; relaying for it must still refuse.
  defp alias_peer(m) do
    [%{"pubkey" => member} | _] = m["trusted_peers"]

    m
    |> Map.update!("trusted_peers", &(&1 ++ [%{"realm" => "alias", "pubkey" => member}]))
    |> Map.update!("relay_realms", &(&1 ++ ["alias"]))
  end

  test "an admitted realm aliasing a member's key refuses, even when relayed for", f do
    refuses(f, mutate(f, child(&alias_peer/1)), :invalid_candidate_manifest)
  end

  test "a Space realm aliasing a member's key refuses, even when relayed for", f do
    refuses(f, mutate(f, space(&alias_peer/1)), :invalid_candidate_manifest)
  end

  # Row 248(a): the service key is refused as the root of any served Thread,
  # not only the admitted child's. The served Thread trusts the Space's peers,
  # so only the authority-root inventory can catch the reuse.
  test "a served Thread rooted at the service key refuses", f do
    {request, served} = with_served_thread(f)
    artifacts = mutate(f, &Map.update!(&1, "instances", fn [a, b] -> [a, served, b] end))

    assert {:error, :service_binding_mismatch} =
             Staging.prepare(f.root, nil, request, artifacts, f.ceremony_dir)

    assert {:ok, nil} = Journal.read(f.root)
  end

  describe "a Space replica already in a committed catalog" do
    test "keeps its catalogued route and stages", f do
      {request, expected, status_path} = committed(f, f.space_route)

      assert {:ok, record} =
               Staging.prepare(
                 f.root,
                 expected,
                 request,
                 f.artifacts,
                 f.ceremony_dir,
                 status_path
               )

      assert record["catalog_head"] == request.catalog_head
    end

    test "may not change its route", f do
      {request, expected, status_path} = committed(f, f.space_route)
      moved = "/r/" <> Base.url_encode64(:crypto.hash(:sha256, "moved"), padding: false)

      assert {:error, :catalog_route_changed} =
               Staging.prepare(
                 f.root,
                 expected,
                 request,
                 mutate(f, space(&Map.put(&1, "route", moved))),
                 f.ceremony_dir,
                 status_path
               )

      assert {:ok, ^expected} = Journal.read(f.root)
    end

    test "already catalogued under another route refuses the active route", f do
      moved = "/r/" <> Base.url_encode64(:crypto.hash(:sha256, "moved"), padding: false)
      {request, expected, status_path} = committed(f, moved)

      assert {:error, :catalog_route_changed} =
               Staging.prepare(
                 f.root,
                 expected,
                 request,
                 f.artifacts,
                 f.ceremony_dir,
                 status_path
               )

      assert {:ok, ^expected} = Journal.read(f.root)
    end
  end

  test "a reference naming a Space no instance serves refuses", f do
    artifacts =
      Enum.map(f.artifacts, fn
        %{kind: :reference} = reference -> %{reference | replica: "replica:treehouse:elsewhere"}
        artifact -> artifact
      end)

    refuses(f, artifacts, :service_binding_mismatch)
  end

  test "another ceremony's refusal passes through unchanged", f do
    {:ok, other} = Fixture.new()
    other = Map.new(other)
    assert {:error, reason} = CatalogBinding.load(other.ceremony_dir, f.active_log)

    assert {:error, ^reason} =
             Staging.prepare(f.root, nil, f.request, f.artifacts, other.ceremony_dir)

    assert {:ok, nil} = Journal.read(f.root)
  end

  test "a missing ceremony directory refuses", f do
    missing = Path.join(f.root, "no-ceremony")
    assert {:error, reason} = CatalogBinding.load(missing, f.active_log)
    assert {:error, ^reason} = Staging.prepare(f.root, nil, f.request, f.artifacts, missing)
    assert {:ok, nil} = Journal.read(f.root)
  end

  test "a request naming a catalog head the store does not hold is stale", f do
    request = %{f.request | catalog_head: f.reference.id}

    assert {:error, :stale_catalog_head} =
             Staging.prepare(f.root, nil, request, f.artifacts, f.ceremony_dir)

    assert {:ok, nil} = Journal.read(f.root)
  end

  test "an active instance may not change anything but the bound values", f do
    port = fn m -> put_in(m, ["listener", "port"], 41_001) end
    refuses(f, mutate(f, space(port)), :invalid_candidate_manifest)
  end

  test "an active instance may not move its log file", f do
    moved = Path.join(f.root, "moved.log")
    File.cp!(f.active_log, moved)
    refuses(f, mutate(f, space(&Map.put(&1, "log_file", moved))), :invalid_candidate_manifest)
  end

  test "a non-Treehouse instance whose log has no authority root coexists verbatim", f do
    {request, other} = with_rootless(f)
    artifacts = mutate(f, &Map.update!(&1, "instances", fn [a, b] -> [a, other, b] end))

    assert {:ok, record} = Staging.prepare(f.root, nil, request, artifacts, f.ceremony_dir)
    assert record["service"]["pub"] == Base.encode64(f.service_pub)
    assert File.read!(f.active_log) == f.active_bytes
  end

  test "a rootless non-Treehouse instance must still be kept verbatim", f do
    {request, other} = with_rootless(f)
    moved = put_in(other, ["listener", "port"], 41_002)
    artifacts = mutate(f, &Map.update!(&1, "instances", fn [a, b] -> [a, moved, b] end))

    assert {:error, :invalid_candidate_manifest} =
             Staging.prepare(f.root, nil, request, artifacts, f.ceremony_dir)

    assert {:ok, nil} = Journal.read(f.root)
  end

  describe "migration of an unbound active Space instance" do
    for {label, opts} <- [
          {"the root as the only member", []},
          {"a second member", [second_member: true]},
          {"a root that is not a member", [second_member: true, root_member: false]}
        ] do
      test "stages to the bound values with #{label}" do
        {:ok, data} = Fixture.new(unquote(opts))
        f = Map.new(data)
        request = unbind_active(f)

        assert {:ok, record} =
                 Staging.prepare(f.root, nil, request, f.artifacts, f.ceremony_dir)

        assert record["service"]["realm"] == f.binding_realm
        assert File.read!(f.active_log) == f.active_bytes
      end
    end

    test "still refuses a migrated instance that stays unbound", f do
      request = unbind_active(f)
      other = identity_file(f, "other.identity", "other-service")

      assert {:error, :service_binding_mismatch} =
               Staging.prepare(
                 f.root,
                 nil,
                 request,
                 mutate(f, both(&Map.put(&1, "identity_file", other))),
                 f.ceremony_dir
               )

      assert {:ok, nil} = Journal.read(f.root)
    end

    test "still refuses a migration that also changes the port", f do
      request = unbind_active(f)

      assert {:error, :invalid_candidate_manifest} =
               Staging.prepare(
                 f.root,
                 nil,
                 request,
                 mutate(f, space(fn m -> put_in(m, ["listener", "port"], 41_001) end)),
                 f.ceremony_dir
               )

      assert {:ok, nil} = Journal.read(f.root)
    end
  end

  # Commits one catalog envelope cataloguing the Space replica under `route`:
  # the envelope in the store and a `listed` journal of an earlier attempt
  # whose receipt names it. Returns the request at that head and the journal.
  defp committed(f, route) do
    id = &Base.url_encode64(:crypto.hash(:sha256, &1), padding: false)

    {:ok, binding} = CatalogBinding.load_log(f.ceremony_dir, Sim.log(f.space, "creator"))

    catalog = %{
      version: 1,
      product: :treehouse,
      space: f.space.replica,
      bootstrap: binding.bootstrap_id,
      binding: binding.bootstrap_id,
      revision: 0,
      previous: nil,
      entries: [
        %{
          product: :treehouse,
          replica: f.space.replica,
          kind: :space,
          schema: :treehouse_space_v1,
          root: :crypto.hash(:sha256, "root"),
          genesis: id.("genesis"),
          creation: id.("creation"),
          reference: binding.bootstrap_id,
          route: route,
          service_id: binding.record.service_id,
          service_key: f.service_pub
        }
      ]
    }

    # Structural route-pin fixture, not publication/history-authentication proof.
    # Model a bounded first inventory and a status signed by the bound key.
    prior = %{
      hd(catalog.entries)
      | replica: "replica:treehouse:thread:prior-route-pin",
        kind: :thread,
        schema: :treehouse_thread_v1,
        route: "/r/" <> id.("prior-thread-route"),
        root: :crypto.hash(:sha256, "prior-thread-root"),
        reference: id.("prior-thread-reference")
    }

    catalog = %{catalog | entries: Enum.sort_by(catalog.entries ++ [prior], & &1.replica)}
    alias LatticeCarrierServer.Operator.CatalogCeremony.{Signer, SigningLedger}
    signer_path = LatticeCarrierServer.Operator.CeremonyFixture.signer_template().signer
    {:ok, secret, key} = Signer.read_seed(signer_path)
    assert key == binding.record.catalog_key

    signature =
      :crypto.sign(:eddsa, :none, TransportCatalog.catalog_bytes(catalog), [
        LatticeCarrierServer.Secret.unwrap(secret),
        :ed25519
      ])

    bytes =
      LatticeCarrierServer.Operator.PublicHistory.canonical(
        Wire.encode_value(%{catalog: catalog, signature: signature})
      )

    sha = Journal.digest(bytes)
    head = TransportCatalog.catalog_id(catalog)
    File.mkdir_p!(CatalogStore.path(f.root))
    File.chmod!(CatalogStore.path(f.root), 0o700)
    File.write!(CatalogStore.file_path(f.root, sha), bytes)
    File.chmod!(CatalogStore.file_path(f.root, sha), 0o600)

    raw =
      Journal.encode(%{
        "version" => 1,
        "phase" => "listed",
        "attempt" => id.("earlier-attempt"),
        "generation" => 0,
        "catalog_head" => head,
        "manifest_digest" => f.request.manifest_digest,
        "artifacts" => [
          %{
            "path" => Path.join(f.root, "earlier-manifest"),
            "sha256" => f.request.manifest_digest,
            "kind" => "manifest",
            "replica" => nil,
            "op_id" => nil,
            "review" => nil
          },
          %{
            "path" => CatalogStore.file_path(f.root, sha),
            "sha256" => sha,
            "kind" => "catalog",
            "replica" => f.space.replica,
            "op_id" => head,
            "review" => nil
          }
        ],
        "service" => %{
          "identity_file" => f.service_identity,
          "realm" => f.binding_realm,
          "pub" => Base.encode64(f.service_pub),
          "sha256" => Journal.digest(File.read!(f.service_identity))
        }
      })

    File.write!(Journal.path(f.root), raw)
    File.chmod!(Journal.path(f.root), 0o600)
    assert {:ok, ^head} = CatalogStore.committed_head(f.root)
    status = %{head_bytes: SigningLedger.head(binding, 0, head), chain: [%{bytes: bytes}]}
    status_path = Path.join(f.root, "committed-custodian-status.json")
    File.write!(status_path, SigningLedger.export_status(status, binding))
    {%{f.request | catalog_head: head}, raw, status_path}
  end

  # Adds to the active manifest a bound Treehouse Thread instance whose log is
  # rooted at the carrier service key. Returns the request over that manifest
  # and the instance JSON for the candidate.
  defp with_served_thread(f) do
    replica =
      "replica:treehouse:thread:" <>
        Treehouse.ContinuationFixtures.digest("served") <> "#authority:bounded-continuation-v1"

    {thread, _genesis} =
      Treehouse.Thread
      |> Sim.new(replica, ["creator"], seed: "served-thread")
      |> then(fn sim ->
        identity = Identity.from_seed("creator", "child-service")
        %{sim | realms: Map.put(sim.realms, "creator", identity)}
      end)
      |> Sim.create_replica("creator", policies: %{})

    log = Path.join(f.root, "served-thread.log")
    :ok = Log.dump(Sim.log(thread, "creator"), log)
    assert {:ok, %{log: served}} = Log.restore_verified(log)
    assert Authority.root(served) == f.service_pub

    manifest = Jason.decode!(File.read!(f.request.active_manifest))
    [space] = manifest["instances"]
    route = "/r/" <> Base.url_encode64(:crypto.hash(:sha256, "served-route"), padding: false)
    instance = %{space | "name" => "served", "log_file" => log, "route" => route}
    path = Path.join(f.root, "with-served.json")
    File.write!(path, Jason.encode!(%{manifest | "instances" => [space, instance]}))
    File.chmod!(path, 0o600)

    request = %{
      f.request
      | active_manifest: path,
        manifest_digest: Journal.digest(File.read!(path))
    }

    {request, instance}
  end

  # Adds a non-Treehouse instance to the active manifest whose log is empty, so
  # it has no authority root. Returns the request over that manifest and the
  # instance JSON for the candidate.
  defp with_rootless(f) do
    log = Path.join(f.root, "other.log")
    :ok = "replica:other:rootless" |> Log.new() |> Log.dump(log)
    assert {:ok, %{log: rootless}} = Log.restore_verified(log)
    assert Authority.root(rootless) == nil
    peer = Base.encode64(:crypto.hash(:sha256, "other-peer"))

    other = %{
      "name" => "other",
      "realm" => "other-realm",
      "identity_file" => identity_file(f, "other.identity", "other-service"),
      "log_file" => log,
      "listener" => %{"ip" => "127.0.0.1", "port" => 0},
      "trusted_peers" => [%{"realm" => "other-peer", "pubkey" => peer}],
      "relay_realms" => []
    }

    manifest = Jason.decode!(File.read!(f.request.active_manifest))
    path = Path.join(f.root, "with-other.json")
    File.write!(path, Jason.encode!(Map.update!(manifest, "instances", &(&1 ++ [other]))))
    File.chmod!(path, 0o600)

    request = %{
      f.request
      | active_manifest: path,
        manifest_digest: Journal.digest(File.read!(path))
    }

    {request, other}
  end

  # Rewrites the active manifest so its Space instance is the pre-binding
  # shape: a free realm, its own identity file, no route, no relay and one peer.
  defp unbind_active(f) do
    old = identity_file(f, "old.identity", "old-service")
    manifest = Jason.decode!(File.read!(f.request.active_manifest))

    manifest =
      Map.update!(manifest, "instances", fn [space] ->
        [
          space
          |> Map.put("realm", "old-realm")
          |> Map.put("identity_file", old)
          |> Map.delete("route")
          |> Map.put("relay_realms", [])
          |> Map.update!("trusted_peers", &Enum.take(&1, 1))
        ]
      end)

    path = Path.join(f.root, "old-active.json")
    File.write!(path, Jason.encode!(manifest))
    File.chmod!(path, 0o600)
    %{f.request | active_manifest: path, manifest_digest: Journal.digest(File.read!(path))}
  end
end
