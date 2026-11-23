# Connects the Township Phoenix LiveView instrument (apps/township_web) to the
# unified local demo relay's `township_matter` instance with live `ops_available`
# server-push hints.
#
# Usage:
#   PHX_SERVER=true PORT=4120 SECRET_KEY_BASE=... \
#     mix run --no-halt scripts/demo_ecosystem_township_live.exs [demo_dir]

alias Lattice.Identity
alias TownshipWeb.CarrierProjection

demo_dir =
  case System.argv() do
    [dir | _] -> Path.expand(dir)
    [] -> Path.expand(System.get_env("DEMO_ECOSYSTEM_DIR") || "output/demo_ecosystem")
  end

endpoints_path = Path.join(demo_dir, "demo-endpoints.json")

unless File.exists?(endpoints_path) do
  IO.puts(:stderr, "Missing #{endpoints_path}. Start scripts/demo_ecosystem_relay.sh first.")
  System.halt(1)
end

summary = endpoints_path |> File.read!() |> Jason.decode!()
township_ep = Enum.find(summary["endpoints"], &(&1["name"] == "township_matter"))
observer_meta = summary["participants"]["observer"]

if is_nil(township_ep) or is_nil(observer_meta) do
  IO.puts(:stderr, "demo-endpoints.json is missing township_matter or observer metadata.")
  System.halt(1)
end

uri = URI.parse(township_ep["ws_url"])
carrier_port = uri.port || 4203
server_realm = township_ep["peer_realm"]
server_pubkey = Base.decode64!(township_ep["peer_pubkey"])
replica = township_ep["replica"]

observer_seed_hex = observer_meta["seed_file"] |> File.read!() |> String.trim()
observer_seed = Base.decode16!(observer_seed_hex, case: :mixed)
{pub, priv} = :crypto.generate_key(:eddsa, :ed25519, observer_seed)
observer = %Identity{realm_id: observer_meta["realm"], pub: pub, priv: priv}

connect_opts = [
  hostname: uri.host || "127.0.0.1",
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
  schedule: [initial_delay_ms: 15_000, poll_interval_ms: 30_000]
)

Application.put_env(
  :township_web,
  :instrument_projection_server,
  CarrierProjection
)

{:ok, _apps} = Application.ensure_all_started(:township_web)

spawn_link(fn ->
  {:ok, _initial} = CarrierProjection.subscribe()

  loop = fn loop ->
    receive do
      {:township_instrument, {:fresh, payload}} ->
        posts = payload.read_model.threads.posts
        op_count = length(payload.causal_replay["nodes"])

        IO.puts("TOWNSHIP_PROJECTION_UPDATE ops=#{op_count} posts=#{Jason.encode!(posts)}")

        loop.(loop)

      _other ->
        loop.(loop)
    end
  end

  loop.(loop)
end)

case CarrierProjection.refresh() do
  {:ok, {:fresh, payload}} ->
    port = System.get_env("PORT", "4120")
    op_count = length(payload.causal_replay["nodes"])

    IO.puts(
      "TOWNSHIP_DEMO_LIVE_READY http://localhost:#{port}/township (replica=#{replica}, ops=#{op_count}, feed=server_push)"
    )

  other ->
    IO.puts(
      :stderr,
      "Failed to connect Township LiveView to demo relay at #{township_ep["ws_url"]}: #{inspect(other)}"
    )

    System.halt(1)
end
