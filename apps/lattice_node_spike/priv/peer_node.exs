# Entry point for the *second BEAM OS process* in the plan-010 carrier spike.
#
# Spawned by the GATE test (see test/node_carrier_spike_test.exs) as:
#
#     elixir -pa <each _build/<env>/lib/*/ebin> apps/lattice_node_spike/priv/peer_node.exs <realm>
#
# It derives the deterministic scenario prefix for `<realm>` (no keys or ops are
# received from the parent — seeded identities make the prefix byte-identical),
# serves the sync protocol on an OS-assigned WebSocket port, and prints
# `PEER_READY <port>` for the parent to connect to. It halts on a `shutdown`
# protocol message or when stdin closes (the parent died).

[realm] = System.argv()

{:ok, _} = Application.ensure_all_started(:crypto)
{:ok, _} = Application.ensure_all_started(:jason)
{:ok, _} = Application.ensure_all_started(:cowboy)

identity = Lattice.Identity.from_seed(realm, "carrier-spike")
{:ok, peer} = LatticeNodeSpike.Peer.start_link(realm: realm, identity: identity)
{:ok, port} = LatticeNodeSpike.PeerServer.start(peer)

IO.puts("PEER_READY #{port}")

# Lifeline: if the parent OS process goes away, stdin hits EOF — halt rather
# than linger as an orphan.
spawn(fn ->
  _ = IO.gets("")
  System.halt(0)
end)

# Serve until halted (shutdown message or stdin EOF).
Process.sleep(:infinity)
