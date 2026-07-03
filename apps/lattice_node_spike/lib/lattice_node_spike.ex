defmodule LatticeNodeSpike do
  @moduledoc """
  Plan-010 light-path spike: two BEAM **OS processes** exchanging Replica ops
  over a real WebSocket, converging to byte-identical reduced state and
  matching the in-process `Lattice.Sim` oracle for the same op set.

  Pieces:

    * `LatticeNodeSpike.Scenario` — the deterministic scenario both OS
      processes derive independently (seeded identities make the shared op
      prefix byte-identical without any key exchange).
    * `LatticeNodeSpike.Peer` — holds one realm's `Lattice.Log` in the peer OS
      process; diverges (appends offline commands) when the socket closes.
    * `LatticeNodeSpike.WsHandler` / `PeerServer` — the Cowboy WebSocket
      boundary the peer serves the sync protocol on.
    * `LatticeNodeSpike.WsCarrier` — the `Lattice.Carrier` implementation the
      test drives from this OS process, over
      `Lattice.Transport.WebSocket.Client` (raw `:gen_tcp`, real handshake).
    * `LatticeNodeSpike.Wire` — op wire format: Base64 of the pinned
      `:erlang.term_to_binary/2` encoding (canonical CBOR is the recorded
      follow-up for non-BEAM realms; ADR 0001 / ADR 0005).
    * `priv/peer_node.exs` — the second OS process's entry point.

  The GATE test lives in `test/node_carrier_spike_test.exs`.
  """
end
