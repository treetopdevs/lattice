defmodule TownshipWeb.InstrumentSource.Bundle do
  @moduledoc """
  Loads a Township read model only after the complete audit bundle verifies.
  """

  @behaviour TownshipWeb.InstrumentSource

  alias TownshipWeb.VerifiedInstrumentSnapshot

  @impl true
  def load(opts) do
    bundle_dir = opts |> Keyword.fetch!(:bundle_dir) |> Path.expand()

    case VerifiedInstrumentSnapshot.load_bundle(bundle_dir) do
      {:ok, snapshot} -> {:ok, snapshot}
      {:error, errors} -> {:error, {:bundle_unverified, errors}}
    end
  end
end
