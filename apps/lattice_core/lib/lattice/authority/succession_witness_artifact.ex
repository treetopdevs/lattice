defmodule Lattice.Authority.SuccessionWitnessArtifact do
  @moduledoc """
  Strict public-wrapper decoding for one witnessed succession signature.

  The wrapper is public evidence, not a recovery certificate. Verification converts
  it to the existing one-signature certificate shape and preserves the configured
  threshold.
  """

  alias Lattice.Authority.SuccessionCertificate
  alias Lattice.Canonical

  @version 1
  @domain "lattice-succession-witness-artifact-v1"
  @wrapper_keys ~w(artifactId claim signature v witness)
  @claim_keys ~w(holder holderEpoch policyId replica role successor version)

  @type normalized :: %{
          v: 1,
          artifact_id: String.t(),
          claim: SuccessionCertificate.claim(),
          witness: binary(),
          signature: binary(),
          certificate: SuccessionCertificate.certificate()
        }

  @spec verify_json(binary(), SuccessionCertificate.claim(), term()) ::
          :ok | {:error, atom()}
  def verify_json(json, expected_claim, policy) when is_binary(json) do
    with {:ok, decoded} <- Jason.decode(json),
         {:ok, normalized} <- normalize(decoded) do
      SuccessionCertificate.verify(normalized.certificate, expected_claim, policy)
    else
      {:error, :witness_artifact_id_mismatch} = error -> error
      _error -> {:error, :malformed_witness_artifact}
    end
  end

  def verify_json(_json, _expected_claim, _policy), do: {:error, :malformed_witness_artifact}

  @spec normalize(term()) ::
          {:ok, normalized()}
          | {:error, :malformed_witness_artifact | :witness_artifact_id_mismatch}
  def normalize(
        %{
          "v" => @version,
          "artifactId" => artifact_id,
          "claim" => claim_json,
          "witness" => witness_json,
          "signature" => signature_json
        } = wrapper
      ) do
    with true <- exact_keys?(wrapper, @wrapper_keys),
         {:ok, claim} <- normalize_claim(claim_json),
         {:ok, witness} <- canonical_base64(witness_json, 32),
         {:ok, signature} <- canonical_base64(signature_json, 64),
         {:ok, _artifact_digest} <- canonical_base64url(artifact_id, 32),
         :ok <- artifact_id_matches(artifact_id, claim, witness) do
      certificate = %{claim: claim, signatures: [%{witness: witness, signature: signature}]}

      {:ok,
       %{
         v: @version,
         artifact_id: artifact_id,
         claim: claim,
         witness: witness,
         signature: signature,
         certificate: certificate
       }}
    else
      {:error, :witness_artifact_id_mismatch} = error -> error
      _error -> {:error, :malformed_witness_artifact}
    end
  end

  def normalize(_wrapper), do: {:error, :malformed_witness_artifact}

  defp normalize_claim(
         %{
           "version" => @version,
           "replica" => replica,
           "role" => role,
           "holder" => holder_json,
           "holderEpoch" => holder_epoch,
           "successor" => successor_json,
           "policyId" => policy_id
         } = claim
       )
       when is_binary(replica) and byte_size(replica) > 0 do
    with true <- exact_keys?(claim, @claim_keys),
         {:ok, normalized_role} <- existing_role(role),
         {:ok, holder} <- canonical_base64(holder_json, 32),
         {:ok, _holder_epoch_digest} <- canonical_base64url(holder_epoch, 32),
         {:ok, successor} <- canonical_base64(successor_json, 32),
         {:ok, _policy_digest} <- canonical_base64url(policy_id, 32) do
      {:ok,
       %{
         version: @version,
         replica: replica,
         role: normalized_role,
         holder: holder,
         holder_epoch: holder_epoch,
         successor: successor,
         policy_id: policy_id
       }}
    else
      _error -> {:error, :malformed_witness_artifact}
    end
  end

  defp normalize_claim(_claim), do: {:error, :malformed_witness_artifact}

  defp artifact_id_matches(artifact_id, claim, witness) do
    expected =
      [@domain, SuccessionCertificate.signing_payload(claim), witness]
      |> Canonical.term()
      |> then(&:crypto.hash(:sha256, &1))
      |> Base.url_encode64(padding: false)

    if artifact_id == expected,
      do: :ok,
      else: {:error, :witness_artifact_id_mismatch}
  end

  defp canonical_base64(value, byte_count) when is_binary(value) do
    with {:ok, decoded} <- Base.decode64(value),
         true <- byte_size(decoded) == byte_count,
         true <- Base.encode64(decoded) == value do
      {:ok, decoded}
    else
      _error -> {:error, :malformed_witness_artifact}
    end
  end

  defp canonical_base64(_value, _byte_count), do: {:error, :malformed_witness_artifact}

  defp canonical_base64url(value, byte_count) when is_binary(value) do
    with {:ok, decoded} <- Base.url_decode64(value, padding: false),
         true <- byte_size(decoded) == byte_count,
         true <- Base.url_encode64(decoded, padding: false) == value do
      {:ok, decoded}
    else
      _error -> {:error, :malformed_witness_artifact}
    end
  end

  defp canonical_base64url(_value, _byte_count), do: {:error, :malformed_witness_artifact}

  defp existing_role(role) when is_binary(role) do
    {:ok, String.to_existing_atom(role)}
  rescue
    ArgumentError -> {:error, :malformed_witness_artifact}
  end

  defp existing_role(_role), do: {:error, :malformed_witness_artifact}

  defp exact_keys?(map, expected), do: map |> Map.keys() |> Enum.sort() == expected
end
