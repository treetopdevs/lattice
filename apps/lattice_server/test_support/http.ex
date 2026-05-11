defmodule LatticeServer.TestSupport.HTTP do
  @moduledoc false

  def free_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false])
    {:ok, port} = :inet.port(socket)
    :gen_tcp.close(socket)
    port
  end

  def http_get(port, path) do
    raw_http(port, "GET", path)
  end

  def raw_http(port, method, path, headers \\ [], body \\ "") do
    {:ok, status, _head, body} = raw_http_with_head(port, method, path, headers, body)
    {:ok, status, body}
  end

  def raw_http_with_head(port, method, path, headers \\ [], body \\ "") do
    {:ok, socket} = :gen_tcp.connect(~c"localhost", port, [:binary, active: false])

    header_lines =
      headers
      |> put_content_length(byte_size(body))
      |> Enum.map(fn {key, value} -> "#{key}: #{value}\r\n" end)

    request = [
      method,
      " ",
      path,
      " HTTP/1.1\r\nhost: localhost:",
      Integer.to_string(port),
      "\r\n",
      header_lines,
      "connection: close\r\n\r\n",
      body
    ]

    :ok = :gen_tcp.send(socket, request)
    response = recv_all(socket, "")
    :gen_tcp.close(socket)

    [head, body] = String.split(response, "\r\n\r\n", parts: 2)
    ["HTTP/1.1", status | _rest] = String.split(head, " ", parts: 3)
    {:ok, String.to_integer(status), head, body}
  end

  def cookie_from_head(head, name) do
    pattern = ~r/^set-cookie:\s*([^;\r\n]+)/im

    head
    |> String.split("\r\n")
    |> Enum.find_value(fn line ->
      with [_, cookie] <- Regex.run(pattern, line),
           true <- String.starts_with?(String.downcase(cookie), "#{String.downcase(name)}=") do
        cookie
      else
        _other -> nil
      end
    end)
  end

  defp put_content_length(headers, body_size) do
    if Enum.any?(headers, fn {key, _value} ->
         String.downcase(to_string(key)) == "content-length"
       end) do
      headers
    else
      [{"content-length", Integer.to_string(body_size)} | headers]
    end
  end

  defp recv_all(socket, acc) do
    case :gen_tcp.recv(socket, 0, 2_000) do
      {:ok, chunk} -> recv_all(socket, acc <> chunk)
      {:error, :closed} -> acc
    end
  end
end
