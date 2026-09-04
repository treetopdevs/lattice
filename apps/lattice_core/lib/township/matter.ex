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

  There is no `vouch` or ballot field on this Replica. Legacy vouches remain outside
  convergent Matter state. An election is instead linked by an immutable,
  capability-gated `link_election` command and runs on its own bulletin-board
  replica. The link op records the spec digest without selecting a "current"
  election or changing W0-W3 state.

  ## The `succession` line below is decorative

  The module-level `succession(:clerk, ...)` declaration is decorative, exactly as the
  demo Thread's is. The runtime reads only its role name (`Lattice.Authority` and
  `Lattice.Sim` collect `Map.keys(__lattice_succession__())`), and `:clerk` is already
  a role through `clerk_locked?`; the `to:` and `after:` values are never consulted.
  The initial policy is the `%{successor, dormant_ticks}` map carried by each matter's
  genesis op (`Lattice.Sim.create_replica/2` `policies:`), and a later valid genesis
  authored by the replica root may replace it (`Lattice.Authority.collect_policies/3`
  merges every valid root genesis, later wins); holding, succeeding to or being admitted
  to a role confers no power to change it, only the root key does.
  Plan 179 step 1c takes this relabel branch; moving the clerk policy to a witnessed
  shape at genesis is deferred to a later Township plan.

  `after: {:dormant_ticks, n}` means a designated successor may claim the role once it
  asserts a sufficiently large tick, not a time-based control. The tick is
  author-asserted and untrusted (ADR 0004), and the dormancy check reads `last_active`
  only from the succeed op's own causal ancestry. Two consequences follow. First, the
  designated successor can take the role at any time, whatever the holder did, by
  authoring a succeed op whose deps omit the holder's activity (a partitioned replica
  does this naturally); it lands with byte-identical state on every replica. Second, a
  holder can pin `last_active` at `2^64-1` (`Lattice.Canonical.max_integer/0`) with a
  transfer or self-transfer whose `at_tick` is that ceiling; every encodable succession
  tick whose ancestry carries that pin while the fold honors it then quarantines
  `:premature_succession` (a pin the fold has itself quarantined, for example as
  `:double_transfer` behind a forked succeed, is invisible to the gate), and `2^64`
  cannot be authored at all because `Lattice.Canonical` refuses integers above the
  ceiling. That lockout is reachable and, for every succeed op built on a history in
  which the pin is honored, unrecoverable through the legacy path for the life of the
  replica; its exits are the successor's fork above, a voluntary transfer by the pinning
  holder, or a new replica. See `docs/research/succession_tick_provenance.md` sections
  6.2 and 6.2a for the reproductions.
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

  command(:link_election, [:spec_digest],
    do:
      case spec_digest do
        _ -> []
      end
  )

  # Clerk-only, authority-guarded.
  command(:close_matter, [], do: [{:clerk_locked?, {:write, true}}])
  command(:reopen_matter, [], do: [{:clerk_locked?, {:write, false}}])

  # Live-only: a transient "someone is drafting" ping that must never be logged.
  ephemeral(:drafting, [:who], do: {:drafting, who})

  succession(:clerk, to: "realm:successor", after: {:dormant_ticks, 3})
end
