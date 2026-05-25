defmodule LatticeServer.StaticHandler do
  @moduledoc false

  @behaviour :cowboy_handler

  @impl true
  def init(req, opts) do
    static_dir = Map.fetch!(opts, :static_dir)
    isolate? = Map.get(opts, :isolate?, false)
    path = :cowboy_req.path(req)
    file = file_for(path)

    {status, content_type, body} =
      with {:ok, file} <- file,
           true <- safe_file?(file),
           {:ok, body} <- File.read(Path.join(static_dir, file)) do
        {200, content_type(file), body}
      else
        _ -> {404, "text/plain; charset=utf-8", "not found\n"}
      end

    headers =
      %{"content-type" => content_type, "cache-control" => "no-store"}
      |> maybe_isolate(isolate?)

    req = :cowboy_req.reply(status, headers, body, req)
    {:ok, req, %{}}
  end

  # --- JS demo whitelist (unchanged) ---
  defp file_for("/"), do: {:ok, "index.html"}
  defp file_for("/index.html"), do: {:ok, "index.html"}
  defp file_for("/client.js"), do: {:ok, "client.js"}
  defp file_for("/worker-client.js"), do: {:ok, "worker-client.js"}
  defp file_for("/worker.html"), do: {:ok, "worker.html"}
  defp file_for("/styles.css"), do: {:ok, "styles.css"}
  # --- AtomVM tab whitelist (prefix-stripped; same static_dir = examples/atomvm_tab) ---
  defp file_for("/atomvm_tab"), do: {:ok, "index.html"}
  defp file_for("/atomvm_tab/"), do: {:ok, "index.html"}
  defp file_for("/atomvm_tab/index.html"), do: {:ok, "index.html"}
  defp file_for("/atomvm_tab/styles.css"), do: {:ok, "styles.css"}
  defp file_for("/atomvm_tab/shell.js"), do: {:ok, "shell.js"}

  defp file_for("/atomvm_tab/AtomVM-web-v0.7.0-alpha.1.js"),
    do: {:ok, "AtomVM-web-v0.7.0-alpha.1.js"}

  defp file_for("/atomvm_tab/AtomVM-web-v0.7.0-alpha.1.wasm"),
    do: {:ok, "AtomVM-web-v0.7.0-alpha.1.wasm"}

  defp file_for("/atomvm_tab/lattice_tab.avm"), do: {:ok, "lattice_tab.avm"}
  defp file_for("/atomvm_tab/atomvmlib.avm"), do: {:ok, "atomvmlib.avm"}
  defp file_for(_), do: {:error, :not_found}

  defp safe_file?(file), do: not String.contains?(file, "..")

  defp content_type("client.js"), do: "application/javascript; charset=utf-8"
  defp content_type("worker-client.js"), do: "application/javascript; charset=utf-8"
  defp content_type("shell.js"), do: "application/javascript; charset=utf-8"
  defp content_type("styles.css"), do: "text/css; charset=utf-8"

  defp content_type(file) do
    cond do
      String.ends_with?(file, ".wasm") -> "application/wasm"
      String.ends_with?(file, ".avm") -> "application/octet-stream"
      String.ends_with?(file, ".js") -> "application/javascript; charset=utf-8"
      String.ends_with?(file, ".html") -> "text/html; charset=utf-8"
      true -> "text/html; charset=utf-8"
    end
  end

  defp maybe_isolate(headers, false), do: headers

  defp maybe_isolate(headers, true) do
    Map.merge(headers, %{
      "cross-origin-opener-policy" => "same-origin",
      "cross-origin-embedder-policy" => "require-corp",
      "cross-origin-resource-policy" => "same-origin"
    })
  end
end
