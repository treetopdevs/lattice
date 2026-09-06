defmodule Lattice.Authority.ContinuationCertificate do
  @moduledoc """
  Closed, domain-separated bounded continuation profiles and witness claims.

  Signature verification binds consent to an independently derived claim. It
  cannot establish that a presented holder acquisition was honored or current;
  `Lattice.Authority` derives those facts from the verified causal history.
  """

  alias Lattice.{Canonical, Identity}

  @horizon 9_007_199_254_740_991
  @profile_domain "lattice-continuation-profile-v1"
  @claim_domain "lattice-continuation-witness-v1"
  @claim_ids [:profile_id, :profile_genesis, :holder_epoch, :delegation_id]

  @type profile :: map()
  @type claim :: map()
  @type certificate :: %{claim: claim(), signatures: [map()]}

  @spec normalize_policy(term()) :: {:ok, profile()} | {:error, :invalid_continuation_profile}
  def normalize_policy(%{mode: :bounded_continuation, version: 1, product: :treehouse} = p)
      when map_size(p) == 9 do
    valid =
      valid_kind_role?(p[:kind], p[:role]) and pubkey?(p[:nominee]) and
        is_list(p[:witnesses]) and Enum.all?(p.witnesses, &pubkey?/1) and
        Enum.uniq(p.witnesses) == p.witnesses and is_integer(p[:threshold]) and
        p.threshold >= 1 and p.threshold <= length(p.witnesses) and
        is_integer(p[:max_lease_epochs]) and p.max_lease_epochs in 1..65_535

    if valid,
      do: {:ok, %{p | witnesses: Enum.sort(p.witnesses)}},
      else: {:error, :invalid_continuation_profile}
  end

  def normalize_policy(_), do: {:error, :invalid_continuation_profile}

  @spec profile_id(term()) :: {:ok, String.t()} | {:error, :invalid_continuation_profile}
  def profile_id(profile) do
    with {:ok, p} <- normalize_policy(profile) do
      {:ok, Canonical.term([@profile_domain, p]) |> hash()}
    end
  end

  @spec signing_payload(claim()) :: binary()
  def signing_payload(claim), do: Canonical.term([@claim_domain, claim])

  @spec new(claim(), [Identity.t()]) :: certificate()
  def new(claim, witnesses) do
    payload = signing_payload(claim)

    signatures =
      witnesses
      |> Enum.map(&%{witness: &1.pub, signature: Identity.sign(&1, payload)})
      |> Enum.sort_by(& &1.witness)

    %{claim: claim, signatures: signatures}
  end

  @spec valid_shape?(term()) :: boolean()
  def valid_shape?(%{claim: claim, signatures: signatures} = cert)
      when map_size(cert) == 2 and is_list(signatures) do
    valid_claim?(claim) and Enum.all?(signatures, &signature_shape?/1)
  end

  def valid_shape?(_), do: false

  @spec valid_claim?(term()) :: boolean()
  def valid_claim?(%{version: 1, product: :treehouse} = c) when map_size(c) == 15 do
    valid_kind_role?(c[:kind], c[:role]) and is_binary(c[:replica]) and
      pubkey?(c[:holder]) and pubkey?(c[:successor]) and pubkey?(c[:author]) and
      Enum.all?(@claim_ids, &id?(c[&1])) and canonical_ids?(c[:deps]) and
      canonical_ids?(c[:epoch_basis]) and epoch?(c[:epoch])
  end

  def valid_claim?(_), do: false

  @spec verify(term(), claim(), term()) :: :ok | {:error, atom()}
  def verify(certificate, expected, profile) do
    with true <- valid_shape?(certificate),
         true <- valid_claim?(expected),
         {:ok, p} <- normalize_policy(profile),
         {:ok, id} <- profile_id(p),
         true <- certificate.claim == expected,
         true <- expected.profile_id == id,
         true <- {expected.product, expected.kind, expected.role} == {p.product, p.kind, p.role},
         true <- signatures_valid?(certificate.signatures, certificate.claim, p) do
      :ok
    else
      _ -> {:error, :invalid_continuation_certificate}
    end
  end

  @spec epoch?(term()) :: boolean()
  def epoch?(n), do: is_integer(n) and n >= 0 and n <= @horizon

  @spec id?(term()) :: boolean()
  def id?(id) when is_binary(id) and byte_size(id) == 43 do
    case Base.url_decode64(id, padding: false) do
      {:ok, bytes} -> byte_size(bytes) == 32 and Base.url_encode64(bytes, padding: false) == id
      :error -> false
    end
  end

  def id?(_), do: false

  defp canonical_ids?(ids) when is_list(ids),
    do: Enum.all?(ids, &id?/1) and ids == Enum.sort(Enum.uniq(ids))

  defp canonical_ids?(_), do: false
  defp pubkey?(key), do: is_binary(key) and byte_size(key) == 32
  defp valid_kind_role?(:space, :admin), do: true
  defp valid_kind_role?(:thread, :moderator), do: true
  defp valid_kind_role?(_, _), do: false

  defp signature_shape?(%{witness: witness, signature: signature} = s),
    do:
      map_size(s) == 2 and pubkey?(witness) and is_binary(signature) and
        byte_size(signature) == 64

  defp signature_shape?(_), do: false

  defp signatures_valid?(signatures, claim, p) do
    witnesses = Enum.map(signatures, & &1.witness)
    payload = signing_payload(claim)

    length(witnesses) >= p.threshold and witnesses == Enum.sort(Enum.uniq(witnesses)) and
      Enum.all?(witnesses, &(&1 in p.witnesses)) and
      Enum.all?(signatures, &Identity.verify(&1.witness, payload, &1.signature))
  end

  defp hash(bytes), do: :crypto.hash(:sha256, bytes) |> Base.url_encode64(padding: false)
end
