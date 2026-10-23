defmodule LatticeCarrierServer.Operator.ServiceBindingStagingTest do
  @moduledoc """
  Plan 224 PR 2: staging refuses every Treehouse instance that is not bound to
  the ceremony's service realm and key, and accepts the one reviewed migration.
  """
  use ExUnit.Case, async: false
  if :os.type() != {:unix, :linux}, do: @moduletag(skip: "Requires actual Linux OS lock")
  alias LatticeCarrierServer.Operator.{CatalogBinding, Journal, Staging}

  setup do
    {:ok, data} = LatticeCarrierServer.Operator.Fixture.new()
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

  test "a reference naming a Space no instance serves refuses", f do
    artifacts =
      Enum.map(f.artifacts, fn
        %{kind: :reference} = reference -> %{reference | replica: "replica:treehouse:elsewhere"}
        artifact -> artifact
      end)

    refuses(f, artifacts, :service_binding_mismatch)
  end

  test "another ceremony's refusal passes through unchanged", f do
    {:ok, other} = LatticeCarrierServer.Operator.Fixture.new()
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

  describe "migration of an unbound active Space instance" do
    for {label, opts} <- [
          {"the root as the only member", []},
          {"a second member", [second_member: true]},
          {"a root that is not a member", [second_member: true, root_member: false]}
        ] do
      test "stages to the bound values with #{label}" do
        {:ok, data} = LatticeCarrierServer.Operator.Fixture.new(unquote(opts))
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
