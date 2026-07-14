defmodule Township.Election.ArtifactRef do
  @moduledoc """
  Immutable reference to bounded, versioned election artifact bytes.

  The digest is domain-separated by codec and profile. An availability
  certificate is metadata only; resolution still requires the exact bytes.
  """

  alias Lattice.Canonical

  @digest_domain "township-election-artifact-v1"
  @digest_size 43
  @foundation_codec "township-election-artifact-v1"

  @enforce_keys [:digest, :byte_size, :codec, :profile, :availability_certificate]
  defstruct [:digest, :byte_size, :codec, :profile, :availability_certificate]

  @type t :: %__MODULE__{
          digest: String.t(),
          byte_size: non_neg_integer(),
          codec: String.t(),
          profile: String.t(),
          availability_certificate: term() | nil
        }

  @spec new(binary(), keyword()) :: {:ok, t()} | {:error, atom()}
  def new(bytes, opts) when is_binary(bytes) and is_list(opts) do
    with {:ok, max_byte_size} <- max_byte_size(opts),
         :ok <- validate_bound(byte_size(bytes), max_byte_size),
         {:ok, codec} <- nonempty_binary(opts, :codec, :invalid_artifact_codec),
         {:ok, profile} <- nonempty_binary(opts, :profile, :invalid_artifact_profile),
         availability_certificate = Keyword.get(opts, :availability_certificate),
         :ok <- validate_canonical(availability_certificate) do
      {:ok,
       %__MODULE__{
         digest: digest(bytes, codec, profile),
         byte_size: byte_size(bytes),
         codec: codec,
         profile: profile,
         availability_certificate: availability_certificate
       }}
    end
  rescue
    _ -> {:error, :noncanonical_artifact}
  end

  def new(_bytes, _opts), do: {:error, :noncanonical_artifact}

  @doc "Canonical document codec used by the research foundation contracts."
  @spec foundation_codec() :: String.t()
  def foundation_codec, do: @foundation_codec

  @spec validate(t(), keyword()) :: :ok | {:error, atom()}
  def validate(%__MODULE__{} = ref, opts) when is_list(opts) do
    with {:ok, max_byte_size} <- max_byte_size(opts),
         :ok <- validate_digest(ref.digest),
         :ok <- validate_bound(ref.byte_size, max_byte_size),
         :ok <- validate_ref_binary(ref.codec),
         :ok <- validate_ref_binary(ref.profile),
         :ok <- validate_canonical(ref.availability_certificate) do
      :ok
    end
  rescue
    _ -> {:error, :noncanonical_artifact}
  end

  def validate(_ref, _opts), do: {:error, :noncanonical_artifact}

  @spec verify_bytes(t(), binary(), keyword()) :: :ok | {:error, atom()}
  def verify_bytes(%__MODULE__{} = ref, bytes, opts) when is_binary(bytes) and is_list(opts) do
    with :ok <- validate(ref, opts),
         {:ok, max_byte_size} <- max_byte_size(opts),
         :ok <- validate_bound(byte_size(bytes), max_byte_size),
         :ok <- verify_size(ref, bytes),
         :ok <- verify_digest(ref, bytes) do
      :ok
    end
  rescue
    _ -> {:error, :noncanonical_artifact}
  end

  def verify_bytes(_ref, _bytes, _opts), do: {:error, :noncanonical_artifact}

  @spec to_canonical_term(t()) :: map()
  def to_canonical_term(%__MODULE__{} = ref) do
    %{
      "digest" => ref.digest,
      "byte_size" => ref.byte_size,
      "codec" => ref.codec,
      "profile" => ref.profile,
      "availability_certificate" => ref.availability_certificate
    }
  end

  @spec from_canonical_term(term(), keyword()) :: {:ok, t()} | {:error, atom()}
  def from_canonical_term(
        %{
          "digest" => digest,
          "byte_size" => byte_size,
          "codec" => codec,
          "profile" => profile,
          "availability_certificate" => availability_certificate
        } = term,
        opts
      )
      when map_size(term) == 5 and is_list(opts) do
    ref = %__MODULE__{
      digest: digest,
      byte_size: byte_size,
      codec: codec,
      profile: profile,
      availability_certificate: availability_certificate
    }

    with :ok <- validate(ref, opts), do: {:ok, ref}
  end

  def from_canonical_term(_term, _opts), do: {:error, :noncanonical_artifact}

  defp max_byte_size(opts) do
    case Keyword.fetch(opts, :max_byte_size) do
      {:ok, value} when is_integer(value) and value > 0 -> {:ok, value}
      _ -> {:error, :invalid_artifact_bound}
    end
  end

  defp validate_bound(size, max) when is_integer(size) and size >= 0 and size <= max, do: :ok

  defp validate_bound(size, max) when is_integer(size) and size > max,
    do: {:error, :artifact_too_large}

  defp validate_bound(_size, _max), do: {:error, :noncanonical_artifact}

  defp nonempty_binary(opts, key, reason) do
    case Keyword.fetch(opts, key) do
      {:ok, value} ->
        if validate_binary(value, reason) == :ok, do: {:ok, value}, else: {:error, reason}

      :error ->
        {:error, reason}
    end
  end

  defp validate_binary(value, _reason) when is_binary(value) and byte_size(value) > 0, do: :ok
  defp validate_binary(_value, reason), do: {:error, reason}

  defp validate_ref_binary(value) do
    case validate_binary(value, :noncanonical_artifact) do
      :ok -> :ok
      _ -> {:error, :noncanonical_artifact}
    end
  end

  defp validate_digest(digest) when is_binary(digest) and byte_size(digest) == @digest_size do
    with {:ok, decoded} <- Base.url_decode64(digest, padding: false),
         32 <- byte_size(decoded),
         ^digest <- Base.url_encode64(decoded, padding: false) do
      :ok
    else
      _ -> {:error, :noncanonical_artifact}
    end
  end

  defp validate_digest(_digest), do: {:error, :noncanonical_artifact}

  defp validate_canonical(value) do
    if Canonical.signable?(value), do: :ok, else: {:error, :noncanonical_artifact}
  rescue
    _ -> {:error, :noncanonical_artifact}
  end

  defp verify_size(%__MODULE__{byte_size: expected}, bytes) do
    if byte_size(bytes) == expected, do: :ok, else: {:error, :artifact_size_mismatch}
  end

  defp verify_digest(%__MODULE__{} = ref, bytes) do
    if digest(bytes, ref.codec, ref.profile) == ref.digest,
      do: :ok,
      else: {:error, :artifact_digest_mismatch}
  end

  defp digest(bytes, codec, profile) do
    [@digest_domain, codec, profile, bytes]
    |> Canonical.term()
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.url_encode64(padding: false)
  end
end
