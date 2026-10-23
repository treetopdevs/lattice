defmodule LatticeCarrierServer.Operator.CheckBoundTest do
  @moduledoc """
  Plan 224 PR 2: the bound-instance rule's inventory over instances whose
  replica or authority root is unknown. Pure, so it runs on every OS.
  """
  use ExUnit.Case, async: true
  alias LatticeCarrierServer.Operator.Staging

  @space "replica:treehouse:space:s"
  @thread "replica:treehouse:thread:t"
  @other "replica:other:rootless"
  @realm "service-realm"

  defp key(label), do: :crypto.hash(:sha256, label)

  defp bound, do: %{realm: @realm, record: %{service_key: key("service")}}

  # A bound Treehouse instance trusting its root and the one-member roster,
  # relaying for exactly those realms.
  defp treehouse(name, root) do
    %{
      name: name,
      realm: @realm,
      pub: key("service"),
      identity_file: "/srv/service.identity",
      log_file: "/srv/" <> name <> ".log",
      route: "/r/" <> name,
      trusted_peers: %{"root" => root, "member" => key("member")},
      relay_realms: ["root", "member"]
    }
  end

  defp rootless do
    %{
      name: "other",
      realm: "other-realm",
      pub: key("other"),
      identity_file: "/srv/other.identity",
      log_file: "/srv/other.log",
      route: nil,
      trusted_peers: %{"peer" => key("peer")},
      relay_realms: []
    }
  end

  defp context(replicas, roots) do
    %{
      space_replica: @space,
      replica_of: &Map.get(replicas, &1.name),
      roots: roots,
      roster: [Base.encode64(key("member"))],
      peer_error: :invalid_candidate_manifest
    }
  end

  defp instances, do: [treehouse("space", key("space-root")), treehouse("thread", key("child"))]

  defp replicas, do: %{"space" => @space, "thread" => @thread, "other" => @other}

  defp roots, do: %{@space => key("space-root"), @thread => key("child")}

  test "the honest bound instances pass" do
    assert :ok = Staging.check_bound(instances(), context(replicas(), roots()), bound())
  end

  test "a non-Treehouse instance with no authority root is not inventoried" do
    roots = Map.put(roots(), @other, nil)

    assert :ok =
             Staging.check_bound(
               instances() ++ [rootless()],
               context(replicas(), roots),
               bound()
             )
  end

  test "a Treehouse instance with no authority root is a binding mismatch" do
    for roots <- [Map.put(roots(), @thread, nil), Map.delete(roots(), @thread)] do
      assert {:error, :service_binding_mismatch} =
               Staging.check_bound(instances(), context(replicas(), roots), bound())
    end
  end

  test "a second realm aliasing a roster or root key is a peer error, even when relayed" do
    for pub <- [key("member"), key("child")] do
      aliased =
        Map.update!(treehouse("thread", key("child")), :trusted_peers, &Map.put(&1, "alias", pub))

      aliased = %{aliased | relay_realms: aliased.relay_realms ++ ["alias"]}

      assert {:error, :invalid_candidate_manifest} =
               Staging.check_bound(
                 [treehouse("space", key("space-root")), aliased],
                 context(replicas(), roots()),
                 bound()
               )
    end
  end

  test "the service key as the root of any served Thread is a binding mismatch" do
    served = %{
      treehouse("served", key("space-root"))
      | trusted_peers: treehouse("space", key("space-root")).trusted_peers
    }

    replicas = Map.put(replicas(), "served", "replica:treehouse:thread:served")
    roots = Map.put(roots(), "replica:treehouse:thread:served", key("service"))

    assert {:error, :service_binding_mismatch} =
             Staging.check_bound(instances() ++ [served], context(replicas, roots), bound())
  end

  describe "catalogued routes" do
    defp catalog(entries),
      do: %{
        entries: Enum.map(entries, fn {replica, route} -> %{replica: replica, route: route} end)
      }

    test "map every committed entry's replica to its route" do
      assert {:ok, %{@space => "/r/space", @thread => "/r/thread"}} =
               Staging.catalog_routes([
                 catalog([{@space, "/r/space"}]),
                 catalog([{@space, "/r/space"}, {@thread, "/r/thread"}])
               ])

      assert {:ok, routes} = Staging.catalog_routes([])
      assert routes == %{}
    end

    test "a replica catalogued under two routes is a corrupt store" do
      assert {:error, :catalog_store_corrupt} =
               Staging.catalog_routes([
                 catalog([{@space, "/r/space"}]),
                 catalog([{@space, "/r/elsewhere"}])
               ])
    end

    test "a catalogued Treehouse instance keeps its route; others are free" do
      replica_of = &Map.get(replicas(), &1.name)
      routes = %{@space => "/r/space"}

      assert :ok = Staging.catalog_routes_kept(instances(), replica_of, routes)
      assert :ok = Staging.catalog_routes_kept(instances(), replica_of, %{})

      assert :ok =
               Staging.catalog_routes_kept(instances() ++ [rootless()], replica_of, %{
                 @other => "/r/other"
               })

      assert {:error, :catalog_route_changed} =
               Staging.catalog_routes_kept(instances(), replica_of, %{@space => "/r/moved"})

      assert {:error, :catalog_route_changed} =
               Staging.catalog_routes_kept(instances(), replica_of, %{@thread => "/r/moved"})
    end
  end

  test "an instance whose replica is unknown is a binding mismatch" do
    for unknown <- ["thread", "other"] do
      replicas = Map.delete(replicas(), unknown)

      assert {:error, :service_binding_mismatch} =
               Staging.check_bound(
                 instances() ++ [rootless()],
                 context(replicas, Map.put(roots(), @other, nil)),
                 bound()
               )
    end
  end
end
