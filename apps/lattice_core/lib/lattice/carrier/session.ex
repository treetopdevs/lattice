defmodule Lattice.Carrier.Session do
  @moduledoc """
  Versioned signed challenge/response for carrier connection setup.

  The server contributes a per-connection nonce before the client signs its
  challenge. Connection lifecycle stays transport-specific; this module defines
  the nonce frame, transcript bytes, and verification result.
  """

  alias Lattice.Identity

  @session_version 2

  @spec session_version() :: pos_integer()
  def session_version, do: @session_version

  @spec nonce_frame(keyword()) :: map()
  def nonce_frame(opts \\ []) do
    %{
      "type" => "carrier_nonce",
      "nonce" => fresh_nonce(),
      "wire_version" => Keyword.fetch!(opts, :wire_version),
      "session_version" => @session_version
    }
  end

  @spec verify_nonce_frame(term(), keyword()) ::
          {:ok, String.t()}
          | {:error,
             :unsupported_wire_version | :unsupported_session_version | :malformed_session}
  def verify_nonce_frame(frame, opts) do
    expected_wire_version = Keyword.fetch!(opts, :expected_wire_version)

    with %{
           "type" => "carrier_nonce",
           "nonce" => nonce,
           "wire_version" => ^expected_wire_version,
           "session_version" => @session_version
         } <- frame,
         {:ok, decoded} <- decode_url64(nonce),
         true <- byte_size(decoded) == 32 do
      {:ok, nonce}
    else
      %{"wire_version" => version} when version != expected_wire_version ->
        {:error, :unsupported_wire_version}

      %{"session_version" => version} when version != @session_version ->
        {:error, :unsupported_session_version}

      _other ->
        {:error, :malformed_session}
    end
  end

  @spec challenge(String.t(), String.t(), keyword()) :: map()
  def challenge(local_realm, replica, opts \\ []) do
    %{
      "type" => "carrier_challenge",
      "local_realm" => local_realm,
      "replica" => replica,
      "nonce" => fresh_nonce(),
      "server_nonce" => Keyword.fetch!(opts, :server_nonce),
      "wire_version" => Keyword.fetch!(opts, :wire_version),
      "session_version" => Keyword.get(opts, :session_version, @session_version)
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
          :ok
          | {:error,
             :wrong_realm
             | :wrong_server_nonce
             | :unsupported_wire_version
             | :unsupported_session_version
             | :bad_signature
             | :malformed_session}
  def verify_challenge(challenge, opts) do
    expected_realm = Keyword.fetch!(opts, :expected_realm)
    expected_pubkey = Keyword.fetch!(opts, :expected_pubkey)
    expected_server_nonce = Keyword.fetch!(opts, :expected_server_nonce)
    expected_wire_version = Keyword.fetch!(opts, :expected_wire_version)

    with %{
           "local_realm" => ^expected_realm,
           "server_nonce" => ^expected_server_nonce,
           "wire_version" => ^expected_wire_version,
           "session_version" => @session_version,
           "pubkey" => pub_b64,
           "signature" => sig_b64
         } <- challenge,
         {:ok, claimed_pubkey} <- decode64(pub_b64),
         true <- claimed_pubkey == expected_pubkey,
         {:ok, sig} <- decode64(sig_b64),
         {:ok, transcript} <- safe_transcript(challenge, expected_realm, expected_pubkey),
         true <-
           Identity.verify(
             expected_pubkey,
             transcript,
             sig
           ) do
      :ok
    else
      %{"local_realm" => realm} when realm != expected_realm ->
        {:error, :wrong_realm}

      %{"server_nonce" => nonce} when nonce != expected_server_nonce ->
        {:error, :wrong_server_nonce}

      %{"wire_version" => version} when version != expected_wire_version ->
        {:error, :unsupported_wire_version}

      %{"session_version" => version} when version != @session_version ->
        {:error, :unsupported_session_version}

      false ->
        {:error, :bad_signature}

      _other ->
        {:error, :malformed_session}
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
         {:ok, claimed_pubkey} <- decode64(pub_b64),
         true <- claimed_pubkey == expected_pubkey,
         {:ok, sig} <- decode64(sig_b64),
         {:ok, transcript} <- safe_transcript(challenge, expected_realm, expected_pubkey),
         true <-
           Identity.verify(
             expected_pubkey,
             transcript,
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
      "carrier-session-v2",
      challenge["local_realm"],
      challenge["replica"],
      challenge["nonce"],
      challenge["server_nonce"],
      challenge["wire_version"],
      challenge["session_version"],
      realm,
      pubkey
    ])
  end

  defp fresh_nonce do
    Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)
  end

  defp decode64(value) when is_binary(value), do: Base.decode64(value)
  defp decode64(_value), do: {:error, :malformed_session}

  defp decode_url64(value) when is_binary(value),
    do: Base.url_decode64(value, padding: false)

  defp decode_url64(_value), do: {:error, :malformed_session}

  defp safe_transcript(challenge, realm, pubkey) do
    {:ok, transcript(challenge, realm, pubkey)}
  rescue
    ArgumentError -> {:error, :malformed_session}
  end
end
