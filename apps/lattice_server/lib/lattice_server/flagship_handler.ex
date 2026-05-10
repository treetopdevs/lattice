defmodule LatticeServer.FlagshipHandler do
  @moduledoc false

  @behaviour :cowboy_handler

  @impl true
  def init(req, _opts) do
    method = :cowboy_req.method(req)
    path = :cowboy_req.path(req)
    {status, content_type, body} = route(method, path, req)

    req =
      :cowboy_req.reply(
        status,
        %{
          "content-type" => content_type,
          "cache-control" => "no-store"
        },
        body,
        req
      )

    {:ok, req, %{}}
  end

  defp route("GET", "/api/flagship/snapshot", _req) do
    json(200, Lattice.Flagship.snapshot())
  end

  defp route("GET", "/api/flagship/export/json", _req) do
    {:ok, body} = Lattice.Flagship.export("json")
    {200, "application/json; charset=utf-8", body}
  end

  defp route("GET", "/api/flagship/export/mermaid", _req) do
    {:ok, body} = Lattice.Flagship.export("mermaid")
    {200, "text/plain; charset=utf-8", body}
  end

  defp route("GET", "/api/flagship/export/dot", _req) do
    {:ok, body} = Lattice.Flagship.export("dot")
    {200, "text/vnd.graphviz; charset=utf-8", body}
  end

  defp route("GET", "/api/flagship/claims", _req) do
    {:ok, body} = Lattice.Flagship.export("claims")
    {200, "application/json; charset=utf-8", body}
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

  defp route("OPTIONS", _path, _req), do: {204, "text/plain; charset=utf-8", ""}

  defp route(_method, _path, _req), do: json(404, %{error: "not_found"})

  defp action(fun) do
    case fun.() do
      {:ok, snapshot} ->
        json(200, snapshot)

      {:error, reason} ->
        json(422, %{error: inspect(reason), snapshot: Lattice.Flagship.snapshot()})
    end
  end

  defp json(status, payload),
    do: {status, "application/json; charset=utf-8", Jason.encode!(payload)}

  defp valid_action_request?(req) do
    "x-lattice-flagship-token"
    |> :cowboy_req.header(req, nil)
    |> Lattice.Flagship.valid_action_token?()
  end
end
