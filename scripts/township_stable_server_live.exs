source_dir = Path.expand("artifacts/township", File.cwd!())
source_path = Path.join(source_dir, "matter.log")

:ok = Township.AuditBundle.verify(source_dir)
{:ok, source_log} = Lattice.Log.restore(source_path)
{:ok, _apps} = Application.ensure_all_started(:lattice_carrier_server)

observer = Lattice.Identity.from_seed("instrument", "township-stable-browser")
server_identity = Lattice.Identity.from_seed("town-node", "stable-carrier-browser")

{:ok, port_probe} = :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true])
{:ok, {_ip, carrier_port}} = :inet.sockname(port_probe)
:ok = :gen_tcp.close(port_probe)

server_opts = [
  instance: :browser,
  identity: server_identity,
  trusted_peers: %{observer.realm_id => observer.pub},
  source: {:path, source_path},
  listener: [ip: {127, 0, 0, 1}, port: carrier_port]
]

{:ok, server} = LatticeCarrierServer.start_link(server_opts)

connect_opts = [
  hostname: "127.0.0.1",
  port: carrier_port,
  identity: observer,
  realm: observer.realm_id,
  peer_realm: server_identity.realm_id,
  peer_pubkey: server_identity.pub,
  replica: source_log.replica
]

Application.put_env(:township_web, :instrument_projection_options,
  connect_opts: connect_opts,
  replica: source_log.replica,
  peer_realm: server_identity.realm_id,
  schedule: :manual
)

Application.put_env(
  :township_web,
  :instrument_projection_server,
  TownshipWeb.CarrierProjection
)

{:ok, _apps} = Application.ensure_all_started(:township_web)
{:ok, {:fresh, _payload}} = TownshipWeb.CarrierProjection.refresh()

trigger_file = System.fetch_env!("TOWNSHIP_STABLE_TRIGGER_FILE")

spawn_link(fn ->
  handle_trigger = fn await, current_server ->
    if File.exists?(trigger_file) do
      command = trigger_file |> File.read!() |> String.trim()
      :ok = File.rm(trigger_file)

      case {command, current_server} do
        {"stop", server_pid} when is_pid(server_pid) ->
          :ok = Supervisor.stop(server_pid)
          {:ok, {:stale, _payload}} = TownshipWeb.CarrierProjection.refresh()
          await.(await, nil)

        {"restart", nil} ->
          {:ok, restarted_server} = LatticeCarrierServer.start_link(server_opts)
          {:ok, {:fresh, _payload}} = TownshipWeb.CarrierProjection.refresh()
          await.(await, restarted_server)

        _other ->
          await.(await, current_server)
      end
    else
      Process.sleep(25)
      await.(await, current_server)
    end
  end

  handle_trigger.(handle_trigger, server)
end)

IO.puts("TOWNSHIP_STABLE_READY http://localhost:#{System.get_env("PORT", "4115")}/township")
Process.sleep(:infinity)
