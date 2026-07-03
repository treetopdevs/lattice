defmodule Lattice.Attestation.Contract do
  @moduledoc """
  The seam guarantee, executable.

  A `using` macro that generates the SAME attestation test suite against whatever
  module you pass as `impl:`. Run it once for the Stub and (later) once for the
  M4 primitive. Everything except the receipt-freeness property must hold for
  BOTH; receipt-freeness is asserted only when `impl.receipt_free?/0` is true.

      defmodule Township.AttestationStubContractTest do
        use Lattice.Attestation.Contract, impl: Lattice.Attestation.Stub
      end

  When M4 lands:

      defmodule Township.AttestationM4ContractTest do
        use Lattice.Attestation.Contract, impl: Lattice.Attestation.M4Placeholder
      end

  If the M4 module changes any callback's shape, this file fails to compile or
  asserts false — loudly, in one place. That is the swap-not-rewrite guarantee.
  """

  defmacro __using__(opts) do
    impl = Keyword.fetch!(opts, :impl)

    quote bind_quoted: [impl: impl] do
      use ExUnit.Case, async: true

      alias Lattice.{Attestation, Identity}

      @impl_mod impl

      setup do
        %{alice: Identity.from_seed("realm:alice", <<1::256>>),
          bob: Identity.from_seed("realm:bob", <<2::256>>)}
      end

      test "cast_vouch returns an opaque token and an appendable :vouch body", %{alice: alice} do
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

      # ---- the property that is REAL only at M4 ----
      test "receipt-freeness: an alternative is indistinguishable from a genuine vouch", %{alice: alice} do
        if @impl_mod.receipt_free?() do
          {token, genuine} = Attestation.cast_vouch(@impl_mod, alice, :yes)
          alt = Attestation.produce_alt(@impl_mod, token, :no)

          # Both outputs must be individually well-formed vouch bodies…
          assert {:vouch, _} = genuine
          assert {:vouch, _} = alt

          # …and the real property — that a coercer seeing only op bodies cannot
          # distinguish the genuine vouch from the produced alternative — must be
          # asserted with the chosen primitive's actual indistinguishability
          # check. Until M4 fills that in, a module that claims receipt_free? =
          # true has not proven it, so we fail explicitly rather than pass vacuously.
          flunk("""
          #{inspect(@impl_mod)} claims receipt_free? == true but the indistinguishability
          assertion is not implemented. Replace this flunk/1 with the real check for the
          chosen primitive (e.g. chameleon-hash re-opening indistinguishability).
          """)
        else
          # Stub honestly declares it is not receipt-free; nothing to prove.
          assert @impl_mod.receipt_free?() == false
        end
      end
    end
  end
end
