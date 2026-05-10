defmodule LatticeServer.FlagshipHttpTest do
  use ExUnit.Case, async: false

  setup do
    Lattice.Flagship.reset()
    listener = :"lattice_flagship_http_test_#{System.unique_integer([:positive])}"
    port = free_port()

    {:ok, _pid} =
      LatticeServer.start_http(
        listener: listener,
        port: port,
        static_dir: Path.expand("../../../examples/flagship_demo", __DIR__),
        auto_story?: false,
        grant_targets: %{}
      )

    on_exit(fn -> LatticeServer.stop_http(listener) end)

    {:ok, port: port}
  end

  test "flagship HTTP API serves UI, runs story, and exports graph", %{port: port} do
    assert {:ok, 200, html} = http_get(port, "/")
    assert html =~ "Live process/trust graph inspector"

    assert {:ok, 403, forbidden} = raw_http(port, "POST", "/api/flagship/run_all")
    assert %{"error" => "forbidden"} = Jason.decode!(forbidden)

    assert {:ok, snapshot} = post_json(port, "/api/flagship/run_all")
    assert snapshot["wallet"]["delivery_count"] == 1
    assert snapshot["presenter"]["next_action"] =~ "inspect"
    assert snapshot["results"]["over_budget"]["delivered_to_wallet?"] == false
    assert snapshot["results"]["stolen"]["result"]["error"] == ":wrong_owner"
    assert snapshot["results"]["replay"]["result"]["error"] == ":revoked"

    assert {:ok, 200, mermaid} = http_get(port, "/api/flagship/export/mermaid")
    assert mermaid =~ "graph TD"

    assert {:ok, 200, claims} = http_get(port, "/api/flagship/claims")
    assert [%{"id" => "capability_wallet_edge"} | _] = Jason.decode!(claims)

    assert {:ok, 200, head, _body} = raw_http_with_head(port, "GET", "/api/flagship/snapshot")
    refute String.downcase(head) =~ "access-control-allow-origin"
  end

  defp http_get(port, path) do
    raw_http(port, "GET", path)
  end

  defp post_json(port, path) do
    with {:ok, token} <- action_token(port),
         {:ok, status, body} when status in 200..299 <-
           raw_http(port, "POST", path, [{"x-lattice-flagship-token", token}]) do
      {:ok, Jason.decode!(body)}
    end
  end

  defp raw_http(port, method, path, headers \\ []) do
    {:ok, status, _head, body} = raw_http_with_head(port, method, path, headers)
    {:ok, status, body}
  end

  defp raw_http_with_head(port, method, path, headers \\ []) do
    {:ok, socket} = :gen_tcp.connect(~c"localhost", port, [:binary, active: false])

    header_lines = Enum.map(headers, fn {key, value} -> "#{key}: #{value}\r\n" end)

    request = [
      method,
      " ",
      path,
      " HTTP/1.1\r\nhost: localhost\r\n",
      header_lines,
      "connection: close\r\ncontent-length: 0\r\n\r\n"
    ]

    :ok = :gen_tcp.send(socket, request)
    response = recv_all(socket, "")
    :gen_tcp.close(socket)

    [head, body] = String.split(response, "\r\n\r\n", parts: 2)
    ["HTTP/1.1", status | _rest] = String.split(head, " ", parts: 3)
    {:ok, String.to_integer(status), head, body}
  end

  defp action_token(port) do
    with {:ok, 200, body} <- http_get(port, "/api/flagship/snapshot"),
         %{"action_token" => token} <- Jason.decode!(body) do
      {:ok, token}
    end
  end

  defp recv_all(socket, acc) do
    case :gen_tcp.recv(socket, 0, 2_000) do
      {:ok, chunk} -> recv_all(socket, acc <> chunk)
      {:error, :closed} -> acc
    end
  end

  defp free_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false])
    {:ok, port} = :inet.port(socket)
    :gen_tcp.close(socket)
    port
  end
end
