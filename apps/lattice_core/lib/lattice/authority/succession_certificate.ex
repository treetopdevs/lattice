defmodule Lattice.Authority.SuccessionCertificate do
  @moduledoc """
  Domain-separated, genesis-policy-bound witness authorization for succession.

  A certificate proves only that the configured threshold signed one exact recovery
  claim. It does not prove elapsed time or holder absence.
  """

  alias Lattice.{Canonical, Identity}

  @version 1
  @claim_domain "lattice-succession-witness-v1"
  @policy_domain "lattice-recovery-policy-v1"

  @type recovery_policy :: %{
          mode: :witnessed,
          version: pos_integer(),
          witnesses: [Identity.pubkey()],
          threshold: pos_integer()
        }
  @type claim :: %{
          version: pos_integer(),
          replica: String.t(),
          role: atom(),
          holder: Identity.pubkey(),
          holder_epoch: String.t(),
          successor: Identity.pubkey(),
          policy_id: String.t()
        }
  @type certificate :: %{
          claim: claim(),
          signatures: [%{witness: Identity.pubkey(), signature: binary()}]
        }

  @spec normalize_policy(term()) :: {:ok, recovery_policy()} | {:error, :invalid_recovery_policy}
  def normalize_policy(
        %{mode: :witnessed, version: @version, witnesses: witnesses, threshold: threshold} =
          policy
      )
      when map_size(policy) == 4 and is_list(witnesses) and is_integer(threshold) do
    cond do
      not Enum.all?(witnesses, &(is_binary(&1) and byte_size(&1) == 32)) ->
        {:error, :invalid_recovery_policy}

      Enum.uniq(witnesses) != witnesses ->
        {:error, :invalid_recovery_policy}

      threshold < 1 or threshold > length(witnesses) ->
        {:error, :invalid_recovery_policy}

      true ->
        {:ok, %{policy | witnesses: Enum.sort(witnesses)}}
    end
  end

  def normalize_policy(_policy), do: {:error, :invalid_recovery_policy}

  @spec policy_id(term()) :: {:ok, String.t()} | {:error, :invalid_recovery_policy}
  def policy_id(policy) do
    with {:ok, normalized} <- normalize_policy(policy) do
      id =
        [@policy_domain, normalized]
        |> Canonical.term()
        |> then(&:crypto.hash(:sha256, &1))
        |> Base.url_encode64(padding: false)

      {:ok, id}
    end
  end

  @spec claim(
          String.t(),
          atom(),
          Identity.pubkey(),
          String.t(),
          Identity.pubkey(),
          term()
        ) :: {:ok, claim()} | {:error, :invalid_recovery_policy}
  def claim(replica, role, holder, holder_epoch, successor, policy)
      when is_binary(replica) and is_atom(role) and is_binary(holder) and
             is_binary(holder_epoch) and is_binary(successor) do
    with {:ok, policy_id} <- policy_id(policy) do
      {:ok,
       %{
         version: @version,
         replica: replica,
         role: role,
         holder: holder,
         holder_epoch: holder_epoch,
         successor: successor,
         policy_id: policy_id
       }}
    end
  end

  @spec new(claim(), [Identity.t()]) :: certificate()
  def new(claim, witnesses) when is_list(witnesses) do
    payload = signing_payload(claim)

    signatures =
      witnesses
      |> Enum.map(fn %Identity{pub: pub} = witness ->
        %{witness: pub, signature: Identity.sign(witness, payload)}
      end)
      |> Enum.sort_by(& &1.witness)

    %{claim: claim, signatures: signatures}
  end

  @spec signing_payload(claim()) :: binary()
  def signing_payload(claim), do: Canonical.term([@claim_domain, claim])

  @spec verify(term(), claim(), term()) :: :ok | {:error, atom()}
  def verify(certificate, expected_claim, policy) do
    with {:ok, normalized} <- normalize_policy(policy),
         {:ok, claim, signatures} <- certificate_parts(certificate),
         :ok <- supported_version(claim),
         :ok <- claim_binding_matches(claim, expected_claim),
         :ok <- policy_binding_matches(claim, expected_claim),
         :ok <- known_witnesses(signatures, normalized.witnesses),
         :ok <- distinct_witnesses(signatures),
         :ok <- canonical_witness_order(signatures),
         :ok <- valid_signatures(signatures, claim),
         :ok <- threshold_met(signatures, normalized.threshold) do
      :ok
    end
  end

  defp certificate_parts(%{claim: claim, signatures: signatures} = certificate)
       when map_size(certificate) == 2 and is_map(claim) and is_list(signatures) do
    if valid_claim_shape?(claim) and Enum.all?(signatures, &valid_signature_shape?/1),
      do: {:ok, claim, signatures},
      else: {:error, :malformed_recovery_certificate}
  end

  defp certificate_parts(_certificate), do: {:error, :malformed_recovery_certificate}

  defp valid_claim_shape?(claim) do
    map_size(claim) == 7 and is_integer(claim[:version]) and claim[:version] >= 0 and
      is_binary(claim[:replica]) and is_atom(claim[:role]) and
      is_binary(claim[:holder]) and byte_size(claim[:holder]) == 32 and
      is_binary(claim[:holder_epoch]) and is_binary(claim[:successor]) and
      byte_size(claim[:successor]) == 32 and is_binary(claim[:policy_id])
  end

  defp valid_signature_shape?(%{witness: witness, signature: signature} = entry),
    do:
      map_size(entry) == 2 and is_binary(witness) and byte_size(witness) == 32 and
        is_binary(signature)

  defp valid_signature_shape?(_entry), do: false

  defp supported_version(%{version: @version}), do: :ok
  defp supported_version(_claim), do: {:error, :unsupported_recovery_version}

  defp claim_binding_matches(claim, expected) do
    keys = [:version, :replica, :role, :holder, :holder_epoch, :successor]

    if Map.take(claim, keys) == Map.take(expected, keys),
      do: :ok,
      else: {:error, :recovery_claim_mismatch}
  end

  defp policy_binding_matches(%{policy_id: id}, %{policy_id: id}), do: :ok
  defp policy_binding_matches(_claim, _expected), do: {:error, :recovery_policy_mismatch}

  defp known_witnesses(signatures, witnesses) do
    allowed = MapSet.new(witnesses)

    if Enum.all?(signatures, &MapSet.member?(allowed, &1.witness)),
      do: :ok,
      else: {:error, :unknown_recovery_witness}
  end

  defp distinct_witnesses(signatures) do
    witnesses = Enum.map(signatures, & &1.witness)

    if Enum.uniq(witnesses) == witnesses,
      do: :ok,
      else: {:error, :duplicate_recovery_witness}
  end

  defp canonical_witness_order(signatures) do
    witnesses = Enum.map(signatures, & &1.witness)

    if witnesses == Enum.sort(witnesses),
      do: :ok,
      else: {:error, :noncanonical_recovery_signatures}
  end

  defp valid_signatures(signatures, claim) do
    payload = signing_payload(claim)

    if Enum.all?(signatures, &Identity.verify(&1.witness, payload, &1.signature)),
      do: :ok,
      else: {:error, :invalid_recovery_signature}
  end

  defp threshold_met(signatures, threshold) do
    if length(signatures) >= threshold,
      do: :ok,
      else: {:error, :insufficient_recovery_witnesses}
  end
end
