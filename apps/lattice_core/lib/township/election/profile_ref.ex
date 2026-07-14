defmodule Township.Election.ProfileRef do
  @moduledoc """
  Immutable reference to one version-pinned election construction profile.

  A reference names bytes and parameters; it does not claim that the profile has
  been selected, implemented, or independently reviewed.
  """

  alias Lattice.Canonical

  @artifact_id_domain "township-election-artifact-profile-v1"

  @enforce_keys [:id, :version, :parameters_digest]
  defstruct [:id, :version, :parameters_digest]

  @type t :: %__MODULE__{
          id: String.t(),
          version: String.t(),
          parameters_digest: String.t()
        }

  @spec new(map()) :: {:ok, t()} | {:error, atom()}
  def new(%__MODULE__{} = profile), do: validate(profile)

  def new(attrs) when is_map(attrs) do
    with {:ok, id} <- required_binary(attrs, :id),
         {:ok, version} <- required_binary(attrs, :version),
         {:ok, parameters_digest} <- required_binary(attrs, :parameters_digest) do
      validate(%__MODULE__{
        id: id,
        version: version,
        parameters_digest: parameters_digest
      })
    end
  end

  def new(_attrs), do: {:error, :invalid_profile_ref}

  @spec to_canonical_term(t()) :: map()
  def to_canonical_term(%__MODULE__{} = profile) do
    %{
      "id" => profile.id,
      "version" => profile.version,
      "parameters_digest" => profile.parameters_digest
    }
  end

  @doc "Domain-separated binding used by every artifact in this frozen profile."
  @spec artifact_id(t()) :: String.t()
  def artifact_id(%__MODULE__{} = profile) do
    [@artifact_id_domain, to_canonical_term(profile)]
    |> Canonical.term()
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.url_encode64(padding: false)
  end

  defp validate(%__MODULE__{} = profile) do
    if Enum.all?([profile.id, profile.version, profile.parameters_digest], &nonempty_binary?/1),
      do: {:ok, profile},
      else: {:error, :invalid_profile_ref}
  end

  defp required_binary(attrs, key) do
    case Map.fetch(attrs, key) do
      {:ok, value} when is_binary(value) and byte_size(value) > 0 -> {:ok, value}
      _ -> {:error, :invalid_profile_ref}
    end
  end

  defp nonempty_binary?(value), do: is_binary(value) and byte_size(value) > 0
end
