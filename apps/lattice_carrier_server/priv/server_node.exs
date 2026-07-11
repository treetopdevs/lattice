# Test/deployment entrypoint for one configured carrier server.

{port_text, realm, identity_seed, trusted_peers, relay_realms, source_path} =
  case System.argv() do
    [port, server_realm, seed, trusted_realm, trusted_pubkey, path] ->
      {port, server_realm, seed, %{trusted_realm => Base.decode64!(trusted_pubkey)}, [], path}

    [
      port,
      server_realm,
      seed,
      trusted_realm,
      trusted_pubkey,
      path,
      relay_realm,
      relay_pubkey
    ] ->
      peers = %{
        trusted_realm => Base.decode64!(trusted_pubkey),
        relay_realm => Base.decode64!(relay_pubkey)
      }

      {port, server_realm, seed, peers, [relay_realm], path}
  end

identity = Lattice.Identity.from_seed(realm, identity_seed)
port = String.to_integer(port_text)

Application.put_env(:lattice_carrier_server, :server_options,
  instance: :default,
  identity: identity,
  trusted_peers: trusted_peers,
  relay_realms: relay_realms,
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
