# Entry point for the *second BEAM OS process* in the plan-010 carrier spike.
#
# Spawned by the GATE test (see test/node_carrier_spike_test.exs) as:
#
#     elixir -pa <each _build/<env>/lib/*/ebin> apps/lattice_node_spike/priv/peer_node.exs \
#       <realm> <trusted-peer-realm> <trusted-peer-pubkey-b64> [scenario-module]
#
# It derives the deterministic scenario prefix for `<realm>` (no keys or ops are
# received from the parent — seeded identities make the prefix byte-identical),
# serves the sync protocol on an OS-assigned WebSocket port, and prints
# `PEER_READY <port>` for the parent to connect to. It halts on a `shutdown`
# protocol message or when stdin closes (the parent died).

[realm, trusted_peer_realm, trusted_peer_pubkey_b64 | rest] = System.argv()

{:ok, _} = Application.ensure_all_started(:crypto)
{:ok, _} = Application.ensure_all_started(:jason)
{:ok, _} = Application.ensure_all_started(:cowboy)

scenario =
  case rest do
    [] -> LatticeNodeSpike.Scenario
    [scenario_name] -> Module.concat([scenario_name])
  end

unless Code.ensure_loaded?(scenario) do
  raise ArgumentError, "unknown scenario module: #{inspect(scenario)}"
end

identity = scenario.session_identity(realm)

{:ok, peer} =
  LatticeNodeSpike.Peer.start_link(realm: realm, identity: identity, scenario: scenario)

trusted_peer_pubkey = Base.decode64!(trusted_peer_pubkey_b64)

{:ok, port} =
  LatticeNodeSpike.PeerServer.start(peer,
    trusted_peer_realm: trusted_peer_realm,
    trusted_peer_pubkey: trusted_peer_pubkey
  )

IO.puts("PEER_READY #{port}")

# Lifeline: if the parent OS process goes away, stdin hits EOF — halt rather
# than linger as an orphan.
spawn(fn ->
  _ = IO.gets("")
  System.halt(0)
end)

# Serve until halted (shutdown message or stdin EOF).
Process.sleep(:infinity)
