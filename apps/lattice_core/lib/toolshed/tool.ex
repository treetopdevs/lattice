defmodule Toolshed.Tool do
  @moduledoc """
  One lendable tool — the Toolshed Replica (PD-003) and ADR 0007's first consumer.

  Each tool is its own Replica. Convergent fields describe it; *who holds it* is
  the `:custody`-gated `holder` field, and the only command that writes it is
  `:custody_transfer` — a dual-signed handoff. The transfer op embeds the
  recipient's consent signature in its body (inside the hashed content), and the
  `command_op_status/2` callback below is the ADR 0007 consent conjunct: without
  a verifying consent bound to a causally visible custody request, the transfer
  quarantines (`:missing_consent` / `:invalid_consent`) on every realm.

  Custody is computed from op presence in the DAG — never asserted. A borrow or
  return *request* is the ordinary durable `:inbox` op (the Q-06 surface), so an
  unresolved or refused request stays visible and timestamped with no new code.
  """

  use Lattice.Replica

  alias Lattice.Authority.Consent

  state do
    field(:description, merge: :lww, default: "")
    field(:condition_notes, merge: :causal_list)
    field(:holder, authority: :custody)
  end

  # Convergent commands — pure reducers, absolute mutations only.
  command(:describe, [:text], do: [{:description, {:write, text}}])
  command(:note_condition, [:text], do: [{:condition_notes, {:append, text}}])

  # The dual-signed handoff (ADR 0007). `request_op_id` and `consent_sig` do not
  # mutate state — they are validity evidence, judged in `command_op_status/2`.
  command(:custody_transfer, [:to_pub, :request_op_id, :consent_sig],
    do:
      case {request_op_id, consent_sig} do
        _ -> [{:holder, {:write, to_pub}}]
      end
  )

  # ADR 0007 — the op-aware validity conjunct. Consulted by
  # `Lattice.Authority.validate_command/7` after `cap_ok` + `authority_ok`.
  def command_op_status(
        %Lattice.Op{body: {:custody_transfer, [to_pub, request_op_id, consent_sig]}} = op,
        visible
      ) do
    Consent.validate_custody_transfer(op, to_pub, request_op_id, consent_sig, visible)
  end

  def command_op_status(_op, _visible), do: :ok
end
