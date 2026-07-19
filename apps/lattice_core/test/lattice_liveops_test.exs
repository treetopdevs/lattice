defmodule LatticeCore.LiveOpsTest do
  use ExUnit.Case, async: false

  alias LatticeCore.TestTabClient

  setup do
    Lattice.reset!()
    :ok
  end

  test "roles receive scoped caps and publish requires explicit approval cap" do
    %{tab: producer, actor: producer_actor} = connect_role(:producer)
    %{tab: graphics, actor: graphics_actor} = connect_role(:graphics_operator)

    request_cap = cap_id(graphics_actor, :request_publish)
    approve_cap = cap_id(producer_actor, :approve_publish)

    assert {:error, :cap_action_mismatch} =
             Lattice.call(graphics.id, request_cap, %{
               action: "publish",
               request_id: "missing",
               cap_id: request_cap
             })

    assert {:ok, %{approval_id: approval_id}} =
             Lattice.call(graphics.id, request_cap, %{
               action: "request_publish",
               overlay: "Lower third: Unit Test"
             })

    assert {:ok, %{publish_cap_id: publish_cap}} =
             Lattice.call(producer.id, approve_cap, %{
               action: "approve_publish",
               request_id: approval_id,
               ttl_ms: 30_000
             })

    assert {:ok, %{on_air: "Lower third: Unit Test"}} =
             Lattice.call(graphics.id, publish_cap, %{
               action: "publish",
               request_id: approval_id,
               cap_id: publish_cap,
               overlay: "Lower third: Unit Test"
             })

    assert {:error, :revoked} =
             Lattice.call(graphics.id, publish_cap, %{
               action: "publish",
               request_id: approval_id,
               cap_id: publish_cap
             })

    assert_audit(:liveops_approval_granted,
      approval_id: approval_id,
      operator_tab_id: graphics.id,
      producer_tab_id: producer.id,
      publish_cap_id: publish_cap
    )

    assert_audit(:liveops_cap_revoked, cap_id: publish_cap, reason: :publish_used)
  end

  test "expired approval publish caps deny before operation execution" do
    %{tab: producer, actor: producer_actor} = connect_role(:producer)
    %{tab: graphics, actor: graphics_actor} = connect_role(:graphics_operator)

    request_cap = cap_id(graphics_actor, :request_publish)
    approve_cap = cap_id(producer_actor, :approve_publish)

    assert {:ok, %{approval_id: approval_id}} =
             Lattice.call(graphics.id, request_cap, %{
               action: "request_publish",
               overlay: "Expired lower third"
             })

    assert {:ok, %{publish_cap_id: publish_cap}} =
             Lattice.call(producer.id, approve_cap, %{
               action: "approve_publish",
               request_id: approval_id,
               ttl_ms: -1
             })

    before_count = operation_count(:publish)

    assert {:error, :expired} =
             Lattice.call(graphics.id, publish_cap, %{
               action: "publish",
               request_id: approval_id,
               cap_id: publish_cap
             })

    assert operation_count(:publish) == before_count
    assert_audit(:expired_cap, cap_id: publish_cap, reason: :expired)
  end

  test "role labels are not authority and wrong-role publish is denied" do
    %{tab: observer, actor: observer_actor} = connect_role(:observer)
    observe_cap = cap_id(observer_actor, :observe)

    before_count = operation_count(:publish)

    assert {:error, :cap_action_mismatch} =
             Lattice.call(observer.id, observe_cap, %{
               action: "publish",
               request_id: "approval-should-not-matter",
               cap_id: observe_cap
             })

    assert operation_count(:publish) == before_count
    assert_audit(:deny, tab_id: observer.id, reason: :cap_action_mismatch)
  end

  test "device actors are cap gated and cleaned with tab lifecycle" do
    %{tab: camera, actor: camera_actor} = connect_role(:remote_camera)

    camera_cap = cap_id(camera_actor, :camera_frame)
    tally_cap = cap_id(camera_actor, :set_tally)

    assert {:ok, %{device_kind: :camera_feed, accepted: true}} =
             Lattice.call(camera.id, camera_cap, %{action: "camera_frame", frame: "frame-001"})

    assert {:ok, %{device_kind: :tally_light, accepted: true}} =
             Lattice.call(camera.id, tally_cap, %{action: "set_tally", state: "on-air"})

    assert {:ok, _actor} = Lattice.LiveOps.cleanup_tab(camera.id, :test_disconnect)
    assert {:ok, _closed} = Lattice.disconnect_tab(camera.id)

    refute Enum.any?(Lattice.LiveOps.snapshot().actors, &(&1.tab_id == camera.id))

    assert {:error, :revoked} =
             Lattice.call(camera.id, camera_cap, %{action: "camera_frame", frame: "stale"})

    assert_audit(:liveops_cleanup, tab_id: camera.id, reason: :test_disconnect)
  end

  test "snapshot fails closed while CapStore is unavailable" do
    %{actor: observer_actor} = connect_role(:observer)
    observe_cap = cap_id(observer_actor, :observe)
    supervisor = Process.whereis(LatticeCore.Supervisor)

    assert :ok = Supervisor.terminate_child(supervisor, Lattice.CapStore)

    try do
      snapshot = Lattice.LiveOps.snapshot()

      assert %{id: ^observe_cap, status: "revoked"} =
               Enum.find(snapshot.caps, &(&1.id == observe_cap))

      assert Process.alive?(supervisor)
    after
      assert {:ok, _pid} = Supervisor.restart_child(supervisor, Lattice.CapStore)
    end

    assert %{caps: %{}, active_caps: %{}} = Lattice.CapStore.snapshot()

    assert %{id: ^observe_cap, status: "revoked"} =
             Lattice.LiveOps.snapshot().caps
             |> Enum.find(&(&1.id == observe_cap))
  end

  defp connect_role(role) do
    {:ok, _pid, tab} =
      TestTabClient.connect(identity: %{surface: "liveops-demo", role: Atom.to_string(role)})

    {:ok, actor} = Lattice.LiveOps.register_tab(tab)
    %{tab: tab, actor: actor}
  end

  defp cap_id(actor, action) do
    action = Atom.to_string(action)

    actor.caps
    |> Enum.find(&(&1.action == action))
    |> Map.fetch!(:id)
  end

  defp operation_count(action) do
    action = Atom.to_string(action)

    Lattice.LiveOps.snapshot().operations
    |> Enum.count(&(&1.action == action))
  end

  defp assert_audit(type, filters) do
    assert Enum.any?(Lattice.audit_events(), fn event ->
             event.type == type and
               Enum.all?(filters, fn {key, value} -> event.metadata[key] == value end)
           end)
  end
end
