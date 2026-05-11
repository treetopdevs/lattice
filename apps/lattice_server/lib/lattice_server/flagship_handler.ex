defmodule LatticeServer.FlagshipHandler do
  @moduledoc false

  @behaviour :cowboy_handler

  @max_action_body_bytes 1_024
  @snapshot_rate_limit 90
  @action_rate_limit 30
  @rate_window_ms 10_000

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

  defp route("GET", "/api/flagship/snapshot", req) do
    if rate_allowed?(req, "GET", "snapshot", @snapshot_rate_limit) do
      200
      |> json(Lattice.Flagship.snapshot())
      |> with_action_cookie()
    else
      json(429, %{error: "rate_limited"})
    end
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
      action_name not in Enum.map(Lattice.Flagship.actions(), & &1.action) ->
        json(404, %{error: "not_found"})

      not allowed_origin?(req) ->
        json(403, %{error: "forbidden"})

      not action_body_within_limit?(req) ->
        json(413, %{error: "request_body_too_large"})

      not rate_allowed?(req, "POST", action_name, @action_rate_limit) ->
        json(429, %{error: "rate_limited"})

      not valid_action_request?(req) ->
        json(403, %{error: "forbidden"})

      true ->
        action(fn -> Lattice.Flagship.perform(action_name) end)
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

    Lattice.Flagship.consume_action_token?(header_token) ||
      Lattice.Flagship.consume_action_token?(cookie_token)
  end

  defp allowed_origin?(req) do
    case :cowboy_req.header("origin", req, nil) do
      nil -> loopback_request?(req)
      "" -> loopback_request?(req)
      origin -> loopback_peer?(req) and same_loopback_origin?(origin, request_origin(req))
    end
  end

  defp loopback_request?(req) do
    with true <- loopback_peer?(req),
         %URI{host: host} <- request_origin(req) do
      loopback_host?(host)
    else
      _other -> false
    end
  end

  defp same_loopback_origin?(origin, request_origin) do
    with %URI{scheme: scheme, host: host, port: port} when scheme in ["http", "https"] <-
           URI.parse(origin),
         %URI{scheme: req_scheme, host: req_host, port: req_port} <-
           request_origin,
         true <- loopback_host?(host),
         true <- loopback_host?(req_host) do
      scheme == req_scheme and host == req_host and port == req_port
    else
      _other -> false
    end
  end

  defp request_origin(req) do
    host = :cowboy_req.header("host", req, "")
    scheme = req |> :cowboy_req.scheme() |> to_string()
    URI.parse("#{scheme}://#{host}")
  end

  defp loopback_host?(host) when host in ["127.0.0.1", "::1", "localhost"], do: true
  defp loopback_host?(_host), do: false

  defp loopback_peer?(req), do: peer_ip(req) in ["127.0.0.1", "::1"]

  defp action_body_within_limit?(req) do
    content_length = :cowboy_req.header("content-length", req, "0")
    transfer_encoding = :cowboy_req.header("transfer-encoding", req, nil)

    transfer_encoding in [nil, "identity"] and
      case Integer.parse(content_length) do
        {bytes, ""} -> bytes <= @max_action_body_bytes
        _other -> false
      end
  end

  defp rate_allowed?(req, method, route, limit) do
    key = {:flagship, method, route, peer_ip(req)}
    LatticeServer.RateLimiter.allow?(key, limit: limit, window_ms: @rate_window_ms)
  end

  defp peer_ip(req) do
    case :cowboy_req.peer(req) do
      {ip, _port} -> ip |> :inet.ntoa() |> to_string()
      _other -> "unknown"
    end
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
