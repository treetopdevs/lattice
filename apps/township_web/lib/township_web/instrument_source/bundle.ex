defmodule TownshipWeb.InstrumentSource.Bundle do
  @moduledoc """
  Loads a Township read model only after the complete audit bundle verifies.
  """

  @behaviour TownshipWeb.InstrumentSource

  alias TownshipWeb.VerifiedInstrumentSnapshot

  @impl true
  def load(opts) do
    case VerifiedInstrumentSnapshot.load_bundle(Keyword.get(opts, :bundle_dir)) do
      {:ok, snapshot} -> {:ok, snapshot}
      {:error, errors} -> {:error, {:bundle_unverified, errors}}
    end
  end
end
