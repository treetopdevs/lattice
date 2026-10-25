defmodule Lattice.Identity do
  @moduledoc """
  Ed25519 signing identity for a Lattice 2.0 realm.

  Every realm owns a keypair generated at creation. The public key is the realm's
  `author` value inside `Lattice.Op`; the private key signs the canonical encoding
  of each op the realm appends. Signing/verification use OTP `:crypto` eddsa.

  For deterministic simulation (`mix test` re-runs, seeded property tests) a realm
  may be derived from a seed with `from_seed/2`, which produces a stable keypair so
  that op ids — which are content hashes — are byte-identical across runs.

  The struct is inspect-redacted; accessing `priv` directly still returns the private key.
  """

  # Protect every holder's logs, crash reports, ExUnit diffs and inspected config dumps.
  # Carrier-server Holder status formatting and its Secret wrapper remain defense in depth.
  @derive {Inspect, except: [:priv]}
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

  # Canonical encodings of all eight points in the Ed25519 torsion subgroup.
  # Source: @noble/curves 2.2.0 ED25519_TORSION_SUBGROUP (MIT).
  @small_order Enum.map(
                 [
                   "0100000000000000000000000000000000000000000000000000000000000000",
                   "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
                   "0000000000000000000000000000000000000000000000000000000000000080",
                   "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
                   "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
                   "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
                   "0000000000000000000000000000000000000000000000000000000000000000",
                   "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa"
                 ],
                 &Base.decode16!(&1, case: :lower)
               )
  @small_order_y Enum.uniq(
                   Enum.map(@small_order, fn point ->
                     Bitwise.band(
                       :binary.decode_unsigned(point, :little),
                       Bitwise.bsl(1, 255) - 1
                     )
                   end)
                 )
  @field_prime Bitwise.bsl(1, 255) - 19
  @scalar_order Bitwise.bsl(1, 252) + 27_742_317_777_372_353_535_851_937_790_883_648_493

  @doc "Verify canonical Ed25519 with no small-order key/R and a strict equation."
  @spec verify(pubkey(), binary(), binary()) :: boolean()
  def verify(
        <<_::256>> = pub,
        message,
        <<r::binary-size(32), s::little-unsigned-size(256)>> = signature
      )
      when is_binary(message) do
    strict_point_encoding?(pub) and strict_point_encoding?(r) and s < @scalar_order and
      :crypto.verify(:eddsa, :none, message, signature, [pub, :ed25519])
  rescue
    _ -> false
  end

  def verify(_pub, _message, _signature), do: false

  # OTP/OpenSSL supplies point decoding and the uncofactored verification equation.
  # Explicit guards remove its permissive weak-key / noncanonical input cases.
  defp strict_point_encoding?(<<encoded::little-unsigned-size(256)>>) do
    y = Bitwise.band(encoded, Bitwise.bsl(1, 255) - 1)
    y < @field_prime and y not in @small_order_y
  end

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
