defmodule LatticeServer.FederatedWorkersHandler do
  @moduledoc false

  @behaviour :cowboy_handler

  @max_body_bytes 1_024

  @impl true
  def init(req, _opts) do
    method = :cowboy_req.method(req)
    path = :cowboy_req.path(req)
    {status, headers, body, req} = route(method, path, req)

    req =
      :cowboy_req.reply(
        status,
        Map.put_new(headers, "cache-control", "no-store"),
        body,
        req
      )

    {:ok, req, %{}}
  end

  defp route("POST", "/api/federated-workers/run", req) do
    with true <- allowed_demo_request?(req),
         {:ok, body, req} <- read_body(req),
         {:ok, %{"from_tab_id" => from_tab_id, "to_tab_id" => to_tab_id}} <- Jason.decode(body),
         :ok <- validate_tab_id(from_tab_id),
         :ok <- validate_tab_id(to_tab_id) do
      case Lattice.Demo.FederatedWorkers.run_demo(from_tab_id, to_tab_id) do
        %{mode: :browser_worker} = result -> json(200, encode_result(result), req)
        {:error, reason} -> json(422, %{error: format_reason(reason)}, req)
      end
    else
      false -> json(403, %{error: "forbidden"}, req)
      {:more, _body, req} -> json(413, %{error: "request_body_too_large"}, req)
      {:error, %Jason.DecodeError{}} -> json(400, %{error: "invalid_json"}, req)
      {:error, reason} -> json(422, %{error: format_reason(reason)}, req)
      _other -> json(400, %{error: "invalid_request"}, req)
    end
  end

  defp route("OPTIONS", _path, req),
    do: {204, %{"content-type" => "text/plain; charset=utf-8"}, "", req}

  defp route(_method, _path, req), do: json(404, %{error: "not_found"}, req)

  defp read_body(req) do
    :cowboy_req.read_body(req, %{length: @max_body_bytes, period: 1_000})
  end

  defp validate_tab_id(tab_id) when is_binary(tab_id) do
    if String.match?(tab_id, ~r/^[A-Za-z0-9_-]+$/) do
      :ok
    else
      {:error, :invalid_tab_id}
    end
  end

  defp validate_tab_id(_tab_id), do: {:error, :invalid_tab_id}

  defp encode_result(result) do
    %{
      mode: result.mode,
      from_worker_tab_id: result.from_worker_tab_id,
      to_worker_tab_id: result.to_worker_tab_id,
      denied_direct: encode_outcome(result.denied_direct),
      bridged: encode_outcome(result.bridged),
      direct_cap_id: result.direct_cap_id,
      bridge_cap_id: result.bridge_cap_id
    }
  end

  defp encode_outcome({:ok, result}), do: %{ok: true, result: result}
  defp encode_outcome({:error, reason}), do: %{ok: false, error: format_reason(reason)}

  defp format_reason(reason) when is_atom(reason), do: Atom.to_string(reason)
  defp format_reason(reason), do: inspect(reason)

  defp json(status, payload, req) do
    {status, %{"content-type" => "application/json; charset=utf-8"}, Jason.encode!(payload), req}
  end

  defp allowed_demo_request?(req) do
    loopback_peer?(req) and allowed_origin?(req)
  end

  defp allowed_origin?(req) do
    case :cowboy_req.header("origin", req, nil) do
      nil -> true
      "" -> true
      origin -> same_loopback_origin?(origin, request_origin(req))
    end
  end

  defp same_loopback_origin?(origin, request_origin) do
    with %URI{scheme: scheme, host: host, port: port} when scheme in ["http", "https"] <-
           URI.parse(origin),
         %URI{scheme: req_scheme, host: req_host, port: req_port} <- request_origin,
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

  defp loopback_peer?(req), do: peer_ip(req) in ["127.0.0.1", "::1"]
  defp loopback_host?(host) when host in ["127.0.0.1", "::1", "localhost"], do: true
  defp loopback_host?(_host), do: false

  defp peer_ip(req) do
    case :cowboy_req.peer(req) do
      {ip, _port} -> ip |> :inet.ntoa() |> to_string()
      _other -> "unknown"
    end
  end
end
