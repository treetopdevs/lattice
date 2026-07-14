defmodule Township.Election.ArtifactStore.Memory do
  @moduledoc """
  Pure in-memory artifact resolver for tests and the research foundation.

  It stores exact immutable bytes by digest. The same reference/bytes pair is
  idempotent; absent or altered bytes fail closed.
  """

  @behaviour Township.Election.ArtifactStore

  alias Township.Election.ArtifactRef

  defstruct bytes: %{}

  @type t :: %__MODULE__{bytes: %{String.t() => binary()}}

  @spec new() :: t()
  def new, do: %__MODULE__{}

  @impl true
  @spec put(t(), ArtifactRef.t(), binary(), keyword()) :: {:ok, t()} | {:error, atom()}
  def put(%__MODULE__{} = store, %ArtifactRef{} = ref, bytes, opts) do
    with :ok <- ArtifactRef.verify_bytes(ref, bytes, opts) do
      case Map.fetch(store.bytes, ref.digest) do
        :error -> {:ok, %{store | bytes: Map.put(store.bytes, ref.digest, bytes)}}
        {:ok, ^bytes} -> {:ok, store}
        {:ok, _different} -> {:error, :artifact_digest_collision}
      end
    end
  end

  def put(_store, _ref, _bytes, _opts), do: {:error, :noncanonical_artifact}

  @impl true
  @spec resolve(t(), ArtifactRef.t(), keyword()) :: {:ok, binary()} | {:error, atom()}
  def resolve(%__MODULE__{} = store, %ArtifactRef{} = ref, opts) do
    with :ok <- ArtifactRef.validate(ref, opts),
         {:ok, bytes} <- fetch(store, ref.digest),
         :ok <- ArtifactRef.verify_bytes(ref, bytes, opts) do
      {:ok, bytes}
    end
  end

  def resolve(_store, _ref, _opts), do: {:error, :noncanonical_artifact}

  defp fetch(store, digest) do
    case Map.fetch(store.bytes, digest) do
      {:ok, bytes} -> {:ok, bytes}
      :error -> {:error, :artifact_unavailable}
    end
  end
end
