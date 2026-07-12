alias Lattice.Carrier.{WebSocket, Wire}
alias Lattice.Identity

[
  port_text,
  server_realm,
  server_pubkey_b64,
  relay_realm,
  relay_seed,
  replica,
  oracle_path,
  mode
] = System.argv()

oracle = oracle_path |> File.read!() |> Jason.decode!()

frame_key =
  case mode do
    "restart" -> "expectedRestartPost"
    other -> raise "unsupported stable relay mode: #{other}"
  end

{:ok, [op]} = Wire.decode_ops([Map.fetch!(oracle, frame_key)])
relay_identity = Identity.from_seed(relay_realm, relay_seed)
server_pubkey = Base.decode64!(server_pubkey_b64)
port = String.to_integer(port_text)

if Base.encode64(relay_identity.pub) != oracle["relayPubkey"] do
  raise "relay identity does not match the fixture oracle"
end

connect_opts = [
  hostname: "127.0.0.1",
  port: port,
  identity: relay_identity,
  realm: relay_identity.realm_id,
  peer_realm: server_realm,
  peer_pubkey: server_pubkey,
  replica: replica
]

{:ok, connection} = WebSocket.connect(connect_opts)
{:ok, %{accepted: [accepted_id]}, connection} = WebSocket.relay(connection, op)

if accepted_id != op.id do
  raise "stable relay accepted the wrong operation"
end

:ok = WebSocket.close(connection)
IO.puts("RELAY_READY #{mode}")
