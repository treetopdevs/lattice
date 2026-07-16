defmodule LatticeCarrierServer.ApplicationTest do
  use ExUnit.Case, async: false

  alias Lattice.Carrier.WebSocket
  alias Lattice.{Identity, Log}

  @replica "replica:carrier-server:application"

  test "configured server options are supervised by the application" do
    previous = Application.get_env(:lattice_carrier_server, :server_options, :missing)
    server_identity = Identity.from_seed("town-node", "carrier-server-application")
    client_identity = Identity.from_seed("instrument", "carrier-client-application")
    instance = :configured_application_test

    on_exit(fn ->
      :ok = Application.stop(:lattice_carrier_server)
      restore_server_config(previous)
      {:ok, _apps} = Application.ensure_all_started(:lattice_carrier_server)
    end)

    :ok = Application.stop(:lattice_carrier_server)

    Application.put_env(:lattice_carrier_server, :server_options,
      instance: instance,
      identity: server_identity,
      trusted_peers: %{client_identity.realm_id => client_identity.pub},
      source: {:log, Log.new(@replica)},
      listener: [ip: {127, 0, 0, 1}, port: 0]
    )

    assert {:ok, _apps} = Application.ensure_all_started(:lattice_carrier_server)
    assert port = LatticeCarrierServer.port(instance)

    assert {:ok, connection} =
             WebSocket.connect(
               hostname: "127.0.0.1",
               port: port,
               identity: client_identity,
               realm: client_identity.realm_id,
               peer_realm: server_identity.realm_id,
               peer_pubkey: server_identity.pub,
               replica: @replica
             )

    assert {:ok, ids, connection} = WebSocket.advertise(connection, Log.new(@replica))
    assert ids == MapSet.new()
    assert :ok = WebSocket.close(connection)

    runtime_apps = Application.spec(:lattice_carrier_server, :applications)
    assert :lattice_core in runtime_apps
    assert :cowboy in runtime_apps
    assert :jason in runtime_apps
    refute :lattice_web_socket in runtime_apps
    refute :lattice_node_spike in runtime_apps
    refute :lattice_server in runtime_apps
    refute :township_web in runtime_apps
  end

  defp restore_server_config(:missing) do
    Application.delete_env(:lattice_carrier_server, :server_options)
  end

  defp restore_server_config(value) do
    Application.put_env(:lattice_carrier_server, :server_options, value)
  end
end
