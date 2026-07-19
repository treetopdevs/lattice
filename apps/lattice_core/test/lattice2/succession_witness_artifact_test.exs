defmodule Lattice2.SuccessionWitnessArtifactTest do
  use ExUnit.Case, async: true

  alias Lattice.Authority.{SuccessionCertificate, SuccessionWitnessArtifact}
  alias Lattice.{Canonical, Identity}

  @artifact_json ~s({"v":1,"artifactId":"bwOAXkuFI7Vfez1nEtZ0FJmr1GBrowaZuryrVUCRt7k","claim":{"version":1,"replica":"replica:matter:succession-witness-artifact","role":"clerk","holder":"mCaZpMJ0SU2lf3v2ljw0D05Px4pmoY1jUIIVv19hmZ4=","holderEpoch":"SJMi-K8IUPUvtk3zYRUVMeska-KcUvNT_8oPWTlKDAI","successor":"DBY121cVb1O+BdK+NucwFZyZtUTdrPpxhnZ2Wg41jjY=","policyId":"7vxBnpmtE9EdrlqMZWah5D7rTHs47sGHwTy-Kytnzj8"},"witness":"6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=","signature":"/T0CLPi87WYjXxaE8A8/vD6N+oJS/ojb6stGalPA3frPZTJhg8gTuB7prrK+UXjotDjlg9hlNVkhqjkF9mV2Bw=="})

  @reordered_json ~s({"signature":"/T0CLPi87WYjXxaE8A8/vD6N+oJS/ojb6stGalPA3frPZTJhg8gTuB7prrK+UXjotDjlg9hlNVkhqjkF9mV2Bw==","witness":"6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=","claim":{"policyId":"7vxBnpmtE9EdrlqMZWah5D7rTHs47sGHwTy-Kytnzj8","successor":"DBY121cVb1O+BdK+NucwFZyZtUTdrPpxhnZ2Wg41jjY=","holderEpoch":"SJMi-K8IUPUvtk3zYRUVMeska-KcUvNT_8oPWTlKDAI","holder":"mCaZpMJ0SU2lf3v2ljw0D05Px4pmoY1jUIIVv19hmZ4=","role":"clerk","replica":"replica:matter:succession-witness-artifact","version":1},"artifactId":"bwOAXkuFI7Vfez1nEtZ0FJmr1GBrowaZuryrVUCRt7k","v":1})

  @app_witness Base.decode64!("6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=")
  @control_witness Base.decode64!("/RckOFqgx1tk+3jNYC+h2ZH96/drE8WO1wLqyDXp9hg=")
  @holder Base.decode64!("mCaZpMJ0SU2lf3v2ljw0D05Px4pmoY1jUIIVv19hmZ4=")
  @successor Base.decode64!("DBY121cVb1O+BdK+NucwFZyZtUTdrPpxhnZ2Wg41jjY=")
  @signature Base.decode64!(
               "/T0CLPi87WYjXxaE8A8/vD6N+oJS/ojb6stGalPA3frPZTJhg8gTuB7prrK+UXjotDjlg9hlNVkhqjkF9mV2Bw=="
             )

  @claim %{
    version: 1,
    replica: "replica:matter:succession-witness-artifact",
    role: :clerk,
    holder: @holder,
    holder_epoch: "SJMi-K8IUPUvtk3zYRUVMeska-KcUvNT_8oPWTlKDAI",
    successor: @successor,
    policy_id: "7vxBnpmtE9EdrlqMZWah5D7rTHs47sGHwTy-Kytnzj8"
  }
  @policy %{
    mode: :witnessed,
    version: 1,
    witnesses: [@app_witness, @control_witness],
    threshold: 2
  }

  test "literal TypeScript export normalizes to the BEAM certificate and remains subthreshold" do
    expected_policy_id = @claim.policy_id
    assert {:ok, ^expected_policy_id} = SuccessionCertificate.policy_id(@policy)

    assert {:ok, normalized} =
             @artifact_json |> Jason.decode!() |> SuccessionWitnessArtifact.normalize()

    assert normalized == %{
             v: 1,
             artifact_id: "bwOAXkuFI7Vfez1nEtZ0FJmr1GBrowaZuryrVUCRt7k",
             claim: @claim,
             witness: @app_witness,
             signature: @signature,
             certificate: %{
               claim: @claim,
               signatures: [%{witness: @app_witness, signature: @signature}]
             }
           }

    assert {:error, :insufficient_recovery_witnesses} =
             SuccessionWitnessArtifact.verify_json(@artifact_json, @claim, @policy)
  end

  test "JSON object key order is not semantic" do
    assert SuccessionWitnessArtifact.normalize(Jason.decode!(@reordered_json)) ==
             SuccessionWitnessArtifact.normalize(Jason.decode!(@artifact_json))

    assert {:error, :insufficient_recovery_witnesses} =
             SuccessionWitnessArtifact.verify_json(@reordered_json, @claim, @policy)
  end

  test "artifact shape and identity fail before certificate verification" do
    artifact = Jason.decode!(@artifact_json)

    assert {:error, :witness_artifact_id_mismatch} =
             artifact
             |> Map.put("artifactId", String.duplicate("A", 43))
             |> put_in(["signature"], flip_base64(@artifact_json, "signature"))
             |> verify()

    for malformed <- [
          Map.put(artifact, "v", 2),
          Map.put(artifact, "extra", true),
          Map.delete(artifact, "signature"),
          put_in(artifact, ["claim", "extra"], true),
          put_in(artifact, ["claim", "version"], 2),
          put_in(
            artifact,
            ["claim", "holder"],
            String.trim_trailing(artifact["claim"]["holder"], "=")
          ),
          put_in(artifact, ["claim", "holderEpoch"], artifact["claim"]["holderEpoch"] <> "="),
          Map.put(artifact, "witness", Base.encode64(:binary.copy(<<7>>, 31))),
          Map.put(artifact, "signature", Base.encode64(:binary.copy(<<7>>, 63)))
        ] do
      assert {:error, :malformed_witness_artifact} = verify(malformed)
    end
  end

  test "signature and every claim binding retain existing certificate errors" do
    artifact = Jason.decode!(@artifact_json)

    assert {:error, :invalid_recovery_signature} =
             artifact
             |> Map.put("signature", flip_base64(@artifact_json, "signature"))
             |> verify()

    claim_mutations = [
      {"holder", Base.encode64(:binary.copy(<<4>>, 32))},
      {"holderEpoch", Base.url_encode64(:binary.copy(<<5>>, 32), padding: false)},
      {"successor", Base.encode64(:binary.copy(<<6>>, 32))},
      {"replica", "replica:matter:other"},
      {"role", "moderator"}
    ]

    for {field, value} <- claim_mutations do
      assert {:error, :recovery_claim_mismatch} =
               artifact
               |> put_in(["claim", field], value)
               |> with_recomputed_artifact_id()
               |> verify()
    end

    assert {:error, :recovery_policy_mismatch} =
             artifact
             |> put_in(
               ["claim", "policyId"],
               Base.url_encode64(:binary.copy(<<8>>, 32), padding: false)
             )
             |> with_recomputed_artifact_id()
             |> verify()
  end

  test "a recomputed artifact id cannot make an unpinned witness acceptable" do
    artifact = Jason.decode!(@artifact_json)

    assert {:error, :unknown_recovery_witness} =
             artifact
             |> Map.put("witness", Base.encode64(Identity.from_seed("unpinned", "unpinned").pub))
             |> with_recomputed_artifact_id()
             |> verify()
  end

  defp verify(artifact) do
    artifact |> Jason.encode!() |> SuccessionWitnessArtifact.verify_json(@claim, @policy)
  end

  defp with_recomputed_artifact_id(artifact) do
    claim = claim_from_json(artifact["claim"])
    witness = Base.decode64!(artifact["witness"])

    artifact_id =
      [
        "lattice-succession-witness-artifact-v1",
        SuccessionCertificate.signing_payload(claim),
        witness
      ]
      |> Canonical.term()
      |> then(&:crypto.hash(:sha256, &1))
      |> Base.url_encode64(padding: false)

    Map.put(artifact, "artifactId", artifact_id)
  end

  defp claim_from_json(claim) do
    %{
      version: claim["version"],
      replica: claim["replica"],
      role: role(claim["role"]),
      holder: Base.decode64!(claim["holder"]),
      holder_epoch: claim["holderEpoch"],
      successor: Base.decode64!(claim["successor"]),
      policy_id: claim["policyId"]
    }
  end

  defp role("clerk"), do: :clerk
  defp role("moderator"), do: :moderator

  defp flip_base64(json, field) do
    <<byte, rest::binary>> = json |> Jason.decode!() |> Map.fetch!(field) |> Base.decode64!()
    Base.encode64(<<Bitwise.bxor(byte, 1), rest::binary>>)
  end
end
