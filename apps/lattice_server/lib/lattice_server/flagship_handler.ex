defmodule LatticeServer.FlagshipHandler do
  @moduledoc false

  @behaviour :cowboy_handler

  @impl true
  def init(req, _opts) do
    method = :cowboy_req.method(req)
    path = :cowboy_req.path(req)
    {status, headers, body, set_action_cookie?} = route(method, path, req)

    req =
      if set_action_cookie? do
        :cowboy_req.set_resp_cookie(
          "lattice_flagship_token",
          Lattice.Flagship.action_token(),
          req,
          %{path: "/api/flagship", http_only: true, same_site: :strict}
        )
      else
        req
      end

    req =
      :cowboy_req.reply(
        status,
        Map.put_new(headers, "cache-control", "no-store"),
        body,
        req
      )

    {:ok, req, %{}}
  end

  defp route("GET", "/api/flagship/snapshot", _req) do
    200
    |> json(Lattice.Flagship.snapshot())
    |> with_action_cookie()
  end

  defp route("GET", "/api/flagship/export/json", _req) do
    {:ok, body} = Lattice.Flagship.export("json")
    response(200, %{"content-type" => "application/json; charset=utf-8"}, body)
  end

  defp route("GET", "/api/flagship/export/mermaid", _req) do
    {:ok, body} = Lattice.Flagship.export("mermaid")
    response(200, %{"content-type" => "text/plain; charset=utf-8"}, body)
  end

  defp route("GET", "/api/flagship/export/dot", _req) do
    {:ok, body} = Lattice.Flagship.export("dot")
    response(200, %{"content-type" => "text/vnd.graphviz; charset=utf-8"}, body)
  end

  defp route("GET", "/api/flagship/claims", _req) do
    {:ok, body} = Lattice.Flagship.export("claims")
    response(200, %{"content-type" => "application/json; charset=utf-8"}, body)
  end

  defp route("POST", "/api/flagship/" <> action_name, req) do
    cond do
      not valid_action_request?(req) ->
        json(403, %{error: "forbidden"})

      action_name in Enum.map(Lattice.Flagship.actions(), & &1.action) ->
        action(fn -> Lattice.Flagship.perform(action_name) end)

      true ->
        json(404, %{error: "not_found"})
    end
  end

  defp route("OPTIONS", _path, _req),
    do: response(204, %{"content-type" => "text/plain; charset=utf-8"}, "")

  defp route(_method, _path, _req), do: json(404, %{error: "not_found"})

  defp action(fun) do
    case fun.() do
      {:ok, snapshot} ->
        200
        |> json(snapshot)
        |> with_action_cookie()

      {:error, reason} ->
        422
        |> json(%{error: inspect(reason), snapshot: Lattice.Flagship.snapshot()})
        |> with_action_cookie()
    end
  end

  defp json(status, payload),
    do:
      response(
        status,
        %{"content-type" => "application/json; charset=utf-8"},
        Jason.encode!(payload)
      )

  defp valid_action_request?(req) do
    header_token = :cowboy_req.header("x-lattice-flagship-token", req, nil)
    cookie_token = action_cookie_token(req)

    Lattice.Flagship.valid_action_token?(header_token) ||
      Lattice.Flagship.valid_action_token?(cookie_token)
  end

  defp with_action_cookie({status, headers, body, _set_action_cookie?}) do
    {status, headers, body, true}
  end

  defp action_cookie_token(req) do
    req
    |> :cowboy_req.parse_cookies()
    |> Enum.find_value(fn
      {"lattice_flagship_token", value} -> value
      {name, value} when is_binary(name) -> if name == "lattice_flagship_token", do: value
      _ -> nil
    end)
  end

  defp response(status, headers, body), do: {status, headers, body, false}
end
