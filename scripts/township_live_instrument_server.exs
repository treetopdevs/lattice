{:ok, _apps} = Application.ensure_all_started(:lattice_node_spike)

observer = Lattice.Identity.from_seed("instrument", "township-live-browser")
peer_identity = LatticeNodeSpike.TownshipScenario.session_identity("clerk")

{:ok, peer} =
  LatticeNodeSpike.Peer.start_link(
    realm: "clerk",
    identity: peer_identity,
    scenario: LatticeNodeSpike.TownshipScenario
  )

{:ok, carrier_port} =
  LatticeNodeSpike.PeerServer.start(peer,
    trusted_peer_realm: "instrument",
    trusted_peer_pubkey: observer.pub
  )

connect_opts = [
  port: carrier_port,
  identity: observer,
  realm: "instrument",
  peer_realm: "clerk",
  peer_pubkey: peer_identity.pub,
  replica: LatticeNodeSpike.TownshipScenario.replica()
]

Application.put_env(:township_web, :instrument_projection_options,
  connect_opts: connect_opts,
  replica: LatticeNodeSpike.TownshipScenario.replica(),
  peer_realm: "clerk",
  schedule: :manual
)

Application.put_env(
  :township_web,
  :instrument_projection_server,
  TownshipWeb.CarrierProjection
)

{:ok, _apps} = Application.ensure_all_started(:township_web)
{:ok, {:fresh, _payload}} = TownshipWeb.CarrierProjection.refresh()

trigger_file = System.fetch_env!("TOWNSHIP_LIVE_TRIGGER_FILE")

spawn(fn ->
  until_triggered = fn await, attempts ->
    cond do
      File.exists?(trigger_file) ->
        File.rm(trigger_file)
        {:ok, conn} = Lattice.Carrier.WebSocket.connect(connect_opts)
        :ok = Lattice.Carrier.WebSocket.close(conn)

        await_diverged = fn await, remaining ->
          cond do
            LatticeNodeSpike.Peer.status(peer) == :diverged ->
              :ok

            remaining > 0 ->
              Process.sleep(10)
              await.(await, remaining - 1)

            true ->
              raise "Township browser peer never diverged"
          end
        end

        :ok = await_diverged.(await_diverged, 100)
        {:ok, {:fresh, _payload}} = TownshipWeb.CarrierProjection.refresh()

      attempts > 0 ->
        Process.sleep(25)
        await.(await, attempts - 1)

      true ->
        raise "browser never armed Township peer divergence"
    end
  end

  until_triggered.(until_triggered, 2_400)
end)

IO.puts("TOWNSHIP_LIVE_READY http://localhost:#{System.get_env("PORT", "4114")}/township")
Process.sleep(:infinity)
