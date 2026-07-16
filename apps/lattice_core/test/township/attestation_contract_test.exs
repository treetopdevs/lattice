# G4 legacy seam contract. M4 uses the separate Township.Election contracts and
# must never add a second implementation of this behavior.
defmodule Township.AttestationStubContractTest do
  use Lattice.Attestation.Contract, impl: Lattice.Attestation.Stub
end

defmodule Township.AttestationLegacyFreezeTest do
  use ExUnit.Case, async: true

  alias Lattice.Attestation.{M4Placeholder, Stub}

  test "the Stub stays non-receipt-free and the M4 tombstone exports no callbacks" do
    Code.ensure_loaded!(M4Placeholder)

    refute Stub.receipt_free?()

    refute function_exported?(M4Placeholder, :receipt_free?, 0)
    refute function_exported?(M4Placeholder, :cast_vouch, 3)
    refute function_exported?(M4Placeholder, :tally, 2)
    refute function_exported?(M4Placeholder, :produce_alt, 2)
  end
end
