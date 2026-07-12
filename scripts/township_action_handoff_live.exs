alias Lattice.Identity
alias TownshipWeb.CarrierProjection

[
  carrier_port_text,
  server_realm,
  server_pubkey_b64,
  observer_realm,
  observer_seed,
  replica
] = System.argv()

Logger.configure(level: :info)

observer = Identity.from_seed(observer_realm, observer_seed)
server_pubkey = Base.decode64!(server_pubkey_b64)
carrier_port = String.to_integer(carrier_port_text)

connect_opts = [
  hostname: "127.0.0.1",
  port: carrier_port,
  identity: observer,
  realm: observer.realm_id,
  peer_realm: server_realm,
  peer_pubkey: server_pubkey,
  replica: replica
]

Application.put_env(:township_web, :instrument_projection_options,
  feed: :server_push,
  connect_opts: connect_opts,
  replica: replica,
  peer_realm: server_realm,
  schedule: [initial_delay_ms: 60_000, poll_interval_ms: 60_000]
)

Application.put_env(
  :township_web,
  :instrument_projection_server,
  CarrierProjection
)

{:ok, _apps} = Application.ensure_all_started(:township_web)

case CarrierProjection.refresh() do
  {:ok, {:fresh, payload}} ->
    op_count = length(payload.causal_replay["nodes"])
    IO.puts("TOWNSHIP_ACTION_HANDOFF_READY #{op_count}")

  other ->
    raise "initial action-handoff projection failed: #{inspect(other, limit: :infinity)}"
end

Process.sleep(:infinity)
