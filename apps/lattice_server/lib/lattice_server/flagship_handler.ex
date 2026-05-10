defmodule LatticeServer.FlagshipHandler do
  @moduledoc false

  @behaviour :cowboy_handler

  @impl true
  def init(req, _opts) do
    method = :cowboy_req.method(req)
    path = :cowboy_req.path(req)
    {status, content_type, body} = route(method, path)

    req =
      :cowboy_req.reply(
        status,
        %{
          "content-type" => content_type,
          "cache-control" => "no-store",
          "access-control-allow-origin" => "*"
        },
        body,
        req
      )

    {:ok, req, %{}}
  end

  defp route("GET", "/api/flagship/snapshot") do
    json(200, Lattice.Flagship.snapshot())
  end

  defp route("GET", "/api/flagship/export/json") do
    {:ok, body} = Lattice.Flagship.export("json")
    {200, "application/json; charset=utf-8", body}
  end

  defp route("GET", "/api/flagship/export/mermaid") do
    {:ok, body} = Lattice.Flagship.export("mermaid")
    {200, "text/plain; charset=utf-8", body}
  end

  defp route("GET", "/api/flagship/export/dot") do
    {:ok, body} = Lattice.Flagship.export("dot")
    {200, "text/vnd.graphviz; charset=utf-8", body}
  end

  defp route("POST", "/api/flagship/reset"), do: action(&Lattice.Flagship.reset/0)
  defp route("POST", "/api/flagship/connect"), do: action(&Lattice.Flagship.connect/0)
  defp route("POST", "/api/flagship/grant"), do: action(&Lattice.Flagship.grant/0)
  defp route("POST", "/api/flagship/allowed"), do: action(&Lattice.Flagship.allowed/0)
  defp route("POST", "/api/flagship/over_budget"), do: action(&Lattice.Flagship.over_budget/0)
  defp route("POST", "/api/flagship/wrong_vendor"), do: action(&Lattice.Flagship.wrong_vendor/0)
  defp route("POST", "/api/flagship/stolen"), do: action(&Lattice.Flagship.stolen/0)
  defp route("POST", "/api/flagship/revoke"), do: action(&Lattice.Flagship.revoke/0)
  defp route("POST", "/api/flagship/replay"), do: action(&Lattice.Flagship.replay/0)
  defp route("POST", "/api/flagship/run_all"), do: action(&Lattice.Flagship.run_all/0)

  defp route("OPTIONS", _path), do: {204, "text/plain; charset=utf-8", ""}

  defp route(_method, _path), do: json(404, %{error: "not_found"})

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
end
