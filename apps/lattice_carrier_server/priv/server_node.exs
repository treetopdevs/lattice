# Test/deployment entrypoint for one configured read-only carrier server.

[port_text, realm, identity_seed, trusted_realm, trusted_pubkey_b64, source_path] =
  System.argv()

identity = Lattice.Identity.from_seed(realm, identity_seed)
trusted_pubkey = Base.decode64!(trusted_pubkey_b64)
port = String.to_integer(port_text)

Application.put_env(:lattice_carrier_server, :server_options,
  instance: :default,
  identity: identity,
  trusted_peers: %{trusted_realm => trusted_pubkey},
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
