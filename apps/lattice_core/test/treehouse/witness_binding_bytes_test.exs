defmodule Treehouse.WitnessBindingBytesTest do
  use ExUnit.Case, async: true

  alias Lattice.{Canonical, Identity}

  @fixture Path.expand(
             "../../../../../clients/treehouse-tauri-shell/test/fixtures/witness_binding_v1.json",
             __DIR__
           )
  @binary_fields ~w(enrollmentId recipient creationAttemptId actualWitnessPublicKey generationChallengeDigest freshValidatorNonce nativeRandomNonce nativeCallerSessionDigest)

  test "the fixed binding array retains exact binary terms and independently signed bytes" do
    fixture = @fixture |> File.read!() |> Jason.decode!()
    assert fixture["version"] == 1
    assert length(fixture["vectors"]) == 3

    for vector <- fixture["vectors"] do
      fields = vector["fields"]
      values = Enum.map(@binary_fields, &Base.decode64!(fields[&1]))
      assert Enum.all?(values, &(byte_size(&1) == 32))
      assert byte_size(fields["replica"]) in 1..512

      terms = ["lattice-witness-binding-challenge-v1", 1, "treehouse",
        "dev.treetop.lattice.treehouse", fields["replica"] | values]
      bytes = Canonical.term(terms)
      assert bytes == Base.decode64!(vector["canonicalBase64"])
      key = Base.decode64!(fields["actualWitnessPublicKey"])
      signature = Base.decode64!(vector["signatureBase64"])
      assert Identity.verify(key, bytes, signature)

      for index <- 0..12 do
        changed = List.replace_at(terms, index, "changed") |> Canonical.term()
        refute Identity.verify(key, changed, signature)
      end
    end
  end
end
