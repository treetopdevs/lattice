alias Lattice.Carrier.{WebSocket, Wire}
alias Lattice.Identity

[
  port_text,
  server_realm,
  server_pubkey_b64,
  recipient_realm,
  recipient_seed,
  unsound_audience_realm,
  unsound_audience_seed,
  replica,
  oracle_path
] = System.argv()

oracle = oracle_path |> File.read!() |> Jason.decode!()
Code.ensure_loaded!(Township.Matter)
Code.ensure_loaded!(LatticeNodeSpike.TownshipGrantHandoffScenario)
{:ok, [unsound_grant]} = Wire.decode_ops([get_in(oracle, ["unsoundGrant", "frame"])])
{:ok, [unsound_use]} = Wire.decode_ops([get_in(oracle, ["unsoundUse", "frame"])])
recipient = Identity.from_seed(recipient_realm, recipient_seed)
unsound_audience = Identity.from_seed(unsound_audience_realm, unsound_audience_seed)
server_pubkey = Base.decode64!(server_pubkey_b64)
port = String.to_integer(port_text)

if Base.encode64(recipient.pub) != oracle["recipientPubkey"] do
  raise "grant-handoff recipient identity does not match the fixture oracle"
end

if Base.encode64(unsound_audience.pub) != oracle["unsoundAudiencePubkey"] do
  raise "grant-handoff unsound audience identity does not match the fixture oracle"
end

relay = fn identity, op ->
  connect_opts = [
    hostname: "127.0.0.1",
    port: port,
    identity: identity,
    realm: identity.realm_id,
    peer_realm: server_realm,
    peer_pubkey: server_pubkey,
    replica: replica
  ]

  {:ok, connection} = WebSocket.connect(connect_opts)
  {:ok, %{accepted: [accepted_id]}, connection} = WebSocket.relay(connection, op)

  if accepted_id != op.id do
    raise "stable relay accepted the wrong grant-handoff operation"
  end

  :ok = WebSocket.close(connection)
end

:ok = relay.(recipient, unsound_grant)
:ok = relay.(unsound_audience, unsound_use)
IO.puts("GRANT_UNSOUND_RELAY_READY")
