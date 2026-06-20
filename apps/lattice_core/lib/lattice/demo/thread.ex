defmodule Lattice.Demo.Thread do
  @moduledoc """
  The demo Replica: a collaborative discussion thread.

    * `title`        — `Lww` register
    * `messages`     — `CausalList` (append-only, causal order)
    * `participants` — `OrSet` (join/leave)
    * `locked?`      — `authority: :moderator` (only the moderator holder may set it)

  A `succession` policy hands the `:moderator` role to the tab realm if the current
  holder stays dormant past the threshold (behavior 15). The successor realm id is
  resolved at grant time by the runtime, so this module-level default is overridden
  per-thread; it documents intent.
  """

  use Lattice.Replica

  state do
    field(:title, merge: :lww, default: "")
    field(:messages, merge: :causal_list)
    field(:participants, merge: :or_set)
    field(:locked?, authority: :moderator, default: false)
  end

  command(:set_title, [:text], do: [{:title, {:write, text}}])
  command(:post, [:text], do: [{:messages, {:append, text}}])
  command(:delete_message, [:message_id], do: [{:messages, {:delete, message_id}}])
  command(:join, [:realm], do: [{:participants, {:add, realm}}])
  command(:leave, [:realm], do: [{:participants, {:remove, realm}}])
  command(:lock, [], do: [{:locked?, {:write, true}}])
  command(:unlock, [], do: [{:locked?, {:write, false}}])

  # Live-only: a transient "typing" ping that must never enter the log.
  ephemeral(:typing, [:who], do: {:typing, who})

  succession(:moderator, to: "realm:tab", after: {:dormant_ticks, 3})
end
