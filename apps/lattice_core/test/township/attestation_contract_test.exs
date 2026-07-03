# G4 — the seam contract, executed against the Stub. The `use` generates the
# full attestation suite (see Lattice.Attestation.Contract); when the M4
# primitive lands, add its twin per the contract's moduledoc:
#
#     defmodule Township.AttestationM4ContractTest do
#       use Lattice.Attestation.Contract, impl: Lattice.Attestation.M4Placeholder
#     end
defmodule Township.AttestationStubContractTest do
  use Lattice.Attestation.Contract, impl: Lattice.Attestation.Stub
end
