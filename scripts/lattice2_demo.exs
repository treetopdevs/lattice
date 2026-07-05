# Lattice 2.0 POC — narrated end-to-end demo.
#
#   mix run scripts/lattice2_demo.exs      (from apps/lattice_core, or umbrella root)
#   elixir scripts/lattice2_demo.exs       (after `mix compile`/`mix test`)
#
# Two simulated realms — "server" (a BEAM node) and "tab" (a browser AtomVM node) —
# collaborate on a Thread Replica entirely through its capability-attested op-log.
# Everything is deterministic: logical ticks are explicit, never wall clocks.

# --- bootstrap code paths so the script runs under plain `elixir` too ---
unless Code.ensure_loaded?(Lattice.Sim) do
  root = Path.expand("..", __DIR__)

  Path.wildcard(Path.join(root, "_build/*/lib/*/ebin"))
  |> Enum.each(&Code.append_path/1)

  {:ok, _} = Application.ensure_all_started(:crypto)
end

alias Lattice.{Authority, Log, Sim}
alias Lattice.Demo.Thread

replica = "replica:thread:demo"
defmodule D do
  def h(title), do: IO.puts("\n\e[1m\e[36m== #{title} ==\e[0m")
  def say(msg), do: IO.puts("  #{msg}")
  def show(sim, realm) do
    s = Sim.state(sim, realm)
    IO.puts("  [#{realm}] title=#{inspect(s.title)} locked?=#{s.locked?}")
    IO.puts("        messages=#{inspect(s.messages)}")
    IO.puts("        participants=#{inspect(s.participants)}")
  end
  def fp(pub), do: Lattice.Identity.fingerprint(pub)
end

IO.puts("\e[1mLattice 2.0 — Replicas on a Capability-Attested Log\e[0m")

# ---------------------------------------------------------------------------
D.h("1. Create the Thread Replica; server grants tab a capability")
sim = Sim.new(Thread, replica, ["server", "tab"], seed: "demo")
{sim, _genesis} = Sim.create_replica(sim, "server", policies: %{moderator: %{successor: "tab", dormant_ticks: 3}})
{sim, _grant} = Sim.grant(sim, "server", "tab", ops: [:post, :set_title, :join, :leave, :lock, :unlock])
sim = Sim.sync_all(sim)
{sim, _} = Sim.command(sim, "server", :join, ["server"])
{sim, _} = Sim.command(sim, "tab", :join, ["tab"])
sim = Sim.sync_all(sim)
D.say("server holds the :moderator authority (genesis); tab may post/title/join.")
D.show(sim, "server")

# Snapshot the causal frontier here — we will time-travel back to it at the end.
partition_frontier = Log.frontier(Sim.log(sim, "server"))

# ---------------------------------------------------------------------------
D.h("2. Partition. Both realms post and edit the title; server locks offline")
sim = Sim.partition(sim, "server", "tab")
{sim, _} = Sim.command(sim, "server", :post, ["server: deploy window is 17:00"])
{sim, _} = Sim.command(sim, "server", :set_title, ["Release Plan (server edit)"])
{sim, _} = Sim.command(sim, "tab", :post, ["tab: ack, I'll watch dashboards"])
{sim, _} = Sim.command(sim, "tab", :set_title, ["Release Plan (tab edit)"])
{sim, _server_lock} = Sim.command(sim, "server", :lock, [])
D.say("server (the holder) locks the thread while partitioned (offline-authoritative).")

# tab is NOT the holder: a direct lock is quarantined; tab queues a request instead.
{sim, tab_lock} = Sim.command(sim, "tab", :lock, [])
{sim, _req} = Sim.request(sim, "tab", "req-lock-1", {:lock, []})
D.say("tab's direct lock attempt is authored but will be quarantined (not the holder).")
D.say("tab instead queues a :request through the holder.")
IO.puts("")
D.show(sim, "server")
D.show(sim, "tab")

# ---------------------------------------------------------------------------
D.h("3. Heal + sync: convergent merge; tab's lock is quarantined and audited")
sim = sim |> Sim.heal("server", "tab") |> Sim.sync_all()
D.show(sim, "server")
D.show(sim, "tab")
{true, reason} = Sim.quarantined(sim, "server", tab_lock.id)
D.say("tab's lock op #{String.slice(tab_lock.id, 0, 10)}… is QUARANTINED: #{reason}")

analysis = Sim.authority(sim, "server")
D.say("audit (sample): #{inspect(Enum.take(analysis.audit, 2))}")
D.say("queued request now visible to the holder: #{inspect(Enum.map(analysis.requests, & &1.ref))}")
{sim, _} = Sim.command(sim, "server", :lock, [])
D.say("holder replays the request → emits the real lock op (idempotent; stays locked).")

# ---------------------------------------------------------------------------
D.h("4. Transfer the :moderator capability to tab")
{sim, _} = Sim.transfer(sim, "server", "tab", :moderator, at_tick: 1)
sim = Sim.sync_all(sim)
D.say("holder is now: #{D.fp(Sim.holder(sim, "tab", :moderator))} (tab=#{D.fp(Sim.identity(sim, "tab").pub)})")

# ---------------------------------------------------------------------------
D.h("5. server dormant; tab locks/unlocks offline-authoritatively")
sim = Sim.partition(sim, "server", "tab")
{sim, _} = Sim.command(sim, "tab", :unlock, [])
{sim, tab_lock2} = Sim.command(sim, "tab", :lock, [])
refute_quarantined = Sim.quarantined(sim, "tab", tab_lock2.id) == false
D.say("tab (now the holder) toggled lock offline; honored? #{refute_quarantined}")
sim = sim |> Sim.heal("server", "tab") |> Sim.sync_all()

# ---------------------------------------------------------------------------
D.h("6. Hand authority back to server, then succession fires after dormancy")
{sim, _} = Sim.transfer(sim, "tab", "server", :moderator, at_tick: 2)
sim = Sim.sync_all(sim)
{sim, _} = Sim.heartbeat(sim, "server", :moderator, 5)
sim = Sim.sync_all(sim)
D.say("server holds again and was last active at logical tick 5 (threshold = 3 ticks).")

# server goes dormant; a lagging server (forked frontier) will later return stale.
{stale_branch, stale_lock} = Sim.command(sim, "server", :lock, [])

D.say("logical clock advances to tick 9 (> 5 + 3) while server is dormant…")
{sim, _} = Sim.succeed(sim, "tab", :moderator, at_tick: 9)
sim = Sim.sync_all(sim)
D.say("succession fired: holder is now #{D.fp(Sim.holder(sim, "server", :moderator))} (tab).")

# ---------------------------------------------------------------------------
D.h("7. Returning server's stale lock is quarantined on every realm")
{merged, _, _} = Lattice.Sync.reconcile(Sim.log(sim, "server"), Sim.log(stale_branch, "server"))
merged_analysis = Authority.analyze(Thread, merged)
D.say("stale lock op #{String.slice(stale_lock.id, 0, 10)}… verdict: #{Map.get(merged_analysis.reasons, stale_lock.id)}")
D.say("holder after merge: #{D.fp(Authority.holder(Thread, merged, :moderator))} (still tab — succession wins)")

# ---------------------------------------------------------------------------
D.h("8. Time travel: replay the thread as of the first partition")
historical = Lattice.state_at(Thread, Sim.log(sim, "server"), partition_frontier)
D.say("state_at(first-partition frontier):")
IO.puts("        title=#{inspect(historical.title)} messages=#{inspect(historical.messages)}")
D.say("current state:")
current = Sim.state(sim, "server")
IO.puts("        title=#{inspect(current.title)} messages=#{inspect(current.messages)}")

IO.puts("\n\e[1m\e[32mDemo complete — the log was the truth at every step.\e[0m")
