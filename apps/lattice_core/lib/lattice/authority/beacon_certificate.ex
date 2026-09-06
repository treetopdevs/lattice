defmodule Lattice.Authority.BeaconCertificate do
  @moduledoc """
  Witness authorization for one exact logical epoch, author, and causal frontier.

  These signatures authorize bounded logical progress, not elapsed physical time.
  """

  alias Lattice.{Canonical, Identity}

  @claim_domain "lattice-beacon-witness-v1"

  @type claim :: %{
          version: 1,
          replica: String.t(),
          epoch: non_neg_integer(),
          author: Identity.pubkey(),
          deps: [String.t()]
        }
  @type certificate :: %{claim: claim(), signatures: [map()]}

  @spec claim(String.t(), non_neg_integer(), Identity.pubkey(), [String.t()]) :: claim()
  def claim(replica, epoch, author, deps),
    do: %{version: 1, replica: replica, epoch: epoch, author: author, deps: Enum.sort(deps)}

  @spec new(claim(), [Identity.t()]) :: certificate()
  def new(claim, witnesses) do
    payload = signing_payload(claim)

    signatures =
      witnesses
      |> Enum.map(fn witness ->
        %{witness: witness.pub, signature: Identity.sign(witness, payload)}
      end)
      |> Enum.sort_by(& &1.witness)

    %{claim: claim, signatures: signatures}
  end

  @spec signing_payload(claim()) :: binary()
  def signing_payload(claim), do: Canonical.term([@claim_domain, claim])
end
