defmodule Township.Matter do
  @moduledoc """
  A single local matter under deliberation — the Township civic Replica.

  This is `Lattice.Demo.Thread` promoted to a civic shape. It is deliberately
  built only from primitives that exist on the 2.0 core today (LWW / CausalList /
  OrSet CRDTs and one `authority:` field), so W0–W3 run on the *real* substrate
  with nothing simulated except the network (which `Lattice.Sim` already models
  and which M2 replaces with a real carrier).

  ## Fields

    * `title`      — `Lww` register, the matter's headline
    * `summary`    — `Lww` register, the contested field edited during a partition (W1)
    * `posts`      — `CausalList`, append-only deliberation in causal order
    * `members`    — `OrSet`, the vouch-admitted member set (W0)
    * `clerk_locked?` — `authority: :clerk`, a serialized civic control (W2/W3):
      only the current `:clerk` holder may set it. Stands in for any clerk-only
      act (pinning an agenda, closing a matter) whose authority must transfer by
      Cap and whose stale post-transfer op must quarantine.

  ## What is NOT here — on purpose

  There is no `vouch` *field* on this Replica. Vouches are attestation ops handled
  through `Lattice.Attestation` (the seam for M4), not convergent Replica state.
  Keeping them off the Replica is what lets the receipt-free primitive drop in at
  M4 without a schema change here. See `Lattice.Attestation`.

  A real deployment resolves the `:clerk` successor per-matter at grant time; the
  module-level `succession` default below only documents intent, exactly as the
  demo Thread does.
  """

  use Lattice.Replica

  state do
    field(:title, merge: :lww, default: "")
    field(:summary, merge: :lww, default: "")
    field(:posts, merge: :causal_list)
    field(:members, merge: :or_set)
    field(:clerk_locked?, authority: :clerk, default: false)
  end

  # Convergent commands — pure reducers, absolute mutations only.
  command(:set_title, [:text], do: [{:title, {:write, text}}])
  command(:set_summary, [:text], do: [{:summary, {:write, text}}])
  command(:post, [:text], do: [{:posts, {:append, text}}])
  command(:admit, [:member], do: [{:members, {:add, member}}])
  command(:remove_member, [:member], do: [{:members, {:remove, member}}])

  # Clerk-only, authority-guarded.
  command(:close_matter, [], do: [{:clerk_locked?, {:write, true}}])
  command(:reopen_matter, [], do: [{:clerk_locked?, {:write, false}}])

  # Live-only: a transient "someone is drafting" ping that must never be logged.
  ephemeral(:drafting, [:who], do: {:drafting, who})

  succession(:clerk, to: "realm:successor", after: {:dormant_ticks, 3})
end
