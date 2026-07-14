defmodule Lattice.Attestation.Contract do
  @moduledoc """
  The legacy Stub guarantee, executable.

  A `using` macro that freezes the pre-M4 demo behavior while the application
  still exposes caller-held vouches. It is intentionally instantiated only for
  `Lattice.Attestation.Stub`:

      defmodule Township.AttestationStubContractTest do
        use Lattice.Attestation.Contract, impl: Lattice.Attestation.Stub
      end

  The contract fails closed if a legacy implementation claims receipt-freeness.
  M4 must not be implemented here: `Township.Election` has separate board,
  projection, close-policy, offline-replay, and cryptographic conformance
  contracts.
  """

  defmacro __using__(opts) do
    impl = Keyword.fetch!(opts, :impl)

    quote bind_quoted: [impl: impl] do
      use ExUnit.Case, async: true

      alias Lattice.{Attestation, Identity}

      @impl_mod impl

      setup do
        %{
          alice: Identity.from_seed("realm:alice", <<1::256>>),
          bob: Identity.from_seed("realm:bob", <<2::256>>)
        }
      end

      test "cast_vouch returns an opaque token and a legacy :vouch body", %{alice: alice} do
        {token, body} = Attestation.cast_vouch(@impl_mod, alice, :yes)
        assert {:vouch, _payload} = body
        # The token is opaque; we only require it be usable by produce_alt later.
        assert token != nil
      end

      test "tally is deterministic and counts choices", %{alice: alice, bob: bob} do
        {_t1, b1} = Attestation.cast_vouch(@impl_mod, alice, :yes)
        {_t2, b2} = Attestation.cast_vouch(@impl_mod, bob, :yes)
        {_t3, b3} = Attestation.cast_vouch(@impl_mod, alice, :no)

        r1 = Attestation.tally(@impl_mod, [b1, b2, b3])
        r2 = Attestation.tally(@impl_mod, [b3, b1, b2])

        assert r1 == r2, "tally must not depend on op arrival order"
        assert r1.outcome == :yes
        assert r1.counts[:yes] == 2
        assert r1.counts[:no] == 1
      end

      test "empty tally is well-defined" do
        assert %{outcome: :no_vouches, counts: counts} = Attestation.tally(@impl_mod, [])
        assert counts == %{}
      end

      test "produce_alt yields a well-formed alternative vouch body", %{alice: alice} do
        {token, _body} = Attestation.cast_vouch(@impl_mod, alice, :yes)
        alt = Attestation.produce_alt(@impl_mod, token, :no)
        assert {:vouch, _} = alt
        # The alternative must itself be tallyable.
        assert %{counts: %{no: 1}} = Attestation.tally(@impl_mod, [alt])
      end

      test "legacy implementations cannot claim receipt-freeness", %{alice: alice} do
        if @impl_mod.receipt_free?() do
          {token, genuine} = Attestation.cast_vouch(@impl_mod, alice, :yes)
          alt = Attestation.produce_alt(@impl_mod, token, :no)

          # Both outputs must be individually well-formed vouch bodies…
          assert {:vouch, _} = genuine
          assert {:vouch, _} = alt

          # A true value on this retired interface has no sound security meaning.
          flunk("""
          #{inspect(@impl_mod)} claims receipt_free? == true on the retired legacy
          interface. Keep the Stub false and implement the gated protocol under
          Township.Election instead.
          """)
        else
          assert @impl_mod.receipt_free?() == false
        end
      end
    end
  end
end
