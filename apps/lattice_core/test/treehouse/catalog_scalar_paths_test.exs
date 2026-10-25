defmodule Treehouse.CatalogScalarPathsTest do
  use ExUnit.Case, async: false
  alias Lattice.Carrier.Wire
  alias Lattice.{IntegerParseTrace, Op}
  alias Treehouse.{CatalogTrust, CatalogTrustVectors}
  @expected %{trust_revision: 0, history_generation: 0}

  test "accepted, rejected, incoming proof and saved proof scalar paths refuse oversized decimals" do
    f = CatalogTrustVectors.fixture(0)
    history = hd(f.histories)
    control = Op.new(f.space.root, f.space.replica, [], :command, 1) |> Wire.encode_op()
    forged = Map.put(control, "sig", Base.encode64(<<0::512>>))
    rejected = %{history | rejected: [%{frame: forged, reason: :bad_signature}]}
    prepared = prepare(f.review, history)
    assert prepared.kind == :propose
    assert prepare(f.review, rejected).kind == :propose
    proof = hd(f.cutoff_proofs)
    accepted = evaluate(prepared.next, %{page() | cutoff_proofs: [proof]})
    assert accepted.kind == :propose

    {_, calls} =
      IntegerParseTrace.capture(fn ->
        maximum =
          Op.new(f.space.root, f.space.replica, [], :command, 18_446_744_073_709_551_615)
          |> Wire.encode_op()

        assert {:ok, _} = Wire.authenticate_observation(maximum)

        for size <- [21, 1_048_576] do
          frame = Map.put(control, "body", ["int", String.duplicate("9", size)])

          bad = %{
            history
            | rejected: [%{frame: Map.put(frame, "sig", forged["sig"]), reason: :bad_signature}]
          }

          for d <- [prepare(f.review, bad), evaluate(prepared.next, %{page() | histories: [bad]})] do
            assert d.kind == :reject
            assert d.reason == :unsupported_cutoff
            assert d.detail.ids == []
          end

          assert {:error, :malformed_op} = Wire.authenticate_observation(frame)
          bad_proof = %{proof | history: %{history | frames: history.frames ++ [frame]}}
          incoming = evaluate(prepared.next, %{page() | cutoff_proofs: [bad_proof]})
          assert incoming.kind == :reject
          assert incoming.reason == :recovery_incomplete
          assert incoming.detail.ids == []
          broken = %{accepted.next | cutoff_proofs: [bad_proof]}
          saved = evaluate(broken, %{page() | cutoff_proofs: [proof]})
          assert saved.kind == :reject
          assert saved.reason == :trust_recovery_required
          assert saved.detail.ids == []
        end
      end)

    assert "18446744073709551615" in calls
    refute Enum.any?(calls, &(byte_size(&1) > 20))
  end

  defp prepare(review, history),
    do:
      CatalogTrust.prepare_installation(%{
        review: review,
        history: history,
        store: %{kind: :verified_fresh, expected: @expected}
      })

  defp page, do: %{catalogs: [], rotations: [], histories: [], cutoff_proofs: []}

  defp evaluate(installed, incoming),
    do: CatalogTrust.evaluate(%{installed: installed, expected: @expected, incoming: incoming})
end
