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

pop_flag = fn argv, flag ->
  case Enum.split_while(argv, &(&1 != flag)) do
    {before, [^flag, value | after_]} -> {value, before ++ after_}
    {_before, [^flag]} -> {nil, argv}
    {_before, []} -> {nil, argv}
  end
end

{bootstrap_audience_pubkey_b64, argv} = pop_flag.(System.argv(), "--bootstrap-audience")
{replica, argv} = pop_flag.(argv, "--replica")

{realm, trusted_peer_realm, trusted_peer_pubkey_b64, scenario, identity_seed} =
  case argv do
    [realm, trusted_peer_realm, trusted_peer_pubkey_b64] ->
      {realm, trusted_peer_realm, trusted_peer_pubkey_b64, LatticeNodeSpike.Scenario, nil}

    [realm, trusted_peer_realm, trusted_peer_pubkey_b64, scenario_name] ->
      scenario = Module.concat([scenario_name])
      Code.ensure_loaded!(scenario)
      {realm, trusted_peer_realm, trusted_peer_pubkey_b64, scenario, nil}

    [realm, trusted_peer_realm, trusted_peer_pubkey_b64, scenario_name, identity_seed] ->
      scenario = Module.concat([scenario_name])
      Code.ensure_loaded!(scenario)
      {realm, trusted_peer_realm, trusted_peer_pubkey_b64, scenario, identity_seed}
  end

{:ok, _} = Application.ensure_all_started(:lattice_node_spike)

identity =
  cond do
    is_binary(identity_seed) -> Lattice.Identity.from_seed(realm, identity_seed)
    function_exported?(scenario, :session_identity, 1) -> scenario.session_identity(realm)
    true -> Lattice.Identity.from_seed(realm, "carrier-spike")
  end

peer_opts = [realm: realm, identity: identity, scenario: scenario]

peer_opts =
  if is_binary(replica), do: Keyword.put(peer_opts, :replica, replica), else: peer_opts

peer_opts =
  if is_binary(bootstrap_audience_pubkey_b64) do
    Keyword.put(
      peer_opts,
      :bootstrap_audience_pubkey,
      Base.decode64!(bootstrap_audience_pubkey_b64)
    )
  else
    peer_opts
  end

{:ok, peer} =
  LatticeNodeSpike.Peer.start_link(peer_opts)

trusted_peer_pubkey = Base.decode64!(trusted_peer_pubkey_b64)

{:ok, port} =
  LatticeNodeSpike.PeerServer.start(peer,
    trusted_peer_realm: trusted_peer_realm,
    trusted_peer_pubkey: trusted_peer_pubkey
  )

IO.puts("PEER_PUBKEY #{Base.encode64(identity.pub)}")
IO.puts("PEER_READY #{port}")

# Lifeline: if the parent OS process goes away, stdin hits EOF — halt rather
# than linger as an orphan.
spawn(fn ->
  _ = IO.gets("")
  System.halt(0)
end)

# Serve until halted (shutdown message or stdin EOF).
Process.sleep(:infinity)
