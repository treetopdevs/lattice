# Test/deployment entrypoint for one configured carrier server.
#
# This is a dev/test-only fixture, never the production release boot path.
# Explicitly opt into the macOS directory-sync approximation so it can
# rehearse and relay locally; the actual lattice_carrier_pilot release keeps
# the default refusal on a non-Linux host (see
# LatticeCarrierServer.Durability.Posix).
if :os.type() == {:unix, :darwin} do
  Application.put_env(:lattice_carrier_server, :allow_approximate_darwin_sync, true)
end

{port_text, realm, identity_seed, trusted_peers, relay_realms, source_path} =
  case System.argv() do
    [port, server_realm, seed, trusted_realm, trusted_pubkey, path | relay_args]
    when rem(length(relay_args), 2) == 0 ->
      relay_peers =
        relay_args
        |> Enum.chunk_every(2)
        |> Enum.map(fn [relay_realm, relay_pubkey] ->
          {relay_realm, Base.decode64!(relay_pubkey)}
        end)

      peers = Map.new([{trusted_realm, Base.decode64!(trusted_pubkey)} | relay_peers])
      relay_realms = Enum.map(relay_peers, &elem(&1, 0))
      {port, server_realm, seed, peers, relay_realms, path}
  end

identity = Lattice.Identity.from_seed(realm, identity_seed)
port = String.to_integer(port_text)

Application.put_env(:lattice_carrier_server, :server_options,
  instance: :default,
  identity: identity,
  trusted_peers: trusted_peers,
  relay_realms: relay_realms,
  state_reporter: Township.CarrierStateReport,
  source: {:path, Path.expand(source_path)},
  listener: [ip: {127, 0, 0, 1}, port: port]
)

{:ok, _apps} = Application.ensure_all_started(:lattice_carrier_server)

IO.puts("SERVER_PUBKEY #{Base.encode64(identity.pub)}")
IO.puts("SERVER_READY #{LatticeCarrierServer.port(:default)}")

spawn(fn ->
  _ = IO.gets("")
  System.halt(0)
end)

Process.sleep(:infinity)
