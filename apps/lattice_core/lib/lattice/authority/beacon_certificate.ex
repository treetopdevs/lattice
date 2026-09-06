defmodule Lattice.Authority.BeaconCertificate do
  @moduledoc """
  Witness authorization for one exact logical epoch, author, and causal frontier.

  These signatures authorize bounded logical progress, not elapsed physical time.
  """

  alias Lattice.{Canonical, Identity}

  @claim_domain "lattice-beacon-witness-v1"
  @policy_domain "lattice-beacon-policy-v1"

  @type claim :: %{
          version: 1,
          replica: String.t(),
          epoch: non_neg_integer(),
          author: Identity.pubkey(),
          deps: [String.t()]
        }
  @type certificate :: %{claim: claim(), signatures: [map()]}

  @spec normalize_policy(term()) :: {:ok, map()} | {:error, :invalid_beacon_policy}
  def normalize_policy(
        %{
          mode: :witnessed,
          version: 1,
          witnesses: witnesses,
          threshold: threshold,
          max_epoch_step: step
        } = policy
      )
      when map_size(policy) == 5 and is_list(witnesses) and is_integer(threshold) and
             is_integer(step) do
    if Enum.all?(witnesses, &(is_binary(&1) and byte_size(&1) == 32)) and
         Enum.uniq(witnesses) == witnesses and threshold >= 1 and threshold <= length(witnesses) and
         step >= 1 and step <= 65_535,
       do: {:ok, %{policy | witnesses: Enum.sort(witnesses)}},
       else: {:error, :invalid_beacon_policy}
  end

  def normalize_policy(_), do: {:error, :invalid_beacon_policy}

  @spec policy_id(term()) :: {:ok, String.t()} | {:error, :invalid_beacon_policy}
  def policy_id(policy) do
    with {:ok, normalized} <- normalize_policy(policy) do
      {:ok,
       [@policy_domain, normalized]
       |> Canonical.term()
       |> then(&:crypto.hash(:sha256, &1))
       |> Base.url_encode64(padding: false)}
    end
  end

  @spec claim(String.t(), non_neg_integer(), Identity.pubkey(), [String.t()]) :: claim()
  def claim(replica, epoch, author, deps),
    do: %{version: 1, replica: replica, epoch: epoch, author: author, deps: Enum.sort(deps)}

  @spec new(claim(), [Identity.t()]) :: certificate()
  def new(claim, witnesses) do
    payload = signing_payload(claim)

    signatures =
      witnesses
      |> Enum.map(fn witness ->
        %{witness: witness.pub, signature: Identity.sign(witness, payload)}
      end)
      |> Enum.sort_by(& &1.witness)

    %{claim: claim, signatures: signatures}
  end

  @spec signing_payload(claim()) :: binary()
  def signing_payload(claim), do: Canonical.term([@claim_domain, claim])

  @spec verify(term(), claim(), term()) :: :ok | {:error, :unauthorized_beacon}
  def verify(certificate, expected_claim, policy) do
    with {:ok, normalized} <- normalize_policy(policy),
         %{claim: claim, signatures: signatures} when map_size(certificate) == 2 <- certificate,
         true <- valid_claim_shape?(claim),
         true <- claim == expected_claim,
         true <- is_list(signatures) and Enum.all?(signatures, &valid_signature_shape?/1),
         witnesses = Enum.map(signatures, & &1.witness),
         true <- witnesses == Enum.sort(Enum.uniq(witnesses)),
         true <- Enum.all?(witnesses, &(&1 in normalized.witnesses)),
         true <- length(signatures) >= normalized.threshold,
         payload = signing_payload(claim),
         true <- Enum.all?(signatures, &Identity.verify(&1.witness, payload, &1.signature)) do
      :ok
    else
      _ -> {:error, :unauthorized_beacon}
    end
  end

  defp valid_claim_shape?(
         %{version: 1, replica: replica, epoch: epoch, author: author, deps: deps} = claim
       ),
       do:
         map_size(claim) == 5 and is_binary(replica) and is_integer(epoch) and epoch >= 0 and
           is_binary(author) and byte_size(author) == 32 and is_list(deps) and
           Enum.all?(deps, &is_binary/1)

  defp valid_claim_shape?(_), do: false

  defp valid_signature_shape?(%{witness: witness, signature: signature} = entry),
    do:
      map_size(entry) == 2 and is_binary(witness) and byte_size(witness) == 32 and
        is_binary(signature) and byte_size(signature) == 64

  defp valid_signature_shape?(_), do: false
end
