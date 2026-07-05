# Township POC — narrated end-to-end demo (PD-001-A §A3).
#
#   mix run scripts/township_demo.exs      (from umbrella root, after mix compile)
#   elixir scripts/township_demo.exs        (after mix test has built _build)
#
# One civic matter, deliberated by two simulated realms — "clerk" and "resident"
# — entirely through a capability-attested op-log. Runs the five Township
# workflows W0–W4 in order, printing the §5 storyline as it executes.
#
# CARRIER CAVEAT: these realms are simulated (Lattice.Sim). The addendum's exit
# gate G1 wants two PHYSICAL BEAM nodes over the real WebSocket boundary — that
# is M2 and is not built yet. This demo proves the civic logic on the real
# substrate; swapping Sim for the real carrier is the M2 upgrade of this script.

unless Code.ensure_loaded?(Lattice.Sim) do
  root = Path.expand("..", __DIR__)
  Path.wildcard(Path.join(root, "_build/*/lib/*/ebin")) |> Enum.each(&Code.append_path/1)
  {:ok, _} = Application.ensure_all_started(:crypto)
end

alias Lattice.{Attestation, Identity, Log, Sim}
alias Township.Matter

replica = "replica:matter:zoning-variance-24"

defmodule T do
  def h(title), do: IO.puts("\n\e[1m\e[36m== #{title} ==\e[0m")
  def say(msg), do: IO.puts("  #{msg}")

  def show(sim, realm) do
    s = Sim.state(sim, realm)

    IO.puts(
      "  [#{realm}] title=#{inspect(s.title)} summary=#{inspect(s.summary)} closed?=#{s.clerk_locked?}"
    )

    IO.puts("        posts=#{inspect(s.posts)}")
    IO.puts("        members=#{inspect(s.members)}")
  end

  def fp(pub), do: Identity.fingerprint(pub)
  # Sim.quarantined/3 returns `false` or `{true, reason}`; normalize for display.
  def q(false), do: false
  def q({flag, _reason}), do: flag
end

IO.puts("\e[1mTownship — a coercion-resistant civic matter on Lattice\e[0m")

# --------------------------------------------------------------- W0
T.h("W0. Join by vouch — clerk admits a resident by capability, not account")
sim = Sim.new(Matter, replica, ["clerk", "resident"], seed: "township")

{sim, _genesis} =
  Sim.create_replica(sim, "clerk", policies: %{clerk: %{successor: "resident", dormant_ticks: 3}})

{sim, _grant} =
  Sim.grant(sim, "clerk", "resident", ops: [:admit, :post, :set_summary, :set_title])

sim = Sim.sync_all(sim)
{sim, _} = Sim.command(sim, "clerk", :admit, ["clerk"])
{sim, _} = Sim.command(sim, "clerk", :admit, ["resident"])
sim = Sim.sync_all(sim)
T.say("resident's identity is self-minted on-device; admission is a Cap from clerk.")
T.show(sim, "resident")

partition_frontier = Log.frontier(Sim.log(sim, "clerk"))

# --------------------------------------------------------------- W1
T.h("W1. Durable deliberation — partition, both edit the summary, then heal")
{sim, _} = Sim.command(sim, "clerk", :set_title, ["Zoning variance #24"])
{sim, _} = Sim.command(sim, "clerk", :post, ["clerk: hearing Tuesday 6pm"])
{sim, _} = Sim.command(sim, "resident", :post, ["resident: I'll attend"])
sim = Sim.partition(sim, "clerk", "resident")
{sim, _} = Sim.command(sim, "clerk", :set_summary, ["Leaning approve (clerk edit)"])
{sim, _} = Sim.command(sim, "resident", :set_summary, ["Needs traffic study (resident edit)"])
{sim, _} = Sim.command(sim, "resident", :post, ["resident: posted while offline"])
T.say("partitioned; each realm edits the shared summary and posts independently.")
sim = sim |> Sim.heal("clerk", "resident") |> Sim.sync_all()
T.say("healed + synced — no coordinator, no conflict dialog:")
T.show(sim, "clerk")
T.show(sim, "resident")

T.say(
  "converged? summary #{Sim.state(sim, "clerk").summary == Sim.state(sim, "resident").summary}, posts #{Sim.state(sim, "clerk").posts == Sim.state(sim, "resident").posts}"
)

# --------------------------------------------------------------- W2
T.h("W2. Roles & consent — clerk authority transfers; a stale op is quarantined")
{sim, close_op} = Sim.command(sim, "clerk", :close_matter, [])

T.say(
  "clerk (genesis holder) closes the matter — honored (quarantined? #{T.q(Sim.quarantined(sim, "clerk", close_op.id))})."
)

# The transfer delegation must attenuate under the genesis cap, so it confers
# Matter's clerk-only commands (not the harness default :lock/:unlock).
{sim, _} =
  Sim.transfer(sim, "clerk", "resident", :clerk, at_tick: 1, ops: [:close_matter, :reopen_matter])

sim = Sim.sync_all(sim)

T.say(
  "clerk role transferred to resident (holder now #{T.fp(Sim.holder(sim, "resident", :clerk))})."
)

{sim, stale_op} = Sim.command(sim, "clerk", :reopen_matter, [])
sim = Sim.sync_all(sim)
# Every realm runs the same deterministic judge over the same log (property d),
# so we assert the quarantine verdict on BOTH realms — matching on {true, _}
# crashes the demo if either one disagrees.
{true, r_reason} = Sim.quarantined(sim, "resident", stale_op.id)
{true, c_reason} = Sim.quarantined(sim, "clerk", stale_op.id)

T.say(
  "clerk's post-transfer reopen op #{String.slice(stale_op.id, 0, 10)}… QUARANTINED on resident (#{r_reason}) and on clerk (#{c_reason})"
)

T.say("same predicate as revocation (V-01); quarantine identical on both realms.")

# --------------------------------------------------------------- W4 (before W3 so we tally a live matter)
T.h("W4. Attestation (STUBBED) — vouches tally; a coercion demand yields nothing")
impl = Lattice.Attestation.Stub
alice = Identity.from_seed("realm:alice", <<9::256>>)
bob = Identity.from_seed("realm:bob", <<10::256>>)
carol = Identity.from_seed("realm:carol", <<11::256>>)
{tok_a, v_a} = Attestation.cast_vouch(impl, alice, :approve)
{_tb, v_b} = Attestation.cast_vouch(impl, bob, :approve)
{_tc, v_c} = Attestation.cast_vouch(impl, carol, :reject)
tally = Attestation.tally(impl, [v_a, v_b, v_c])
T.say("tally over 3 vouches: outcome=#{inspect(tally.outcome)} counts=#{inspect(tally.counts)}")
alt = Attestation.produce_alt(impl, tok_a, :reject)

T.say(
  "alice is coerced to 'prove' she voted #{inspect(elem(alt, 1).choice)} — she produces a valid alternative."
)

T.say("town re-tally is unchanged: #{inspect(Attestation.tally(impl, [v_a, v_b, v_c]).outcome)}.")

T.say(
  "\e[33mreceipt_free? #{Attestation.receipt_free?(impl)} — the property is STUBBED; M4 makes it real.\e[0m"
)

# --------------------------------------------------------------- W3
T.h("W3. Succession & survival — dump the record to disk and restore it")
path = Path.join(System.tmp_dir!(), "township_demo.log")
log = Sim.log(sim, "resident")
:ok = Log.dump(log, path)
{:ok, restored} = Log.restore(path)
File.rm(path)
same_ops = Log.op_ids(restored) == Log.op_ids(log)
same_state = Lattice.state(Matter, restored) == Lattice.state(Matter, log)

T.say(
  "founding device destroyed → restore from disk: ops preserved=#{same_ops}, state preserved=#{same_state}"
)

T.say("nothing was hosted, so nothing was lost — the A3 (seizure) answer.")

# --------------------------------------------------------------- time travel
T.h("Time travel — replay the matter as of the first partition")
historical = Lattice.state_at(Matter, Sim.log(sim, "clerk"), partition_frontier)

T.say(
  "state_at(pre-deliberation frontier): summary=#{inspect(historical.summary)} posts=#{inspect(historical.posts)}"
)

T.say("current: summary=#{inspect(Sim.state(sim, "clerk").summary)}")

# --------------------------------------------------------------- artifacts (G5)
T.h("Artifacts — a replayable bundle an outside auditor can verify")
artifacts_dir = Path.expand("../artifacts/township", __DIR__)
File.mkdir_p!(artifacts_dir)
final_log = Sim.log(sim, "resident")

# matter.log — the op-log IS the replay artifact: an outsider needs nothing but
# this file and the public Township.Matter module to re-materialize the matter.
# The preload matters: restore/1 decodes with binary_to_term(:safe), which
# rejects atoms not already interned, so the substrate's modules must be loaded
# before the dump is read (a fresh `mix run -e` loads modules lazily).
log_path = Path.join(artifacts_dir, "matter.log")
:ok = Log.dump(final_log, log_path)
T.say("wrote #{log_path}")

T.say(
  ~s|replay: mix run -e 'Application.spec(:lattice_core, :modules) \|> Enum.each(&Code.ensure_loaded/1); | <>
    ~s|{:ok, log} = Lattice.Log.restore("artifacts/township/matter.log"); IO.inspect(Lattice.state(Township.Matter, log))'|
)

# audit.json — the deterministic authority verdict (quarantine, reasons, role
# holders, audit trail) any realm recomputes identically from the same log.
# MapSets and raw pubkeys are not JSON; sort the former, fingerprint the latter.
analysis = Sim.authority(sim, "resident")

audit_doc = %{
  quarantine: Enum.sort(analysis.quarantine),
  reasons: analysis.reasons,
  holders: Map.new(analysis.holders, fn {role, pub} -> {role, pub && T.fp(pub)} end),
  audit: analysis.audit
}

audit_path = Path.join(artifacts_dir, "audit.json")
File.write!(audit_path, Jason.encode!(audit_doc, pretty: true) <> "\n")
T.say("wrote #{audit_path}")

# trust_graph.{dot,mermaid} — the delegation graph, straight from the log's
# authority ops. Lattice.Graph.Export is a pure exporter over a
# %{nodes:, edges:} snapshot, so we reuse it as-is by building that snapshot
# from the log rather than from the live Lattice.Graph process (which tracks
# V1 realm/tab processes; re-point this at the live graph when the M2 carrier
# lands and the realms are real processes again).
realm_names = Map.new(["clerk", "resident"], fn r -> {Sim.identity(sim, r).pub, r} end)

deleg_events =
  final_log
  |> Log.topo_ops()
  |> Enum.filter(&(&1.kind == :authority))
  |> Enum.flat_map(fn op ->
    case op.body do
      {:genesis, d, _policies} -> [{"genesis", d}]
      {:grant, d} -> [{"grant", d}]
      {:transfer, role, d, _tick} -> [{"transfer:#{role}", d}]
      {:succeed, role, d, _tick} -> [{"succeed:#{role}", d}]
      _ -> []
    end
  end)

edge_kind = fn kind, d ->
  roles =
    if MapSet.size(d.roles) > 0 do
      " roles=[#{Enum.join(Enum.sort(d.roles), ",")}]"
    else
      ""
    end

  "#{kind}#{roles} ops=[#{Enum.join(Enum.sort(d.ops), ",")}]"
end

snapshot = %{
  nodes:
    deleg_events
    |> Enum.flat_map(fn {_kind, d} -> [d.issuer, d.audience] end)
    |> Enum.uniq()
    |> Enum.map(fn pub ->
      label = if name = realm_names[pub], do: "#{name} #{T.fp(pub)}", else: T.fp(pub)
      %{id: T.fp(pub), kind: "realm", label: label}
    end),
  edges:
    Enum.map(deleg_events, fn {kind, d} ->
      %{from: T.fp(d.issuer), to: T.fp(d.audience), kind: edge_kind.(kind, d)}
    end)
}

for {ext, format} <- [{"dot", :dot}, {"mermaid", :mermaid}] do
  graph_path = Path.join(artifacts_dir, "trust_graph.#{ext}")
  File.write!(graph_path, Lattice.Graph.Export.export(snapshot, format) <> "\n")
  T.say("wrote #{graph_path}")
end

IO.puts(
  "\n\e[1m\e[32mTownship POC demo complete — the log was the truth; the coercer got nothing (stubbed).\e[0m"
)
