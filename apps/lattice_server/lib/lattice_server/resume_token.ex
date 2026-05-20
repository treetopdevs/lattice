defmodule LatticeServer.ResumeToken do
  @moduledoc """
  Short-lived, one-shot JWTs for WebSocket resume attempts.

  The tokens are intentionally scoped to the demo WebSocket resume path. A token
  proves freshness for a reconnect attempt; it does not grant Lattice authority.
  """

  use GenServer
  import Bitwise

  @table :lattice_server_resume_jtis
  @issuer "lattice-server"
  @audience "lattice-ws-resume"
  @token_type "resume"
  @default_ttl_seconds 90

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def issue(client_id, opts \\ []) when is_binary(client_id) do
    GenServer.call(__MODULE__, {:issue, client_id, opts})
  end

  def consume(token) when is_binary(token) do
    GenServer.call(__MODULE__, {:consume, token})
  end

  def reset! do
    GenServer.call(__MODULE__, :reset)
  end

  @impl true
  def init(opts) do
    table =
      case :ets.whereis(@table) do
        :undefined ->
          :ets.new(@table, [:named_table, :set, :protected, read_concurrency: true])

        tid ->
          tid
      end

    secret =
      opts[:secret] ||
        Application.get_env(:lattice_server, :resume_token_secret) ||
        :crypto.strong_rand_bytes(32)

    {:ok, %{secret: secret, table: table}}
  end

  @impl true
  def handle_call({:issue, client_id, opts}, _from, state) do
    cleanup_expired(state.table)

    now = unix_now()
    ttl_seconds = Keyword.get(opts, :ttl_seconds, @default_ttl_seconds)
    exp = now + ttl_seconds
    jti = random_id()
    epk = Keyword.get(opts, :epk)

    claims =
      %{
        "sub" => client_id,
        "iss" => @issuer,
        "aud" => @audience,
        "iat" => now,
        "exp" => exp,
        "type" => @token_type,
        "jti" => jti
      }
      |> maybe_put("epk", epk)

    true = :ets.insert(state.table, {jti, :unused, client_id, exp, now, epk})
    {:reply, {:ok, sign(claims, state.secret), claims}, state}
  end

  def handle_call({:consume, token}, _from, state) do
    cleanup_expired(state.table)

    reply =
      with {:ok, claims} <- verify(token, state.secret),
           :ok <- validate_claims(claims),
           :ok <- consume_jti(state.table, claims) do
        {:ok, claims}
      end

    {:reply, reply, state}
  end

  def handle_call(:reset, _from, state) do
    :ets.delete_all_objects(state.table)
    {:reply, :ok, state}
  end

  defp sign(claims, secret) do
    header = %{"alg" => "HS256", "typ" => "JWT"}
    signing_input = base64_json(header) <> "." <> base64_json(claims)
    signature = hmac(signing_input, secret)
    signing_input <> "." <> base64url(signature)
  end

  defp verify(token, secret) do
    with [encoded_header, encoded_claims, encoded_signature] <- String.split(token, ".", parts: 3),
         {:ok, header} <- decode_json(encoded_header),
         true <- header["alg"] == "HS256" || {:error, :invalid_alg},
         true <- header["typ"] == "JWT" || {:error, :invalid_type},
         {:ok, signature} <- Base.url_decode64(encoded_signature, padding: false),
         expected <- hmac(encoded_header <> "." <> encoded_claims, secret),
         true <- secure_compare(signature, expected) || {:error, :invalid_signature},
         {:ok, claims} <- decode_json(encoded_claims) do
      {:ok, claims}
    else
      {:error, reason} -> {:error, reason}
      false -> {:error, :invalid_token}
      _ -> {:error, :invalid_token}
    end
  end

  defp validate_claims(claims) do
    now = unix_now()

    cond do
      claims["iss"] != @issuer -> {:error, :invalid_issuer}
      claims["aud"] != @audience -> {:error, :invalid_audience}
      claims["type"] != @token_type -> {:error, :wrong_token_type}
      not is_binary(claims["sub"]) -> {:error, :missing_subject}
      not is_binary(claims["jti"]) -> {:error, :missing_jti}
      not is_integer(claims["exp"]) -> {:error, :missing_expiry}
      claims["exp"] < now -> {:error, :token_expired}
      true -> :ok
    end
  end

  defp consume_jti(table, %{"jti" => jti, "sub" => client_id, "exp" => exp}) do
    now = unix_now()

    case :ets.lookup(table, jti) do
      [{^jti, :unused, ^client_id, stored_exp, issued_at, epk}] when stored_exp >= now ->
        true = :ets.insert(table, {jti, :used, client_id, stored_exp, issued_at, epk})
        :ok

      [{^jti, :used, ^client_id, _stored_exp, _issued_at, _epk}] ->
        {:error, :jti_replayed}

      [{^jti, _state, _other_client_id, _stored_exp, _issued_at, _epk}] ->
        {:error, :jti_subject_mismatch}

      _other ->
        if exp < now, do: {:error, :token_expired}, else: {:error, :unknown_jti}
    end
  end

  defp cleanup_expired(table) do
    now = unix_now()

    :ets.select_delete(table, [
      {{:"$1", :"$2", :"$3", :"$4", :"$5", :"$6"}, [{:<, :"$4", now}], [true]}
    ])
  end

  defp base64_json(map), do: map |> Jason.encode!() |> base64url()
  defp base64url(data), do: Base.url_encode64(data, padding: false)

  defp decode_json(encoded) do
    with {:ok, json} <- Base.url_decode64(encoded, padding: false),
         {:ok, decoded} <- Jason.decode(json) do
      {:ok, decoded}
    else
      _ -> {:error, :invalid_token}
    end
  end

  defp hmac(data, secret), do: :crypto.mac(:hmac, :sha256, secret, data)

  defp secure_compare(left, right) when byte_size(left) == byte_size(right) do
    left
    |> :binary.bin_to_list()
    |> Enum.zip(:binary.bin_to_list(right))
    |> Enum.reduce(0, fn {a, b}, acc -> acc ||| bxor(a, b) end)
    |> Kernel.==(0)
  end

  defp secure_compare(_left, _right), do: false

  defp random_id do
    16
    |> :crypto.strong_rand_bytes()
    |> Base.url_encode64(padding: false)
  end

  defp unix_now, do: System.system_time(:second)

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
