defmodule Township.Election.ArtifactStore do
  @moduledoc """
  Private storage seam for immutable election artifact bytes.

  Implementations resolve by digest and must re-verify the supplied reference;
  fetching or networking is never part of pure election projection.
  """

  alias Township.Election.ArtifactRef

  @type store :: term()

  @callback put(store(), ArtifactRef.t(), binary(), keyword()) ::
              {:ok, store()} | {:error, atom()}
  @callback resolve(store(), ArtifactRef.t(), keyword()) ::
              {:ok, binary()} | {:error, atom()}
end
