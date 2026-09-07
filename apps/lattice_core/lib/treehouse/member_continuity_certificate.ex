defmodule Treehouse.MemberContinuityCertificate do
  @moduledoc """
  Closed detached member-continuity statements and exact signing purposes.

  These codecs prove no membership, causal freshness, authority, expiry or native
  one-use ceremony. The planned command name is declared as host vocabulary only;
  loading this module does not register or enable a Space command.
  """

  alias Lattice.{Canonical, Identity}
  alias Lattice.Carrier.Wire

  @type command_name :: :attest_member_key_v1
  @type claim :: map()
  @type certificate :: %{claim: claim(), possession: binary(), vouches: [map()]}
  @type return_challenge :: map()
  @type refusal :: {:error, :invalid_member_continuity}
  @error {:error, :invalid_member_continuity}
  @claim_fields ~w(version product space old_pub new_pub old_admission old_membership nonce deps epoch epoch_basis parents vouchers)a
  @space ~r/\Areplica:treehouse:space:([A-Za-z0-9_-]{43})#authority:bounded-continuation-v1#root:([A-Za-z0-9_-]{43})\z/
  @horizon 9_007_199_254_740_991
  @return_fields ~w(version product space old_pub heads deps reviewer nonce)a

  @doc "Fixed planned vocabulary only; this does not register or enable a Space command."
  @spec command_name() :: command_name()
  def command_name, do: :attest_member_key_v1

  @spec normalize_claim(term()) :: {:ok, claim()} | {:error, :invalid_member_continuity}
  def normalize_claim(value) do
    if fields?(value, @claim_fields) and value.version === 1 and value.product == :treehouse and
         space?(value.space) and bytes?(value.old_pub, 32) and bytes?(value.new_pub, 32) and
         value.old_pub != value.new_pub and id?(value.old_admission) and
         value.old_membership in [:active, :removed] and bytes?(value.nonce, 32) and
         ids?(value.deps, 1) and ids?(value.epoch_basis, 1) and ids?(value.parents, 0, 16) and
         epoch?(value.epoch) and
         vouchers?(value.vouchers, value.old_pub, value.new_pub),
       do: {:ok, value},
       else: @error
  end

  @spec normalize_certificate(term()) :: {:ok, certificate()} | refusal()
  def normalize_certificate(value) do
    with true <- fields?(value, [:claim, :possession, :vouches]),
         {:ok, claim} <- normalize_claim(value.claim),
         true <- bytes?(value.possession, 64),
         true <- vouches?(value.vouches, claim.vouchers) do
      {:ok, value}
    else
      _ -> @error
    end
  end

  @spec normalize_return_challenge(term()) :: {:ok, return_challenge()} | refusal()
  def normalize_return_challenge(value) do
    valid =
      fields?(value, @return_fields) and value.version === 1 and value.product == :treehouse and
        space?(value.space) and bytes?(value.old_pub, 32) and ids?(value.heads, 1, 16) and
        ids?(value.deps, 1) and bytes?(value.reviewer, 32) and bytes?(value.nonce, 32)

    if valid and byte_size(return_payload(value)) + 64 <= 64_000, do: {:ok, value}, else: @error
  end

  @spec claim_bytes(term()) :: binary()
  def claim_bytes(value),
    do: Canonical.term(["treehouse-member-key-claim-v1", checked!(normalize_claim(value))])

  @spec claim_id(term()) :: String.t()
  def claim_id(value),
    do: :crypto.hash(:sha256, claim_bytes(value)) |> Base.url_encode64(padding: false)

  @spec possession_bytes(term()) :: binary()
  def possession_bytes(value),
    do: Canonical.term(["treehouse-member-key-possession-v1", checked!(normalize_claim(value))])

  @spec vouch_bytes(term(), term()) :: binary()
  def vouch_bytes(value, possession) do
    claim = checked!(normalize_claim(value))

    if not bytes?(possession, 64),
      do: raise(ArgumentError, "invalid member continuity possession")

    Canonical.term(["treehouse-member-key-vouch-v1", claim, possession])
  end

  @spec return_bytes(term()) :: binary()
  def return_bytes(value),
    do: value |> normalize_return_challenge() |> checked!() |> return_payload()

  @doc "Exact detached signatures and expected bytes only; no causal or membership judgment."
  @spec verify_certificate(term(), term()) :: :ok | refusal()
  def verify_certificate(value, expected) do
    with {:ok, certificate} <- normalize_certificate(value),
         {:ok, claim} <- normalize_claim(expected),
         true <- certificate.claim == claim,
         true <- Identity.verify(claim.new_pub, possession_bytes(claim), certificate.possession),
         payload = vouch_bytes(claim, certificate.possession),
         true <-
           Enum.all?(certificate.vouches, &Identity.verify(&1.member, payload, &1.signature)) do
      :ok
    else
      _ -> @error
    end
  end

  @doc "Checks exact expected challenge and old-key signature, not native freshness or consumption."
  @spec verify_return(term(), term(), term()) :: :ok | refusal()
  def verify_return(value, signature, expected) do
    with {:ok, challenge} <- normalize_return_challenge(value),
         {:ok, checked} <- normalize_return_challenge(expected),
         true <- challenge == checked and bytes?(signature, 64),
         true <- Identity.verify(challenge.old_pub, return_payload(challenge), signature) do
      :ok
    else
      _ -> @error
    end
  end

  @doc "Pure arguments only; neither authors nor enables the planned Space command."
  @spec command_arguments(term()) :: {:ok, list()} | refusal()
  def command_arguments(value) do
    with {:ok, cert} <- normalize_certificate(value),
         do: {:ok, [cert.claim, cert.possession, cert.vouches]}
  end

  @spec claim_to_wire(term()) :: {:ok, list()} | refusal()
  def claim_to_wire(value), do: to_wire(value, &normalize_claim/1)
  @spec certificate_to_wire(term()) :: {:ok, list()} | refusal()
  def certificate_to_wire(value), do: to_wire(value, &normalize_certificate/1)
  @spec return_challenge_to_wire(term()) :: {:ok, list()} | refusal()
  def return_challenge_to_wire(value), do: to_wire(value, &normalize_return_challenge/1)
  @spec claim_from_wire(term()) :: {:ok, claim()} | refusal()
  def claim_from_wire(value), do: from_wire(value, &normalize_claim/1)
  @spec certificate_from_wire(term()) :: {:ok, certificate()} | refusal()
  def certificate_from_wire(value), do: from_wire(value, &normalize_certificate/1)
  @spec return_challenge_from_wire(term()) :: {:ok, return_challenge()} | refusal()
  def return_challenge_from_wire(value), do: from_wire(value, &normalize_return_challenge/1)

  defp to_wire(value, normalize) do
    with {:ok, normalized} <- normalize.(value), do: {:ok, Wire.encode_value(normalized)}
  end

  # Preserve raw duplicates until this closed artifact boundary has refused them.
  # Only forms used by these artifacts are admitted, before generic Wire normalization.
  defp from_wire(value, normalize) do
    with true <- raw_term?(value, 0),
         {:ok, decoded} <- Wire.decode_value(value) do
      normalize.(decoded)
    else
      _ -> @error
    end
  end

  defp raw_term?(["map", pairs], depth) when is_list(pairs) and depth < 64 do
    Enum.all?(pairs, fn
      [["atom", key], value] when is_binary(key) -> raw_term?(value, depth + 1)
      _ -> false
    end) and length(Enum.uniq_by(pairs, &hd/1)) == length(pairs)
  end

  defp raw_term?(["list", values], depth) when is_list(values) and depth < 64,
    do: Enum.all?(values, &raw_term?(&1, depth + 1))

  defp raw_term?(["atom", value], _depth), do: is_binary(value)

  defp raw_term?(["int", value], _depth) when is_binary(value) do
    case Integer.parse(value) do
      {number, ""} -> number >= 0 and number <= @horizon and Integer.to_string(number) == value
      _ -> false
    end
  end

  defp raw_term?(["int", value], _depth),
    do: epoch?(value)

  defp raw_term?(["bin", value], _depth) when is_binary(value) do
    case Base.decode64(value) do
      {:ok, bytes} -> Base.encode64(bytes) == value
      :error -> false
    end
  end

  defp raw_term?(_, _), do: false

  defp checked!({:ok, value}), do: value
  defp checked!(@error), do: raise(ArgumentError, "invalid member continuity artifact")
  defp return_payload(value), do: Canonical.term(["treehouse-member-key-return-v1", value])

  defp vouches?([a, b], [first, second]) do
    Enum.all?([{a, first}, {b, second}], fn {entry, voucher} ->
      fields?(entry, [:member, :signature]) and entry.member == voucher.member and
        bytes?(entry.signature, 64)
    end)
  end

  defp vouches?(_, _), do: false

  defp vouchers?(values, old, new) when is_list(values) and length(values) == 2 do
    Enum.all?(values, fn v ->
      fields?(v, [:member, :admission]) and bytes?(v.member, 32) and
        v.member not in [old, new] and id?(v.admission)
    end) and
      Enum.map(values, & &1.member) ==
        Enum.sort(Enum.uniq_by(values, & &1.member) |> Enum.map(& &1.member))
  end

  defp vouchers?(_, _, _), do: false

  defp fields?(value, fields) when is_map(value),
    do: Enum.sort(Map.keys(value)) == Enum.sort(fields)

  defp fields?(_, _), do: false
  defp bytes?(value, length), do: is_binary(value) and byte_size(value) == length
  defp epoch?(value), do: is_integer(value) and value >= 0 and value <= @horizon

  defp id?(value) when is_binary(value) and byte_size(value) == 43 do
    case Base.url_decode64(value, padding: false) do
      {:ok, decoded} ->
        byte_size(decoded) == 32 and Base.url_encode64(decoded, padding: false) == value

      :error ->
        false
    end
  end

  defp id?(_), do: false

  defp space?(value) when is_binary(value) do
    case Regex.run(@space, value) do
      [_, nonce, root] -> id?(nonce) and id?(root)
      _ -> false
    end
  end

  defp space?(_), do: false
  defp ids?(value, minimum, maximum \\ :infinity)

  defp ids?(value, minimum, maximum) when is_list(value) do
    length(value) >= minimum and (maximum == :infinity or length(value) <= maximum) and
      Enum.all?(value, &id?/1) and value == Enum.sort(Enum.uniq(value))
  end

  defp ids?(_, _, _), do: false
end
