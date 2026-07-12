alias Lattice.Carrier.WebSocket
alias Lattice.{Identity, Log, Sync}
alias TownshipWeb.CarrierProjection

[
  port_text,
  server_realm,
  server_pubkey_b64,
  observer_realm,
  observer_seed,
  replica,
  oracle_path,
  mode
] = System.argv()

oracle = oracle_path |> File.read!() |> Jason.decode!()

expected_key =
  case mode do
    "authority" -> "afterAuthorityInvalid"
    "restart" -> "afterRestartPost"
    _mode -> "afterPost"
  end

expected = Map.fetch!(oracle, expected_key)
observer = Identity.from_seed(observer_realm, observer_seed)
server_pubkey = Base.decode64!(server_pubkey_b64)
port = String.to_integer(port_text)
json_safe = fn value -> value |> Jason.encode!() |> Jason.decode!() end

{:ok, _apps} = Application.ensure_all_started(:township_web)

connect_opts = [
  hostname: "127.0.0.1",
  port: port,
  identity: observer,
  realm: observer.realm_id,
  peer_realm: server_realm,
  peer_pubkey: server_pubkey,
  replica: replica
]

{:ok, projection} =
  CarrierProjection.start_link(
    connect_opts: connect_opts,
    replica: replica,
    peer_realm: server_realm,
    pubsub: TownshipWeb.PubSub,
    topic: "township:stable-relay-verify:#{System.unique_integer([:positive])}",
    schedule: :manual
  )

payload =
  case CarrierProjection.refresh(projection) do
    {:ok, {:fresh, payload}} ->
      payload

    other ->
      {:ok, diagnostic_connection} = WebSocket.connect(connect_opts)

      {:ok, diagnostic_ops, diagnostic_connection} =
        WebSocket.pull(diagnostic_connection, MapSet.new())

      :ok = WebSocket.close(diagnostic_connection)
      {_diagnostic_log, diagnostic_report} = Sync.deliver(Log.new(replica), diagnostic_ops)

      raise "projection refresh failed: #{inspect(%{state: other, op_ids: Enum.map(diagnostic_ops, & &1.id), report: diagnostic_report}, limit: :infinity)}"
  end

actual =
  json_safe.(%{
    "opIds" => payload.causal_replay["nodes"] |> Enum.map(& &1["id"]) |> Enum.sort(),
    "readModel" => payload.read_model,
    "causalReplay" => payload.causal_replay
  })

if actual != expected do
  raise "projection mismatch for #{mode}: #{inspect(%{expected: expected, actual: actual}, limit: 20)}"
end

{:ok, connection} = WebSocket.connect(connect_opts)
{:ok, served_ops, connection} = WebSocket.pull(connection, MapSet.new())
:ok = WebSocket.close(connection)

served_ids = served_ops |> Enum.map(& &1.id) |> Enum.sort()
if served_ids != expected["opIds"], do: raise("served operation ids do not match #{mode} oracle")

if server_pubkey in Enum.map(served_ops, & &1.author),
  do: raise("server transport key authored an operation")

if mode == "authority" do
  denied_id = oracle["authorityInvalidOp"]["id"]
  quarantine = actual["readModel"]["roles"]["quarantine"]
  reasons = actual["readModel"]["roles"]["reasons"]
  if denied_id not in quarantine, do: raise("authority-invalid operation missing from quarantine")
  if reasons[denied_id] != "no_capability", do: raise("authority-invalid reason mismatch")
end

:ok = GenServer.stop(projection, :normal)
IO.puts("VERIFY_READY #{mode}")
