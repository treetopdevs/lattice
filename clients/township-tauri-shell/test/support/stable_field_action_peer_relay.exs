alias Lattice.Carrier.{WebSocket, Wire}
alias Lattice.Identity

[
  port_text,
  server_realm,
  server_pubkey_b64,
  peer_realm,
  peer_seed,
  replica,
  oracle_path
] = System.argv()

oracle = oracle_path |> File.read!() |> Jason.decode!()
Code.ensure_loaded!(Township.Matter)
{:ok, [op]} = Wire.decode_ops([Map.fetch!(oracle, "expectedPeerSummary")])
peer_identity = Identity.from_seed(peer_realm, peer_seed)
server_pubkey = Base.decode64!(server_pubkey_b64)
port = String.to_integer(port_text)

if Base.encode64(peer_identity.pub) != oracle["peerPubkey"] do
  raise "field-action peer identity does not match the fixture oracle"
end

connect_opts = [
  hostname: "127.0.0.1",
  port: port,
  identity: peer_identity,
  realm: peer_identity.realm_id,
  peer_realm: server_realm,
  peer_pubkey: server_pubkey,
  replica: replica
]

{:ok, connection} = WebSocket.connect(connect_opts)
{:ok, %{accepted: [accepted_id]}, connection} = WebSocket.relay(connection, op)

if accepted_id != op.id do
  raise "stable relay accepted the wrong field-action peer operation"
end

:ok = WebSocket.close(connection)
IO.puts("FIELD_PEER_RELAY_READY")
