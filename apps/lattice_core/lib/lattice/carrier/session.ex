defmodule Lattice.Carrier.Session do
  @moduledoc """
  Stateless signed challenge/response for carrier connection setup.

  Connection lifecycle stays transport-specific; this module only defines the
  transcript bytes and verification result.
  """

  alias Lattice.Identity

  @spec challenge(String.t(), String.t(), keyword()) :: map()
  def challenge(local_realm, replica, opts \\ []) do
    %{
      "type" => "carrier_challenge",
      "local_realm" => local_realm,
      "replica" => replica,
      "nonce" => Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false),
      "wire_version" => Keyword.fetch!(opts, :wire_version)
    }
  end

  @spec sign_challenge(map(), Identity.t()) :: map()
  def sign_challenge(%{"local_realm" => realm} = challenge, %Identity{} = identity) do
    bytes = transcript(challenge, realm, identity.pub)

    challenge
    |> Map.put("pubkey", Base.encode64(identity.pub))
    |> Map.put("signature", identity |> Identity.sign(bytes) |> Base.encode64())
  end

  @spec verify_challenge(map(), keyword()) ::
          :ok | {:error, :wrong_realm | :bad_signature | :malformed_session}
  def verify_challenge(challenge, opts) do
    expected_realm = Keyword.fetch!(opts, :expected_realm)
    expected_pubkey = Keyword.fetch!(opts, :expected_pubkey)

    with %{
           "local_realm" => ^expected_realm,
           "pubkey" => pub_b64,
           "signature" => sig_b64
         } <- challenge,
         {:ok, claimed_pubkey} <- Base.decode64(pub_b64),
         true <- claimed_pubkey == expected_pubkey,
         {:ok, sig} <- Base.decode64(sig_b64),
         true <-
           Identity.verify(
             expected_pubkey,
             transcript(challenge, expected_realm, expected_pubkey),
             sig
           ) do
      :ok
    else
      %{"local_realm" => realm} when realm != expected_realm -> {:error, :wrong_realm}
      false -> {:error, :bad_signature}
      _other -> {:error, :malformed_session}
    end
  end

  @spec respond(map(), Identity.t(), String.t()) :: map()
  def respond(%{} = challenge, %Identity{} = identity, realm) when is_binary(realm) do
    bytes = transcript(challenge, realm, identity.pub)

    %{
      "type" => "carrier_hello",
      "realm" => realm,
      "pubkey" => Base.encode64(identity.pub),
      "signature" => identity |> Identity.sign(bytes) |> Base.encode64()
    }
  end

  @spec verify_response(map(), map(), keyword()) ::
          :ok | {:error, :wrong_realm | :bad_signature | :malformed_session}
  def verify_response(challenge, response, opts) do
    expected_realm = Keyword.fetch!(opts, :expected_realm)
    expected_pubkey = Keyword.fetch!(opts, :expected_pubkey)

    with %{"realm" => ^expected_realm, "pubkey" => pub_b64, "signature" => sig_b64} <- response,
         {:ok, claimed_pubkey} <- Base.decode64(pub_b64),
         true <- claimed_pubkey == expected_pubkey,
         {:ok, sig} <- Base.decode64(sig_b64),
         true <-
           Identity.verify(
             expected_pubkey,
             transcript(challenge, expected_realm, expected_pubkey),
             sig
           ) do
      :ok
    else
      %{"realm" => realm} when realm != expected_realm -> {:error, :wrong_realm}
      %{"realm" => ^expected_realm} -> {:error, :malformed_session}
      false -> {:error, :bad_signature}
      _ -> {:error, :malformed_session}
    end
  end

  @spec transcript(map(), String.t(), Identity.pubkey()) :: binary()
  def transcript(challenge, realm, pubkey) do
    Lattice.Canonical.term([
      "carrier-session-v1",
      challenge["local_realm"],
      challenge["replica"],
      challenge["nonce"],
      challenge["wire_version"],
      realm,
      pubkey
    ])
  end
end
