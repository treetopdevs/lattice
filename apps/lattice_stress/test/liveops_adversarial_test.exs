defmodule LatticeStress.LiveOpsAdversarialTest do
  use ExUnit.Case, async: false

  alias Lattice.Transport.WebSocket.Client
  alias LatticeStress.ProbeTab

  setup do
    Lattice.reset!()
    LatticeServer.DemoHub.reset()
    :ok
  end

  test "publish approval caps resist theft, replay, expiry, and wrong-role use" do
    %{tab: producer, actor: producer_actor} = connect_role(:producer)
    %{tab: graphics, actor: graphics_actor} = connect_role(:graphics_operator)
    %{tab: observer, actor: observer_actor} = connect_role(:observer)

    before_count = publish_count()
    approval_id = request_publish(graphics, graphics_actor, "LiveOps lower third")
    publish_cap = approve_publish(producer, producer_actor, approval_id, 30_000)

    assert {:error, :wrong_owner} =
             Lattice.call(observer.id, publish_cap, %{
               action: "publish",
               request_id: approval_id,
               cap_id: publish_cap
             })

    assert publish_count() == before_count

    assert {:ok, %{on_air: "LiveOps lower third"}} =
             Lattice.call(graphics.id, publish_cap, %{
               action: "publish",
               request_id: approval_id,
               cap_id: publish_cap,
               overlay: "LiveOps lower third"
             })

    assert {:error, :revoked} =
             Lattice.call(graphics.id, publish_cap, %{
               action: "publish",
               request_id: approval_id,
               cap_id: publish_cap
             })

    observer_cap = cap_id(observer_actor, :observe)

    assert {:error, :cap_action_mismatch} =
             Lattice.call(observer.id, observer_cap, %{
               action: "publish",
               request_id: approval_id,
               cap_id: observer_cap
             })

    expired_approval_id = request_publish(graphics, graphics_actor, "Expired lower third")
    expired_cap = approve_publish(producer, producer_actor, expired_approval_id, -1)

    assert {:error, :expired} =
             Lattice.call(graphics.id, expired_cap, %{
               action: "publish",
               request_id: expired_approval_id,
               cap_id: expired_cap
             })

    assert_audit(:deny, reason: :wrong_owner)
    assert_audit(:deny, reason: :cap_action_mismatch)
    assert_audit(:expired_cap, reason: :expired)
  end

  test "disconnect during approval or publish cleans up without surviving authority" do
    %{tab: producer, actor: producer_actor} = connect_role(:producer)
    %{tab: graphics, actor: graphics_actor} = connect_role(:graphics_operator)

    approval_id = request_publish(graphics, graphics_actor, "Disconnect before approve")
    assert {:ok, _actor} = Lattice.LiveOps.cleanup_tab(graphics.id, :disconnect_during_approval)
    assert {:ok, _closed} = Lattice.disconnect_tab(graphics.id)

    approve_cap = cap_id(producer_actor, :approve_publish)

    assert {:error, :approval_not_pending} =
             Lattice.call(producer.id, approve_cap, %{
               action: "approve_publish",
               request_id: approval_id,
               ttl_ms: 30_000
             })

    %{tab: graphics2, actor: graphics2_actor} = connect_role(:graphics_operator)
    approval2 = request_publish(graphics2, graphics2_actor, "Disconnect before publish")
    publish_cap = approve_publish(producer, producer_actor, approval2, 30_000)

    assert {:ok, _actor} = Lattice.LiveOps.cleanup_tab(graphics2.id, :disconnect_during_publish)
    assert {:ok, _closed} = Lattice.disconnect_tab(graphics2.id)

    assert {:error, :revoked} =
             Lattice.call(graphics2.id, publish_cap, %{
               action: "publish",
               request_id: approval2,
               cap_id: publish_cap
             })

    snapshot = Lattice.LiveOps.snapshot()
    refute Enum.any?(snapshot.actors, &(&1.tab_id in [graphics.id, graphics2.id]))

    refute snapshot.actors
           |> Enum.flat_map(& &1.devices)
           |> Enum.any?(&(&1.tab_id == graphics2.id))

    assert_audit(:liveops_cleanup, tab_id: graphics.id)
    assert_audit(:liveops_cleanup, tab_id: graphics2.id)
  end

  test "reconnected camera cannot reuse stale device authority" do
    %{tab: camera, actor: camera_actor} = connect_role(:remote_camera)
    stale_cap = cap_id(camera_actor, :camera_frame)

    assert {:ok, %{accepted: true}} =
             Lattice.call(camera.id, stale_cap, %{action: "camera_frame", frame: "before-close"})

    assert {:ok, _actor} = Lattice.LiveOps.cleanup_tab(camera.id, :camera_disconnect)
    assert {:ok, _closed} = Lattice.disconnect_tab(camera.id)

    %{tab: replacement} = connect_role(:remote_camera)

    assert {:error, :wrong_owner} =
             Lattice.call(replacement.id, stale_cap, %{
               action: "camera_frame",
               frame: "stale-after-reconnect"
             })

    assert_audit(:deny, reason: :wrong_owner)
  end

  test "websocket target override and malformed envelopes fail closed" do
    listener = :"lattice_liveops_attack_#{System.unique_integer([:positive])}"
    port = free_port()

    {:ok, _pid} =
      LatticeServer.start_http(
        listener: listener,
        port: port,
        auto_story?: false,
        static_dir: Path.expand("../../../examples/liveops_demo", __DIR__)
      )

    on_exit(fn -> LatticeServer.stop_http(listener) end)

    {:ok, client} = Client.connect(port: port)
    assert :ok = Client.send_raw_text(client, "not-json")
    assert {:ok, %{"type" => "error", "error_type" => "malformed"}} = recv_type(client, "error")

    assert :ok =
             Client.send_envelope(client, %{
               type: "hello",
               identity: %{surface: "liveops-demo", role: "graphics_operator"}
             })

    assert {:ok, %{"type" => "welcome"}} = recv_type(client, "welcome")
    assert :ok = Client.send_envelope(client, %{type: "state_request"})
    assert {:ok, %{"type" => "snapshot", "liveops" => liveops}} = recv_type(client, "snapshot")

    cap_id =
      liveops["actors"]
      |> List.first()
      |> Map.fetch!("caps")
      |> Enum.find(&(&1["action"] == "preview_overlay"))
      |> Map.fetch!("id")

    assert :ok =
             Client.send_envelope(client, %{
               type: "liveops_action",
               action: "preview_overlay",
               target: "forged-target",
               cap_id: cap_id,
               payload: %{overlay: "forged target"}
             })

    assert {:ok,
            %{
              "type" => "liveops_result",
              "ok" => false,
              "error" => "invalid_request"
            }} = recv_type(client, "liveops_result")

    assert_audit(:deny, reason: :target_mismatch)
    Client.close(client)
  end

  defp connect_role(role) do
    {:ok, _pid, tab} =
      ProbeTab.connect(identity: %{surface: "liveops-demo", role: Atom.to_string(role)})

    {:ok, actor} = Lattice.LiveOps.register_tab(tab)
    %{tab: tab, actor: actor}
  end

  defp request_publish(tab, actor, overlay) do
    request_cap = cap_id(actor, :request_publish)

    assert {:ok, %{approval_id: approval_id}} =
             Lattice.call(tab.id, request_cap, %{action: "request_publish", overlay: overlay})

    approval_id
  end

  defp approve_publish(producer, actor, approval_id, ttl_ms) do
    approve_cap = cap_id(actor, :approve_publish)

    assert {:ok, %{publish_cap_id: publish_cap}} =
             Lattice.call(producer.id, approve_cap, %{
               action: "approve_publish",
               request_id: approval_id,
               ttl_ms: ttl_ms
             })

    publish_cap
  end

  defp cap_id(actor, action) do
    action = Atom.to_string(action)

    actor.caps
    |> Enum.find(&(&1.action == action))
    |> Map.fetch!(:id)
  end

  defp publish_count do
    Lattice.LiveOps.snapshot().operations
    |> Enum.count(&(&1.action == "publish"))
  end

  defp recv_type(client, type, timeout \\ 5_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_recv_type(client, type, deadline)
  end

  defp do_recv_type(client, type, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 1)

    case Client.recv_envelope(client, remaining) do
      {:ok, %{"type" => ^type} = envelope} -> {:ok, envelope}
      {:ok, _other} -> do_recv_type(client, type, deadline)
      {:error, reason} -> {:error, reason}
    end
  end

  defp free_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false])
    {:ok, port} = :inet.port(socket)
    :gen_tcp.close(socket)
    port
  end

  defp assert_audit(type, filters) do
    assert Enum.any?(Lattice.audit_events(), fn event ->
             event.type == type and
               Enum.all?(filters, fn {key, value} -> event.metadata[key] == value end)
           end)
  end
end
