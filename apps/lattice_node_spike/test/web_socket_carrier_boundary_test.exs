defmodule LatticeNodeSpike.WebSocketCarrierBoundaryTest do
  use ExUnit.Case, async: true

  @repo_root Path.expand("../../..", __DIR__)

  test "the reusable carrier and transport client belong to the lightweight WebSocket app" do
    assert Application.get_application(Lattice.Carrier.WebSocket) == :lattice_web_socket

    assert Application.get_application(Lattice.Transport.WebSocket.Client) ==
             :lattice_web_socket

    assert Application.get_application(Lattice.Transport.WebSocket.Envelope) ==
             :lattice_web_socket
  end

  test "node-spike depends on the WebSocket library without starting lattice_server" do
    applications = Application.spec(:lattice_node_spike, :applications)

    assert :lattice_web_socket in applications
    refute :lattice_server in applications
  end

  test "the spike-owned carrier adapter and wire rename shim are removed" do
    refute File.exists?(
             Path.join(
               @repo_root,
               "apps/lattice_node_spike/lib/lattice_node_spike/ws_carrier.ex"
             )
           )

    refute File.exists?(
             Path.join(@repo_root, "apps/lattice_node_spike/lib/lattice_node_spike/wire.ex")
           )
  end
end
