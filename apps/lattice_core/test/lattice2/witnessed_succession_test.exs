defmodule Lattice2.WitnessedSuccessionTest do
  @moduledoc """
  Adversarial coverage for genesis-pinned witnessed succession recovery.
  """

  use ExUnit.Case, async: true

  alias Lattice.Authority.SuccessionCertificate
  alias Lattice.Sim
  alias Township.Matter

  @replica "replica:township:witnessed-succession"

  defp founded(opts \\ []) do
    recovery =
      Keyword.get(opts, :recovery, %{
        mode: :witnessed,
        version: 1,
        witnesses: ["witness_a", "witness_b", "witness_c"],
        threshold: 2
      })

    policy = Keyword.get(opts, :policy, %{successor: "resident", recovery: recovery})

    Sim.new(
      Matter,
      @replica,
      [
        "clerk",
        "replacement",
        "resident",
        "witness_a",
        "witness_b",
        "witness_c",
        "sybil_a",
        "sybil_b",
        "sybil_c"
      ],
      seed: "witnessed-succession"
    )
    |> Sim.create_replica("clerk",
      policies: %{
        clerk: policy
      }
    )
    |> elem(0)
    |> Sim.sync_all()
  end

  defp pub(sim, realm), do: Sim.identity(sim, realm).pub

  defp valid_certificate(sim) do
    {_sim, recovery} =
      Sim.succeed(sim, "resident", :clerk, witnesses: ["witness_a", "witness_b"])

    {:succeed, :clerk, _delegation, {:witnessed, certificate}} = recovery.body
    certificate
  end

  defp signed_certificate(sim, claim, witnesses \\ ["witness_a", "witness_b"]) do
    identities = Enum.map(witnesses, &Sim.identity(sim, &1))
    SuccessionCertificate.new(claim, identities)
  end

  test "witnessed recovery refuses a subthreshold certificate" do
    sim = founded()
    {sim, recovery} = Sim.succeed(sim, "resident", :clerk, witnesses: ["witness_a"])
    sim = Sim.sync_all(sim)

    assert {true, :insufficient_recovery_witnesses} =
             Sim.quarantined(sim, "resident", recovery.id)

    assert Sim.holder(sim, "resident", :clerk) == pub(sim, "clerk")
  end

  test "witnessed recovery honors the configured threshold" do
    sim = founded()

    {sim, recovery} =
      Sim.succeed(sim, "resident", :clerk, witnesses: ["witness_a", "witness_b"])

    sim = Sim.sync_all(sim)

    refute Sim.quarantined(sim, "resident", recovery.id)
    assert Sim.holder(sim, "resident", :clerk) == pub(sim, "resident")
  end

  test "unpinned Sybil identities cannot satisfy the witness threshold" do
    sim = founded()

    {sim, recovery} =
      Sim.succeed(sim, "resident", :clerk, witnesses: ["sybil_a", "sybil_b", "sybil_c"])

    sim = Sim.sync_all(sim)

    assert {true, :unknown_recovery_witness} =
             Sim.quarantined(sim, "resident", recovery.id)

    assert Sim.holder(sim, "resident", :clerk) == pub(sim, "clerk")
  end

  test "duplicate witness entries fail closed" do
    sim = founded()
    certificate = valid_certificate(sim)
    [signature | _] = certificate.signatures
    duplicate = %{certificate | signatures: [signature, signature]}

    {sim, recovery} =
      Sim.succeed(sim, "resident", :clerk, certificate: duplicate)

    sim = Sim.sync_all(sim)

    assert {true, :duplicate_recovery_witness} =
             Sim.quarantined(sim, "resident", recovery.id)

    assert Sim.holder(sim, "resident", :clerk) == pub(sim, "clerk")
  end

  test "non-canonical witness order fails closed" do
    sim = founded()
    certificate = valid_certificate(sim)
    reversed = %{certificate | signatures: Enum.reverse(certificate.signatures)}

    {sim, recovery} =
      Sim.succeed(sim, "resident", :clerk, certificate: reversed)

    sim = Sim.sync_all(sim)

    assert {true, :noncanonical_recovery_signatures} =
             Sim.quarantined(sim, "resident", recovery.id)

    assert Sim.holder(sim, "resident", :clerk) == pub(sim, "clerk")
  end

  test "an invalid pinned-witness signature fails closed" do
    sim = founded()
    certificate = valid_certificate(sim)
    [first | rest] = certificate.signatures
    <<byte, tail::binary>> = first.signature
    corrupted = %{first | signature: <<Bitwise.bxor(byte, 1), tail::binary>>}
    invalid = %{certificate | signatures: [corrupted | rest]}

    {sim, recovery} =
      Sim.succeed(sim, "resident", :clerk, certificate: invalid)

    sim = Sim.sync_all(sim)

    assert {true, :invalid_recovery_signature} =
             Sim.quarantined(sim, "resident", recovery.id)

    assert Sim.holder(sim, "resident", :clerk) == pub(sim, "clerk")
  end

  test "a malformed certificate fails closed" do
    sim = founded()
    certificate = valid_certificate(sim)
    malformed = %{claim: certificate.claim}

    {sim, recovery} =
      Sim.succeed(sim, "resident", :clerk, certificate: malformed)

    sim = Sim.sync_all(sim)

    assert {true, :malformed_recovery_certificate} =
             Sim.quarantined(sim, "resident", recovery.id)

    assert Sim.holder(sim, "resident", :clerk) == pub(sim, "clerk")
  end

  test "an invalid recovery policy takes precedence over the submitted proof mode" do
    sim =
      founded(
        recovery: %{
          mode: :witnessed,
          version: 2,
          witnesses: ["witness_a", "witness_b", "witness_c"],
          threshold: 2
        }
      )

    {sim, recovery} =
      Sim.succeed(sim, "resident", :clerk, at_tick: 1_000_000)

    sim = Sim.sync_all(sim)

    assert {true, :invalid_recovery_policy} =
             Sim.quarantined(sim, "resident", recovery.id)

    assert Sim.holder(sim, "resident", :clerk) == pub(sim, "clerk")
  end

  test "a dual legacy and witnessed policy fails closed" do
    recovery = %{
      mode: :witnessed,
      version: 1,
      witnesses: ["witness_a", "witness_b", "witness_c"],
      threshold: 2
    }

    sim =
      founded(
        policy: %{
          successor: "resident",
          dormant_ticks: 3,
          recovery: recovery
        }
      )

    {sim, succession} =
      Sim.succeed(sim, "resident", :clerk, at_tick: 1_000_000)

    sim = Sim.sync_all(sim)

    assert {true, :invalid_recovery_policy} =
             Sim.quarantined(sim, "resident", succession.id)

    assert Sim.holder(sim, "resident", :clerk) == pub(sim, "clerk")
  end

  test "a certificate cannot be replayed after the holder epoch changes" do
    sim = founded()
    certificate = valid_certificate(sim)

    {sim, _delegation} =
      Sim.transfer(sim, "clerk", "replacement", :clerk, ops: [:close_matter, :reopen_matter])

    sim = Sim.sync_all(sim)
    assert Sim.holder(sim, "resident", :clerk) == pub(sim, "replacement")

    {sim, recovery} =
      Sim.succeed(sim, "resident", :clerk, certificate: certificate)

    sim = Sim.sync_all(sim)

    assert {true, :recovery_claim_mismatch} =
             Sim.quarantined(sim, "resident", recovery.id)

    assert Sim.holder(sim, "resident", :clerk) == pub(sim, "replacement")
  end

  test "every recovery claim binding is enforced independently" do
    sim = founded()
    certificate = valid_certificate(sim)

    mutations = [
      replica: "replica:other",
      role: :moderator,
      holder: pub(sim, "sybil_a"),
      holder_epoch: "other-acquisition",
      successor: pub(sim, "sybil_b")
    ]

    for {field, value} <- mutations do
      claim = Map.put(certificate.claim, field, value)
      rebound = signed_certificate(sim, claim)
      {reduced, recovery} = Sim.succeed(sim, "resident", :clerk, certificate: rebound)
      reduced = Sim.sync_all(reduced)

      assert {true, :recovery_claim_mismatch} =
               Sim.quarantined(reduced, "resident", recovery.id)

      assert Sim.holder(reduced, "resident", :clerk) == pub(sim, "clerk")
    end
  end

  test "a certificate cannot be replayed under a different recovery policy" do
    sim = founded()
    certificate = valid_certificate(sim)
    claim = %{certificate.claim | policy_id: "different-policy"}
    rebound = signed_certificate(sim, claim)

    {sim, recovery} =
      Sim.succeed(sim, "resident", :clerk, certificate: rebound)

    sim = Sim.sync_all(sim)

    assert {true, :recovery_policy_mismatch} =
             Sim.quarantined(sim, "resident", recovery.id)

    assert Sim.holder(sim, "resident", :clerk) == pub(sim, "clerk")
  end

  test "an unsupported certificate version fails closed" do
    sim = founded()
    certificate = valid_certificate(sim)
    claim = %{certificate.claim | version: 2}
    unsupported = signed_certificate(sim, claim)

    {sim, recovery} =
      Sim.succeed(sim, "resident", :clerk, certificate: unsupported)

    sim = Sim.sync_all(sim)

    assert {true, :unsupported_recovery_version} =
             Sim.quarantined(sim, "resident", recovery.id)

    assert Sim.holder(sim, "resident", :clerk) == pub(sim, "clerk")
  end

  test "a valid threshold does not excuse an unknown extra signature" do
    sim = founded()
    certificate = valid_certificate(sim)

    mixed =
      signed_certificate(sim, certificate.claim, ["witness_a", "witness_b", "sybil_a"])

    {sim, recovery} =
      Sim.succeed(sim, "resident", :clerk, certificate: mixed)

    sim = Sim.sync_all(sim)

    assert {true, :unknown_recovery_witness} =
             Sim.quarantined(sim, "resident", recovery.id)

    assert Sim.holder(sim, "resident", :clerk) == pub(sim, "clerk")
  end

  test "legacy ticks and witnessed certificates cannot cross policy modes" do
    witnessed = founded()

    {witnessed, tick_succession} =
      Sim.succeed(witnessed, "resident", :clerk, at_tick: 1_000_000)

    witnessed = Sim.sync_all(witnessed)

    assert {true, :recovery_certificate_required} =
             Sim.quarantined(witnessed, "resident", tick_succession.id)

    assert Sim.holder(witnessed, "resident", :clerk) == pub(witnessed, "clerk")

    source = founded()
    certificate = valid_certificate(source)

    legacy =
      founded(policy: %{successor: "resident", dormant_ticks: 3})

    {legacy, witnessed_succession} =
      Sim.succeed(legacy, "resident", :clerk, certificate: certificate)

    legacy = Sim.sync_all(legacy)

    assert {true, :witnessed_recovery_not_configured} =
             Sim.quarantined(legacy, "resident", witnessed_succession.id)

    assert Sim.holder(legacy, "resident", :clerk) == pub(legacy, "clerk")
  end

  test "malformed recovery policies fail before certificate validation" do
    certificate = founded() |> valid_certificate()

    malformed_policies = [
      %{
        mode: :witnessed,
        version: 1,
        witnesses: ["witness_a", "witness_a", "witness_c"],
        threshold: 2
      },
      %{
        mode: :witnessed,
        version: 1,
        witnesses: ["witness_a", "witness_b", "witness_c"],
        threshold: 0
      }
    ]

    for recovery_policy <- malformed_policies do
      sim = founded(recovery: recovery_policy)
      {sim, recovery} = Sim.succeed(sim, "resident", :clerk, certificate: certificate)
      sim = Sim.sync_all(sim)

      assert {true, :invalid_recovery_policy} =
               Sim.quarantined(sim, "resident", recovery.id)

      assert Sim.holder(sim, "resident", :clerk) == pub(sim, "clerk")
    end
  end

  test "policy identity and certificate order are independent of witness input order" do
    sim = founded()
    recovery = Sim.authority(sim, "resident").policies.clerk.recovery
    reversed_policy = %{recovery | witnesses: Enum.reverse(recovery.witnesses)}

    assert {:ok, policy_id} = SuccessionCertificate.policy_id(recovery)
    assert {:ok, ^policy_id} = SuccessionCertificate.policy_id(reversed_policy)

    certificate = valid_certificate(sim)

    reversed_certificate =
      signed_certificate(sim, certificate.claim, ["witness_b", "witness_a"])

    assert reversed_certificate == certificate
  end
end
