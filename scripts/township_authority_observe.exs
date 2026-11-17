# Township authority observation (row 157).
#
#   mix run scripts/township_authority_observe.exs   (from umbrella root, after mix compile)
#
# Builds one Lattice.Sim scenario on Township.Matter and prints the read-only
# Lattice.Authority.observe/2 view the instrument's roles panel renders: the
# clerk role's honored acquisitions, the accepted beacons and the leased
# delegations. Author-asserted ticks are never shown. The highest accepted
# beacon epoch is global to the log, not the epoch any one operation saw.
# The script ends with self-checks that raise on any mismatch.
#
# Keys are disposable Sim seeds.

unless Code.ensure_loaded?(Lattice.Sim) do
  root = Path.expand("..", __DIR__)
  Path.wildcard(Path.join(root, "_build/*/lib/*/ebin")) |> Enum.each(&Code.append_path/1)
  {:ok, _} = Application.ensure_all_started(:crypto)
end

alias Lattice.{Authority, Identity, Log, Sim}
alias Township.{Matter, ReadModel}

defmodule ObserveDemo do
  def h(title), do: IO.puts("\n== #{title} ==")
  def say(msg), do: IO.puts("  #{msg}")
  def short(id), do: String.slice(id, 0, 12)
  def fp(pub), do: Identity.fingerprint(pub)

  def check!(true, _msg), do: :ok
  def check!(_false, msg), do: raise("self-check failed: #{msg}")
end

realms = ["clerk", "resident", "neighbor"]
sim = Sim.new(Matter, "replica:matter:row157-observe-demo", realms, seed: "row157-demo")
names = Map.new(realms, &{ObserveDemo.fp(Sim.identity(sim, &1).pub), &1})

{sim, _genesis} =
  Sim.create_replica(sim, "clerk", policies: %{clerk: %{successor: "resident", dormant_ticks: 2}})

sim = Sim.sync_all(sim)
{sim, _claim} = Sim.succeed(sim, "resident", :clerk, at_tick: 3, ops: [:close_matter])
sim = Sim.sync_all(sim)
{sim, _transfer} = Sim.transfer(sim, "resident", "neighbor", :clerk, ops: [:close_matter])
sim = Sim.sync_all(sim)

{sim, lapsed} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 3)
{sim, active} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 9)
{sim, unleased} = Sim.grant(sim, "clerk", "resident", ops: [:post])
{sim, revoked} = Sim.grant(sim, "clerk", "neighbor", ops: [:post], expires_epoch: 9)
{sim, _revoke} = Sim.revoke(sim, "clerk", revoked.id)

{sim, _b1} = Sim.beacon(sim, "clerk", 1)
{sim, _b5} = Sim.beacon(sim, "clerk", 5)
{sim, stale} = Sim.beacon(sim, "clerk", 2)
sim = Sim.sync_all(sim)
{sim, non_root} = Sim.beacon(sim, "resident", 9)
sim = Sim.sync_all(sim)

log = Sim.log(sim, "clerk")
before = Authority.analyze(Matter, log)
observation = Authority.observe(Matter, log)
model = ReadModel.observe(log)
label = fn fingerprint -> "#{names[fingerprint] || "?"} #{fingerprint}" end

ObserveDemo.h("Role history (clerk), honored acquisitions, oldest first")

for entry <- model.roles.chronology.clerk do
  ObserveDemo.say(
    "#{label.(entry.holder)} via #{ObserveDemo.short(entry.op_id)} " <>
      "(delegation #{ObserveDemo.short(entry.delegation_id)})"
  )
end

ObserveDemo.h("Beacons")

for beacon <- Enum.sort_by(observation.beacons.valid, & &1.epoch) do
  ObserveDemo.say("accepted epoch #{beacon.epoch} at #{ObserveDemo.short(beacon.op_id)}")
end

ObserveDemo.say("highest accepted epoch on this log: #{observation.beacons.max_epoch}")

for op <- [stale, non_root] do
  ObserveDemo.say("quarantined #{ObserveDemo.short(op.id)}: #{inspect(before.reasons[op.id])}")
end

ObserveDemo.h("Leases (live-path view)")

tags = %{lapsed.id => "lapsed grant", active.id => "active grant", revoked.id => "revoked grant"}

for lease <- model.roles.leases do
  ObserveDemo.say(
    "#{tags[lease.delegation_id] || "grant"} #{ObserveDemo.short(lease.delegation_id)}: " <>
      "#{label.(lease.issuer)} -> #{label.(lease.audience)}, " <>
      "expires after epoch #{lease.expires_epoch}, #{lease.status}, expired?=#{lease.expired?}"
  )
end

leased_ids = Enum.map(observation.leases, & &1.delegation_id)

ObserveDemo.say(
  "unleased grant #{ObserveDemo.short(unleased.id)} absent: #{unleased.id not in leased_ids}"
)

# --- Self-checks ---------------------------------------------------------------

after_analysis = Authority.analyze(Matter, log)
ObserveDemo.check!(after_analysis == before, "analyze/2 changed after observe/2")

ObserveDemo.check!(
  before |> Map.keys() |> Enum.sort() ==
    [:audit, :holder_epochs, :holders, :policies, :quarantine, :reasons, :requests],
  "analyze/2 key set"
)

last = List.last(observation.chronology.clerk)

ObserveDemo.check!(
  last.op_id == before.holder_epochs.clerk.op_id and
    last.holder == before.holder_epochs.clerk.holder,
  "last chronology entry matches holder_epochs"
)

ObserveDemo.check!(
  Enum.all?(observation.leases, &(&1.expired? == Authority.expired?(log, &1.delegation_id))),
  "lease expired? matches Authority.expired?/2"
)

statuses = Map.new(model.roles.leases, &{&1.delegation_id, &1.status})

ObserveDemo.check!(
  statuses == %{lapsed.id => :lapsed, active.id => :active, revoked.id => :revoked},
  "lease statuses"
)

ObserveDemo.check!(
  Enum.map(observation.beacons.valid, & &1.epoch) |> Enum.sort() == [1, 5] and
    before.reasons[stale.id] == :stale_beacon and
    before.reasons[non_root.id] == :unauthorized_beacon,
  "beacon judgement"
)

ObserveDemo.check!(length(observation.chronology.clerk) == 3, "three clerk acquisitions")

ObserveDemo.check!(
  Log.frontier(log) == Log.frontier(Sim.log(sim, "neighbor")),
  "realms converged"
)

IO.puts("\nanalyze/2 unchanged (7 keys); observe consistent with expired?/2 and holder_epochs")
