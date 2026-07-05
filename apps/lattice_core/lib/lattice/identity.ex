defmodule Lattice.Identity do
  @moduledoc """
  Ed25519 signing identity for a Lattice 2.0 realm.

  Every realm owns a keypair generated at creation. The public key is the realm's
  `author` value inside `Lattice.Op`; the private key signs the canonical encoding
  of each op the realm appends. Signing/verification use OTP `:crypto` eddsa.

  For deterministic simulation (`mix test` re-runs, seeded property tests) a realm
  may be derived from a seed with `from_seed/2`, which produces a stable keypair so
  that op ids — which are content hashes — are byte-identical across runs.
  """

  @enforce_keys [:realm_id, :pub, :priv]
  defstruct [:realm_id, :pub, :priv]

  @type pubkey :: binary()
  @type t :: %__MODULE__{realm_id: String.t(), pub: pubkey(), priv: binary()}

  @doc "Generate a fresh random realm identity."
  @spec generate(String.t()) :: t()
  def generate(realm_id) when is_binary(realm_id) do
    {pub, priv} = :crypto.generate_key(:eddsa, :ed25519)
    %__MODULE__{realm_id: realm_id, pub: pub, priv: priv}
  end

  @doc """
  Derive a deterministic realm identity from a seed string.

  The seed is hashed to a 32-byte Ed25519 private seed, so the same `seed`
  always yields the same keypair. This is what makes the property suite's
  "same seed → byte-identical state" claim achievable.
  """
  @spec from_seed(String.t(), binary()) :: t()
  def from_seed(realm_id, seed) when is_binary(realm_id) and is_binary(seed) do
    private_seed = :crypto.hash(:sha256, seed)
    {pub, priv} = :crypto.generate_key(:eddsa, :ed25519, private_seed)
    %__MODULE__{realm_id: realm_id, pub: pub, priv: priv}
  end

  @doc "Sign a message with the realm's private key."
  @spec sign(t(), binary()) :: binary()
  def sign(%__MODULE__{priv: priv}, message) when is_binary(message) do
    :crypto.sign(:eddsa, :none, message, [priv, :ed25519])
  end

  @doc "Verify a signature against an author public key."
  @spec verify(pubkey(), binary(), binary()) :: boolean()
  def verify(pub, message, signature)
      when is_binary(pub) and is_binary(message) and is_binary(signature) do
    # A forged op may carry a malformed `author`; :crypto raises on a bad key rather
    # than returning false, so guard it — a malformed key is simply an invalid op.
    :crypto.verify(:eddsa, :none, message, signature, [pub, :ed25519])
  rescue
    _ -> false
  end

  def verify(_pub, _message, _signature), do: false

  @doc "Public key of this identity (its `author` value in ops)."
  @spec pub(t()) :: pubkey()
  def pub(%__MODULE__{pub: pub}), do: pub

  @doc "Short, stable, printable fingerprint of a public key for audit/debug output."
  @spec fingerprint(pubkey() | t()) :: String.t()
  def fingerprint(%__MODULE__{pub: pub}), do: fingerprint(pub)

  def fingerprint(pub) when is_binary(pub) do
    pub |> Base.url_encode64(padding: false) |> binary_part(0, 12)
  end
end
