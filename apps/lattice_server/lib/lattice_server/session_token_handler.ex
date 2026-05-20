defmodule LatticeServer.SessionTokenHandler do
  @moduledoc false

  @behaviour :cowboy_handler

  @impl true
  def init(req, opts) do
    method = :cowboy_req.method(req)
    format = Map.get(opts, :format, :json)
    {status, headers, body} = route(method, req, format)

    req =
      :cowboy_req.reply(
        status,
        Map.put_new(headers, "cache-control", "no-store"),
        body,
        req
      )

    {:ok, req, %{}}
  end

  defp route("GET", req, format) do
    params = req |> :cowboy_req.parse_qs() |> Map.new()
    client_id = clean_client_id(params["client_id"]) || "client_" <> Lattice.Realm.random_id(18)
    epk = clean_optional(params["epk"])

    {:ok, token, claims} = LatticeServer.ResumeToken.issue(client_id, epk: epk)

    case format do
      :text ->
        {200, %{"content-type" => "text/plain; charset=utf-8"}, token}

      _ ->
        body =
          Jason.encode!(%{
            token: token,
            client_id: client_id,
            exp: claims["exp"]
          })

        {200, %{"content-type" => "application/json; charset=utf-8"}, body}
    end
  end

  defp route(_method, _req, _format) do
    {404, %{"content-type" => "application/json; charset=utf-8"},
     Jason.encode!(%{error: "not_found"})}
  end

  defp clean_client_id(value) when is_binary(value) do
    value = String.trim(value)

    cond do
      byte_size(value) < 8 -> nil
      byte_size(value) > 128 -> nil
      String.match?(value, ~r/^[A-Za-z0-9_.:-]+$/) -> value
      true -> nil
    end
  end

  defp clean_client_id(_value), do: nil

  defp clean_optional(value) when is_binary(value) and byte_size(value) <= 512, do: value
  defp clean_optional(_value), do: nil
end
