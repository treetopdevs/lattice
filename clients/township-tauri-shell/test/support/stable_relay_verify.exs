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
    "base" -> "base"
    "close" -> "afterClose"
    "peer" -> "afterPeer"
    "reopen" -> "afterReopen"
    "restart" -> "afterRestartPost"
    "roster_admit" -> "afterAdmit"
    "roster_contested" -> "afterContested"
    "roster_peer" -> "afterPeer"
    "summary" -> "afterSummary"
    "title" -> "afterTitle"
    _mode -> "afterPost"
  end

expected =
  case mode do
    "grant_base" -> Map.fetch!(oracle, "base")
    "grant_sound" -> get_in(oracle, ["soundGrant", "after"])
    "grant_recipient_use" -> get_in(oracle, ["recipientUse", "after"])
    "grant_unsound" -> get_in(oracle, ["unsoundUse", "after"])
    _mode -> Map.fetch!(oracle, expected_key)
  end
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

if observer.pub in Enum.map(served_ops, & &1.author),
  do: raise("pull-only observer authored an operation")

if String.starts_with?(mode, "roster_") do
  allowed_authors =
    MapSet.new([
      Base.decode64!(Map.fetch!(oracle, "participantPubkey")),
      Base.decode64!(Map.fetch!(oracle, "peerPubkey"))
    ])

  unexpected_authors =
    served_ops
    |> Enum.map(& &1.author)
    |> MapSet.new()
    |> MapSet.difference(allowed_authors)

  if MapSet.size(unexpected_authors) > 0,
    do: raise("roster source contains an operation by the server or pull-only observer")
end

if String.starts_with?(mode, "grant_") do
  allowed_authors =
    oracle
    |> Map.fetch!("baseAuthorPubkeys")
    |> Kernel.++([
      Map.fetch!(oracle, "issuerPubkey"),
      Map.fetch!(oracle, "recipientPubkey"),
      Map.fetch!(oracle, "unsoundAudiencePubkey")
    ])
    |> Enum.map(&Base.decode64!/1)
    |> MapSet.new()

  unexpected_authors =
    served_ops
    |> Enum.map(& &1.author)
    |> MapSet.new()
    |> MapSet.difference(allowed_authors)

  if MapSet.size(unexpected_authors) > 0,
    do: raise("grant source contains an operation by the server or pull-only observer")
end

if mode == "authority" do
  denied_id = oracle["authorityInvalidOp"]["id"]
  quarantine = actual["readModel"]["roles"]["quarantine"]
  reasons = actual["readModel"]["roles"]["reasons"]
  if denied_id not in quarantine, do: raise("authority-invalid operation missing from quarantine")
  if reasons[denied_id] != "no_capability", do: raise("authority-invalid reason mismatch")
end


if mode == "grant_sound" do
  sound_grant_id = get_in(oracle, ["soundGrant", "frame", "id"])

  if Map.has_key?(actual["readModel"]["roles"]["reasons"], sound_grant_id),
    do: raise("sound grant unexpectedly quarantined")
end

if mode == "grant_recipient_use" do
  recipient_use_id = get_in(oracle, ["recipientUse", "frame", "id"])

  if Map.has_key?(actual["readModel"]["roles"]["reasons"], recipient_use_id),
    do: raise("recipient use unexpectedly quarantined")
end

if mode == "grant_unsound" do
  unsound_grant_id = get_in(oracle, ["unsoundGrant", "frame", "id"])
  unsound_use_id = get_in(oracle, ["unsoundUse", "frame", "id"])
  reasons = actual["readModel"]["roles"]["reasons"]

  if reasons[unsound_grant_id] != "not_attenuated",
    do: raise("unsound grant reason mismatch")

  if reasons[unsound_use_id] != "invalid_capability",
    do: raise("unsound grant use reason mismatch")
end

:ok = GenServer.stop(projection, :normal)
IO.puts("VERIFY_READY #{mode}")
