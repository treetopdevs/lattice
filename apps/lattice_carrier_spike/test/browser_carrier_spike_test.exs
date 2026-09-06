defmodule LatticeCarrierSpike.BrowserCarrierSpikeTest do
  use ExUnit.Case, async: false

  alias LatticeCarrierSpike.{BrowserGateway, EchoTarget, Filter, Message}

  setup do
    Lattice.reset!()
    :ok
  end

  test "logical carrier frame is valid JSON and routes through Lattice.Gateway" do
    {:ok, target} = EchoTarget.start_link(owner: self())
    {:ok, tab} = Lattice.connect_tab(%{transport: :carrier_spike, connection_pid: self()})
    {:ok, cap} = Lattice.grant(tab.id, target, [:call])
    {:ok, gateway} = BrowserGateway.start_link(reply_nodes: fn -> [] end)

    frame =
      LatticeCarrierSpike.logical_call_frame(%{
        request_id: "req-1",
        tab_id: tab.id,
        cap_id: cap.id,
        payload: %{"op" => "echo", "value" => 42}
      })

    assert {:ok, %{request_id: "req-1", tab_id: tab_id, cap_id: cap_id}} =
             Message.decode(frame)

    assert tab_id == tab.id
    assert cap_id == cap.id

    assert :ok =
             Filter.filter(
               {:reg_send, self(), :unused, LatticeCarrierSpike.gateway_name()},
               frame
             )

    BrowserGateway.logical_call(gateway, frame)

    assert_receive {:carrier_target_call, %{from_tab_id: ^tab_id, payload: %{"value" => 42}}}
    flush_gateway(gateway)

    assert %{call_count: 1} = EchoTarget.stats(target)
    assert_audit(:cap_use, tab_id: tab.id, cap_id: cap.id)
    assert_audit(:browser_beam_carrier_call, request_id: "req-1", tab_id: tab.id, cap_id: cap.id)

    graph = Lattice.Graph.snapshot()
    assert graph.audit_event_count >= 3
    assert Enum.any?(graph.nodes, &(&1.id == "tab:#{tab.id}"))
    assert Enum.any?(graph.nodes, &(&1.id == "cap:#{cap.id}"))
    assert Enum.any?(graph.edges, &(&1.from == "tab:#{tab.id}" and &1.kind == "holds_cap"))
    assert Enum.any?(graph.edges, &(&1.from == "cap:#{cap.id}" and &1.kind == "authorizes"))
    assert Enum.any?(graph.edges, &(&1.kind == "invokes" and &1.cap_id == cap.id))
  end

  test "hostile raw distribution shapes fail closed before target delivery" do
    {:ok, target} = EchoTarget.start_link(owner: self())
    {:ok, tab} = Lattice.connect_tab(%{transport: :carrier_spike, connection_pid: self()})
    {:ok, cap} = Lattice.grant(tab.id, target, [:call])

    allowed =
      LatticeCarrierSpike.logical_call_frame(%{
        request_id: "allowed",
        tab_id: tab.id,
        cap_id: cap.id,
        payload: %{"op" => "echo"}
      })

    assert :ok =
             Filter.filter(
               {:reg_send, self(), :unused, LatticeCarrierSpike.gateway_name()},
               allowed
             )

    for {_name, control, payload} <- LatticeCarrierSpike.hostile_frames() do
      assert {:error, _reason} = Filter.filter(control, payload)
    end

    assert {:error, :not_logical_json} =
             Filter.filter(
               {:reg_send, self(), :unused, LatticeCarrierSpike.gateway_name()},
               {:rpc, Lattice, :diagnostics, []}
             )

    assert %{call_count: 0} = EchoTarget.stats(target)
  end

  test "gateway denies forged or malformed logical calls without ambient delivery" do
    {:ok, target} = EchoTarget.start_link(owner: self())
    {:ok, tab} = Lattice.connect_tab(%{transport: :carrier_spike, connection_pid: self()})
    {:ok, _cap} = Lattice.grant(tab.id, target, [:call])
    {:ok, gateway} = BrowserGateway.start_link(reply_nodes: fn -> [] end)

    forged =
      LatticeCarrierSpike.logical_call_frame(%{
        request_id: "forged",
        tab_id: tab.id,
        cap_id: "not-a-real-cap",
        payload: %{"op" => "echo"}
      })

    BrowserGateway.logical_call(gateway, forged)
    flush_gateway(gateway)

    assert %{call_count: 0} = EchoTarget.stats(target)
    assert_audit(:deny, reason: :unknown_cap)
    assert_audit(:browser_beam_carrier_denied, request_id: "forged", reason: :unknown_cap)
  end

  test "replay of a used single-use cap over the carrier is denied" do
    {:ok, target} = EchoTarget.start_link(owner: self())
    {:ok, tab} = Lattice.connect_tab(%{transport: :carrier_spike, connection_pid: self()})
    {:ok, cap} = Lattice.grant(tab.id, target, [:call], use_limit: 1)
    {:ok, gateway} = BrowserGateway.start_link(reply_nodes: fn -> [] end)

    frame =
      LatticeCarrierSpike.logical_call_frame(%{
        request_id: "replay",
        tab_id: tab.id,
        cap_id: cap.id,
        payload: %{"op" => "echo", "value" => 7}
      })

    # First use succeeds and consumes the single-use cap.
    BrowserGateway.logical_call(gateway, frame)
    assert_receive {:carrier_target_call, %{payload: %{"value" => 7}}}
    flush_gateway(gateway)
    assert %{call_count: 1} = EchoTarget.stats(target)
    assert_audit(:browser_beam_carrier_call, request_id: "replay", cap_id: cap.id)

    # Replaying the identical frame is denied without a second target delivery.
    BrowserGateway.logical_call(gateway, frame)
    flush_gateway(gateway)
    refute_received {:carrier_target_call, _envelope}

    assert %{call_count: 1} = EchoTarget.stats(target)
    assert_audit(:use_limit_exceeded, cap_id: cap.id, reason: :use_limit_exceeded)
    assert_audit(:browser_beam_carrier_denied, request_id: "replay", reason: :use_limit_exceeded)
  end

  # The gateway processes its mailbox in order, so a synchronous state call
  # guarantees any frames sent before it have finished handle_info/3.
  defp flush_gateway(gateway), do: GenServer.call(gateway, :state)

  defp assert_audit(type, filters) do
    assert Enum.any?(Lattice.audit_events(), fn event ->
             event.type == type and
               Enum.all?(filters, fn {key, value} -> event.metadata[key] == value end)
           end)
  end
end
