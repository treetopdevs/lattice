defmodule Lattice.Authority.Consent do
  @moduledoc """
  Co-signed consent for custody-transfer commands (ADR 0007).

  Consent is a second party's Ed25519 signature over a domain-tagged
  `Lattice.Canonical` payload, carried *inside* the command body — inside the
  hashed content, so the op cannot exist without it and `Lattice.Log.accept/3`
  needs no change. The recipient signs first (QR/NFC round-trip at the physical
  handoff — app layer); the current holder embeds the signature, builds the op,
  and appends. The `request_op_id` is the nonce: it binds each consent to one
  durable `:inbox` request, so a signature lifted from one integrated transfer
  can never authorize a second (V-09).

  Consent is not authority: the signature confers nothing, and the op's author
  must independently clear the existing `cap_ok` + `authority_ok` gates as the
  validated holder. This module is consulted only from
  `Lattice.Authority.validate_command/7` via the replica's `command_op_status/2`
  callback (V-05).
  """

  alias Lattice.{Canonical, Identity, Op}

  # Versioned like the op tag; any schema change bumps the tag, never the shape.
  @domain_tag "lattice-custody-consent-v1"

  @type failure :: :missing_consent | :invalid_consent

  @doc "The domain-tagged canonical bytes the recipient signs."
  @spec custody_payload(String.t(), Op.id(), Identity.pubkey(), Identity.pubkey()) :: binary()
  def custody_payload(replica, request_op_id, from_pub, to_pub) do
    Canonical.term([@domain_tag, replica, request_op_id, from_pub, to_pub])
  end

  @doc "Recipient-side ceremony step: sign consent to receive custody from `from_pub`."
  @spec sign_custody(Identity.t(), String.t(), Op.id(), Identity.pubkey()) :: binary()
  def sign_custody(%Identity{} = recipient, replica, request_op_id, from_pub) do
    Identity.sign(recipient, custody_payload(replica, request_op_id, from_pub, recipient.pub))
  end

  @doc """
  The consent validity conjunct for a `:custody_transfer` command op.

  Honors iff the consent signature verifies for the declared recipient over the
  recomputed payload (whose `from` is `op.author` by construction) AND the cited
  request op is in the op's causal past (`visible`). The check order is pinned —
  missing, then causal presence, then signature — so every realm reports the
  same reason (property d).
  """
  @spec validate_custody_transfer(Op.t(), Identity.pubkey(), Op.id(), term(), MapSet.t(Op.id())) ::
          :ok | {:error, failure()}
  def validate_custody_transfer(%Op{} = op, to_pub, request_op_id, consent_sig, visible) do
    cond do
      not is_binary(consent_sig) or consent_sig == "" ->
        {:error, :missing_consent}

      not MapSet.member?(visible, request_op_id) ->
        {:error, :invalid_consent}

      not Identity.verify(
        to_pub,
        custody_payload(op.replica, request_op_id, op.author, to_pub),
        consent_sig
      ) ->
        {:error, :invalid_consent}

      true ->
        :ok
    end
  end
end
