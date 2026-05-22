defmodule LatticeServer.StaticHandler do
  @moduledoc false

  @behaviour :cowboy_handler

  @impl true
  def init(req, %{static_dir: static_dir}) do
    path = :cowboy_req.path(req)
    file = file_for(path)

    response =
      with {:ok, file} <- file,
           true <- safe_file?(file),
           {:ok, body} <- File.read(Path.join(static_dir, file)) do
        {200, content_type(file), body}
      else
        _ -> {404, "text/plain; charset=utf-8", "not found\n"}
      end

    {status, content_type, body} = response

    req =
      :cowboy_req.reply(
        status,
        %{"content-type" => content_type, "cache-control" => "no-store"},
        body,
        req
      )

    {:ok, req, %{}}
  end

  defp file_for("/"), do: {:ok, "index.html"}
  defp file_for("/index.html"), do: {:ok, "index.html"}
  defp file_for("/client.js"), do: {:ok, "client.js"}
  defp file_for("/worker-client.js"), do: {:ok, "worker-client.js"}
  defp file_for("/worker.html"), do: {:ok, "worker.html"}
  defp file_for("/styles.css"), do: {:ok, "styles.css"}
  defp file_for(_), do: {:error, :not_found}

  defp safe_file?(file), do: not String.contains?(file, "..")
  defp content_type("client.js"), do: "application/javascript; charset=utf-8"
  defp content_type("worker-client.js"), do: "application/javascript; charset=utf-8"
  defp content_type("styles.css"), do: "text/css; charset=utf-8"
  defp content_type(_), do: "text/html; charset=utf-8"
end
