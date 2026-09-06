defmodule TownshipWeb.InstrumentSource.Bundle do
  @moduledoc """
  Loads a Township read model only after the complete audit bundle verifies.
  """

  @behaviour TownshipWeb.InstrumentSource

  alias Lattice.{Attestation, Identity, Log}
  alias Township.{AuditBundle, ReadModel}

  @impl true
  def load(opts) do
    bundle_dir = opts |> Keyword.fetch!(:bundle_dir) |> Path.expand()

    case AuditBundle.load_verified(bundle_dir) do
      {:ok, snapshot} -> load_verified(snapshot)
      {:error, errors} -> {:error, {:bundle_unverified, errors}}
    end
  rescue
    error -> {:error, {:bundle_unverified, [Exception.message(error)]}}
  end

  defp load_verified(%{log: log, labels: labels} = snapshot) do
    {:ok,
     %{
       read_model: ReadModel.observe(log, labels: labels, vouches: demo_vouches()),
       causal_replay: ReadModel.replay(log),
       provenance: %{
         source: :bundle,
         freshness: :snapshot,
         verification: :bundle_signatures,
         bundle_dir: snapshot.bundle_dir,
         matter_sha256: snapshot.matter_sha256,
         schema: snapshot.schema,
         verified: true,
         replica: log.replica,
         frontier: Log.frontier(log)
       }
     }}
  end

  defp demo_vouches do
    [
      {"realm:alice", <<9::256>>, :approve},
      {"realm:bob", <<10::256>>, :approve},
      {"realm:carol", <<11::256>>, :reject}
    ]
    |> Enum.map(fn {realm, seed, choice} ->
      identity = Identity.from_seed(realm, seed)
      {_token, body} = Attestation.cast_vouch(Attestation.Stub, identity, choice)
      body
    end)
  end
end
