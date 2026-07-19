# Toolshed POC — narrated end-to-end demo (PD-003 one-pager §3 storyline).
#
#   mix run scripts/toolshed_demo.exs      (from umbrella root, after mix compile)
#   elixir scripts/toolshed_demo.exs        (after mix test has built _build)
#
# One neighborhood shed and one tool, run by three simulated realms — "founder",
# "neighbor", and "drifter" — entirely through a capability-attested op-log.
# Custody is computed from op presence in the DAG: the borrow is a dual-signed
# `:custody_transfer` (ADR 0007), the due-back is a plan-149 lease on the
# borrow Cap, and overdue is COMPUTED, never asserted or nagged.
#
# The ledger does not prevent theft. It makes accountability unambiguous —
# that is the entire claim, and the substrate already proves it.

unless Code.ensure_loaded?(Lattice.Sim) do
  root = Path.expand("..", __DIR__)
  Path.wildcard(Path.join(root, "_build/*/lib/*/ebin")) |> Enum.each(&Code.append_path/1)
  {:ok, _} = Application.ensure_all_started(:crypto)
end

alias Lattice.{Authority, Identity, Log, Sim}
alias Toolshed.{ReadModel, Shed, Tool}

defmodule T do
  def h(title), do: IO.puts("\n\e[1m\e[36m== #{title} ==\e[0m")
  def say(msg), do: IO.puts("  #{msg}")

  def shed(sim, realm) do
    s = Sim.state(sim, realm)

    IO.puts(
      "  [#{realm}] shed=#{inspect(s.name)} neighbors=#{inspect(Enum.sort(s.neighbors))} inventory=#{inspect(Enum.sort(s.inventory))}"
    )
  end

  def loan(model) do
    case model.loan do
      nil ->
        IO.puts("  loan: none — tool is home (available? #{model.custody.available?})")

      loan ->
        IO.puts(
          "  loan: out to #{loan.borrower_fingerprint}, due epoch #{loan.due_epoch}, overdue? #{loan.overdue?}"
        )
    end
  end

  def requests(model) do
    for r <- model.requests do
      IO.puts(
        "  request #{String.slice(r.op, 0, 10)}… by #{r.author_fingerprint}: resolved? #{r.resolved?}"
      )
    end
  end

  def fp(pub), do: Identity.fingerprint(pub)
  # Sim.quarantined/3 returns `false` or `{true, reason}`; normalize for display.
  def q(false), do: false
  def q({flag, _reason}), do: flag
end

IO.puts("\e[1mToolshed — neighbors lending tools with an unambiguous custody record\e[0m")

shed_replica = "replica:shed:maple-block"
tool_replica = "replica:tool:tile-saw"

# --------------------------------------------------------------- Beat 1
T.h("1. A block starts a shed — neighbors join by vouch Cap, nothing is hosted")
shed = Sim.new(Shed, shed_replica, ["founder", "neighbor", "drifter"], seed: "toolshed-demo")

{shed, _genesis} =
  Sim.create_replica(shed, "founder",
    policies: %{steward: %{successor: "neighbor", dormant_ticks: 3}}
  )

{shed, _} = Sim.command(shed, "founder", :set_name, ["Maple Block Toolshed"])
{shed, _} = Sim.command(shed, "founder", :vouch_in, ["founder"])

# The invite: an attenuated (vouch/list only), TTL'd capability, handed over
# literally across a fence. Identities generate on-device; no signup, no registry.
{shed, invite} =
  Sim.grant(shed, "founder", "neighbor", ops: [:vouch_in, :list_tool], expires_epoch: 8)

shed = Sim.sync_all(shed)
{shed, _} = Sim.command(shed, "neighbor", :vouch_in, ["neighbor"], cap: invite.id)
shed = Sim.sync_all(shed)
T.say("neighbor joins through founder's leased invite Cap (expires at epoch 8).")

{shed, rogue} = Sim.command(shed, "drifter", :vouch_in, ["drifter"], cap: :none)
shed = Sim.sync_all(shed)
{true, rogue_reason} = Sim.quarantined(shed, "founder", rogue.id)

T.say(
  "drifter tries to vouch himself in with no Cap — QUARANTINED (#{rogue_reason}) on every realm."
)

T.shed(shed, "neighbor")

# --------------------------------------------------------------- Beat 2
T.h("2. A tile saw is listed from a phone, offline — the listing converges")
tool = Sim.new(Tool, tool_replica, ["founder", "neighbor"], seed: "toolshed-demo")
{tool, _} = Sim.create_replica(tool, "founder")
{tool, _} = Sim.grant(tool, "founder", "neighbor", ops: [:describe, :note_condition])
tool = Sim.sync_all(tool)

tool = Sim.partition(tool, "founder", "neighbor")
{tool, _} = Sim.command(tool, "founder", :describe, ["Tile saw, 7in wet blade"])
{tool, _} = Sim.command(tool, "founder", :note_condition, ["new blade fitted in June"])
T.say("founder lists the saw while offline; devices meet later…")
tool = tool |> Sim.heal("founder", "neighbor") |> Sim.sync_all()

{shed, _} = Sim.command(shed, "founder", :list_tool, [tool_replica])
shed = Sim.sync_all(shed)

converged? =
  Sim.state(tool, "founder").description == Sim.state(tool, "neighbor").description

T.say("healed + synced — listing converged on both devices? #{converged?}")
T.shed(shed, "neighbor")

# --------------------------------------------------------------- Beat 3
T.h("3. A borrow: two phones tap at the door — one dual-signed op, due-back on the Cap")
{tool, request} = Sim.request(tool, "neighbor", "custody", {:custody_transfer, []})
tool = Sim.sync_all(tool)
T.say("neighbor's borrow request is a durable :inbox op (the Q-06 surface).")

founder = Sim.identity(tool, "founder")
neighbor = Sim.identity(tool, "neighbor")

# QR/NFC round-trip at the door: the recipient signs consent first, the holder
# embeds it and authors the transfer — inside the hashed content (ADR 0007).
consent = Authority.Consent.sign_custody(neighbor, Sim.replica(tool), request.id, founder.pub)
{tool, transfer} = Sim.command(tool, "founder", :custody_transfer, [neighbor.pub, request.id, consent])

# The borrow Cap: the due-back caveat is a lease (plan 149) — epoch 4.
{tool, _borrow_cap} =
  Sim.grant(tool, "founder", "neighbor", ops: [:note_condition], expires_epoch: 4)

tool = Sim.sync_all(tool)

T.say(
  "dual-signed transfer honored? #{not T.q(Sim.quarantined(tool, "neighbor", transfer.id))} — holder is now #{T.fp(Sim.state(tool, "founder").holder)}"
)

T.loan(ReadModel.observe(Sim.log(tool, "founder")))

# --------------------------------------------------------------- Beat 4
T.h("4. A dispute: \"I returned it.\" The DAG answers")
{tool, _} = Sim.beacon(tool, "founder", 5)
tool = Sim.sync_all(tool)
T.say("the root beacons past the due-back epoch — overdue is computed, not nagged:")
model = ReadModel.observe(Sim.log(tool, "founder"))
T.loan(model)

{tool, return_req} = Sim.request(tool, "neighbor", "custody", {:custody_transfer, [:return]})
tool = Sim.sync_all(tool)
T.say("neighbor requests the return — durable, visible, timestamped until resolved:")
T.requests(ReadModel.observe(Sim.log(tool, "founder")))

# Q-06: the current validated custody holder (the lender) resolves the request.
# The neighbor's signed half of the return is the request op itself, bound in
# via request_op_id — either the dual-signed return exists, or the unresolved
# request does. No ambiguity survives contact with the audit trail.
return_consent =
  Authority.Consent.sign_custody(founder, Sim.replica(tool), return_req.id, founder.pub)

{tool, return_op} =
  Sim.command(tool, "founder", :custody_transfer, [founder.pub, return_req.id, return_consent])

tool = Sim.sync_all(tool)

T.say(
  "founder resolves it with the reverse transfer (honored? #{not T.q(Sim.quarantined(tool, "neighbor", return_op.id))}):"
)

model = ReadModel.observe(Sim.log(tool, "neighbor"))
T.loan(model)
T.requests(model)

# --------------------------------------------------------------- Beat 5
T.h("5. The founder moves away — stewardship transfers by Cap; nothing is lost")
{shed, _} = Sim.command(shed, "founder", :post_bulletin, ["I'm handing the shed to neighbor"])

{shed, _} =
  Sim.transfer(shed, "founder", "neighbor", :steward, at_tick: 1, ops: [:post_bulletin])

shed = Sim.sync_all(shed)
T.say("steward Cap transferred in one op (holder now #{T.fp(Sim.holder(shed, "neighbor", :steward))}).")

{shed, stale} = Sim.command(shed, "founder", :post_bulletin, ["one last notice"])
shed = Sim.sync_all(shed)
{true, stale_reason} = Sim.quarantined(shed, "neighbor", stale.id)
T.say("founder's later steward op is QUARANTINED (#{stale_reason}) — visibly, on every realm.")

path = Path.join(System.tmp_dir!(), "toolshed_demo.log")
log = Sim.log(tool, "neighbor")
:ok = Log.dump(log, path)
{:ok, restored} = Log.restore(path)
File.rm(path)
same_ops = Log.op_ids(restored) == Log.op_ids(log)
same_state = Lattice.state(Tool, restored) == Lattice.state(Tool, log)

T.say(
  "founder's device gone → restore from disk: ops preserved=#{same_ops}, state preserved=#{same_state}"
)

T.say("the inventory, custody history, and every loan continue from the remaining devices.")

IO.puts(
  "\n\e[1m\e[32mToolshed POC demo complete — custody computed from the DAG; the shed works without the town.\e[0m"
)
